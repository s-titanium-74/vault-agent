import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  Config,
  EmbeddingProvider,
  IndexStore,
  getIndexPath,
  indexVault,
  VaultWatcher,
  GitSync,
  FreshnessMachine,
  incrementalIndexUpdate,
} from "@vault-agent/core";
import {
  PrepareServerAccessOptions,
  StartupIndexState,
  prepareServerAccessConfig,
  validateServerAccessConfig,
  validateStartupIndexState,
} from "./access.js";
import { constantTimeEqual, err } from "./http-utils.js";
import { registerHealthRoute } from "./routes/health.js";
import { registerIndexRoutes } from "./routes/indexing.js";
import { registerRetrievalRoutes } from "./routes/retrieval.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerStatusRoute } from "./routes/status.js";
import { registerSyncRoutes } from "./routes/sync.js";
import { initApp, resetApp } from "./state.js";
import { createMcpServer, McpAdapterContext } from "./mcp/adapter.js";
import { registerMcpStreamableHttpRoute } from "./mcp/streamable-http.js";

export {
  initApp,
  resetApp,
  prepareServerAccessConfig,
  validateStartupIndexState,
};
export type { PrepareServerAccessOptions, StartupIndexState };
export { createMcpServer } from "./mcp/adapter.js";
export type { McpAdapterContext } from "./mcp/adapter.js";

export async function createServer(
  appConfig: Config,
  mcpContext?: McpAdapterContext,
): Promise<ReturnType<typeof Fastify>> {
  validateServerAccessConfig(appConfig);

  if (appConfig.cors.enabled) {
    if (appConfig.cors.allowedOrigins.length === 0) {
      throw new Error("CORS is enabled but no allowed origins are configured.");
    }
    if (appConfig.cors.allowedOrigins.includes("*")) {
      throw new Error("CORS wildcard origin '*' is not allowed.");
    }
  }

  const app = Fastify({
    logger: {
      level: appConfig.server.logLevel,
    },
    bodyLimit: 64 * 1024,
  });

  if (appConfig.cors.enabled && appConfig.cors.allowedOrigins.length > 0) {
    await app.register(cors, {
      origin: appConfig.cors.allowedOrigins,
      credentials: false,
    });
  }

  app.addHook("onRequest", async (request) => {
    request.id = crypto.randomUUID();
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!appConfig.server.apiKey) return;
    if (
      request.url === "/sync/webhook" ||
      request.url.startsWith("/sync/webhook?")
    ) {
      return;
    }
    if (
      appConfig.mcp.enabled &&
      (request.url === appConfig.mcp.http.endpoint ||
        request.url.startsWith(`${appConfig.mcp.http.endpoint}?`))
    ) {
      return;
    }

    const auth = request.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) {
      reply
        .code(401)
        .send(
          err("UNAUTHORIZED", "Missing or invalid authentication.", request.id),
        );
      return;
    }

    const token = auth.slice(7);
    const expected = appConfig.server.apiKey;
    if (!constantTimeEqual(token, expected)) {
      reply
        .code(401)
        .send(
          err("UNAUTHORIZED", "Missing or invalid authentication.", request.id),
        );
    }
  });

  registerHealthRoute(app);
  registerIndexRoutes(app, appConfig);
  registerSearchRoutes(app, appConfig);
  registerRetrievalRoutes(app);
  registerStatusRoute(app);
  registerSyncRoutes(app);

  if (appConfig.mcp.enabled && mcpContext) {
    registerMcpStreamableHttpRoute(app, {
      endpoint: appConfig.mcp.http.endpoint,
      createMcpServer: () => createMcpServer(mcpContext),
      apiKey: appConfig.server.apiKey,
    });
  }

  return app;
}

export async function startServer(
  appConfig: Config,
  options: PrepareServerAccessOptions = {},
): Promise<void> {
  const preparedConfig = prepareServerAccessConfig(appConfig, options);

  const dbPath = getIndexPath(preparedConfig);
  const dir = path.dirname(dbPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let appStore = await IndexStore.open(dbPath);

  const startupIndexState = validateStartupIndexState(appStore, preparedConfig);
  if (startupIndexState.shouldBootstrap) {
    console.log(
      "No usable index found. Performing first-run bootstrap indexing...",
    );
    const result = await indexVault(preparedConfig);
    console.log(
      `Bootstrap indexing complete: ${result.notesIndexed} notes, ${result.chunksIndexed} chunks indexed.`,
    );
    if (result.warnings.length > 0) {
      console.warn(`Warnings during indexing: ${result.warnings.length}`);
    }

    appStore.close();
    appStore = await IndexStore.open(dbPath);
  }

  if (startupIndexState.warnings.length > 0) {
    for (const warning of startupIndexState.warnings) {
      console.warn(`${warning.code}: ${warning.message}`);
    }
  }

  const freshnessMachine = new FreshnessMachine();

  const staleness = appStore.checkStaleness(preparedConfig);
  if (staleness.incompatible) {
    freshnessMachine.markReindexRequired([staleness.details]);
  } else if (staleness.stale) {
    freshnessMachine.markStale(staleness.details);
  } else {
    freshnessMachine.transition("fresh", "Startup check passed");
  }

  const mcpEmbeddingProvider: EmbeddingProvider | null =
    preparedConfig.embedding.enabled && preparedConfig.embedding.model
      ? new EmbeddingProvider(preparedConfig)
      : null;

  const app = await createServer(preparedConfig, {
    store: appStore,
    config: preparedConfig,
    embeddingProvider: mcpEmbeddingProvider,
    freshnessMachine,
  });

  let watcher: VaultWatcher | null = null;
  if (preparedConfig.watch.enabled) {
    watcher = new VaultWatcher(
      preparedConfig.vault.root,
      preparedConfig.vault.exclude,
      {
        debounceMs: preparedConfig.watch.debounce_ms,
        maxBatchDelayMs: preparedConfig.watch.max_batch_delay_ms,
        ignoreInitial: preparedConfig.watch.ignore_initial,
      },
    );

    watcher.setUpdateCallback(async (paths: string[]) => {
      freshnessMachine.changesDetected(paths.length);
      try {
        freshnessMachine.writerStarted();
        await incrementalIndexUpdate(appStore, preparedConfig, { paths });
        freshnessMachine.writerSucceeded();
      } catch (updateErr) {
        freshnessMachine.writerFailed((updateErr as Error).message);
        console.error(
          `Incremental index update failed: ${(updateErr as Error).message}`,
        );
      }
    });

    await watcher.start();
    console.log(`Watcher started for vault: ${preparedConfig.vault.root}`);
  }

  let gitSync: GitSync | null = null;
  if (preparedConfig.sync.repo) {
    gitSync = new GitSync(preparedConfig);
    gitSync.setVaultRoot(preparedConfig.vault.root);

    gitSync.setOnSyncComplete((changed: boolean) => {
      if (changed && watcher) {
        console.log(
          "Git sync completed, triggering re-index of changed files...",
        );
        freshnessMachine.changesDetected();
      }
    });

    if (preparedConfig.sync.enabled) {
      gitSync.startScheduledSync();
      console.log(
        `Scheduled sync enabled: every ${preparedConfig.sync.interval_seconds} seconds`,
      );
    }
  }

  initApp(
    appStore,
    preparedConfig,
    watcher ?? undefined,
    gitSync ?? undefined,
    freshnessMachine,
  );

  try {
    await app.listen({
      host: preparedConfig.server.host,
      port: preparedConfig.server.port,
    });
    console.log(
      `Server listening on ${preparedConfig.server.host}:${preparedConfig.server.port}`,
    );
  } catch (err) {
    console.error("Failed to start server:", err);
    process.exit(1);
  }
}

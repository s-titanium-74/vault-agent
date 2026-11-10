import { authorizeBearer, requiredHttpRole } from "@vault-agent/core/access";
import { SourceError, MutationError } from "@vault-agent/core/portable";
import { LocalMutationError } from "@vault-agent/core/local";
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
  localAccessCredentials,
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
import { registerOrientationRoutes } from "./routes/orientation.js";
import { registerGuidanceRoutes } from "./routes/guidance.js";
import { registerLinkGraphRoutes } from "./routes/link-graph.js";
import { registerProfileRoutes } from "./routes/profiles.js";
import { getAppState, initApp, resetApp } from "./state.js";
import { createMcpServer, McpAdapterContext } from "./mcp/adapter.js";
import { registerMcpStreamableHttpRoute } from "./mcp/streamable-http.js";
import { LocalMutationRuntime } from "./mcp/mutations.js";

declare module "fastify" {
  interface FastifyInstance {
    vaultMutations: LocalMutationRuntime | null;
  }
}

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
  const mutations = appConfig.write?.enabled
    ? new LocalMutationRuntime(appConfig, mcpContext?.freshnessMachine ?? null)
    : null;
  app.decorate("vaultMutations", mutations);
  if (mutations)
    app.addHook("onClose", async () => {
      await mutations.close();
    });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof LocalMutationError || error instanceof MutationError) {
      const status =
        error.code === "REVISION_CHANGED" ||
        error.code === "SOURCE_REVISION_MISMATCH"
          ? 409
          : [
                "NOTE_TOO_LARGE",
                "ATTACHMENT_TOO_LARGE",
                "SIZE_LIMIT_EXCEEDED",
              ].includes(error.code)
            ? 413
            : error.code === "SOURCE_EXCLUDED" || error.code === "INVALID_PATH"
              ? 403
              : 503;
      return reply
        .code(status)
        .send(err(error.code, "Source operation failed.", request.id));
    }
    if (error instanceof SourceError)
      return reply
        .code(
          error.code === "SOURCE_REVISION_MISMATCH"
            ? 409
            : error.code === "SOURCE_TOO_LARGE"
              ? 413
              : error.code === "SOURCE_EXCLUDED"
                ? 403
                : error.code === "INVALID_PATH"
                  ? 400
                  : 503,
        )
        .send(err(error.code, "Source operation failed.", request.id));
    if (appConfig.write?.enabled)
      return reply
        .code(
          error &&
            typeof error === "object" &&
            "statusCode" in error &&
            typeof error.statusCode === "number" &&
            error.statusCode >= 400 &&
            error.statusCode <= 599
            ? error.statusCode
            : 500,
        )
        .send(err("INTERNAL_ERROR", "Request failed.", request.id));
    return reply.send(error);
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
    const pathname =
      request.routeOptions.url ??
      new URL(request.url, "http://localhost").pathname;
    if (pathname === "/sync/webhook" && request.method === "POST") return;
    if (
      appConfig.mcp.enabled &&
      mcpContext &&
      ["GET", "POST", "DELETE"].includes(request.method) &&
      pathname === appConfig.mcp.http.endpoint
    )
      return;
    const credentials = localAccessCredentials(appConfig.server);
    if (appConfig.write?.enabled && !credentials)
      return reply
        .code(401)
        .send(err("AUTH_REQUIRED", "Access denied.", request.id));
    if (!credentials) return;
    const failure = await authorizeBearer(
      request.headers.authorization,
      credentials,
      requiredHttpRole(pathname, request.method),
      constantTimeEqual,
    );
    if (failure) {
      reply
        .code(failure === "AUTH_REQUIRED" ? 401 : 403)
        .send(err(failure, "Access denied.", request.id));
    }
  });

  registerHealthRoute(app);
  registerIndexRoutes(app, appConfig);
  registerSearchRoutes(app, appConfig);
  registerRetrievalRoutes(app);
  registerStatusRoute(app);
  registerSyncRoutes(app);
  registerOrientationRoutes(app);
  registerGuidanceRoutes(app);
  registerLinkGraphRoutes(app);
  registerProfileRoutes(app);

  if (appConfig.mcp.enabled && mcpContext) {
    registerMcpStreamableHttpRoute(app, {
      endpoint: appConfig.mcp.http.endpoint,
      createMcpServer: () =>
        createMcpServer({ ...mcpContext, config: appConfig, mutations }),
      apiKey: appConfig.server.apiKey,
      credentials: () => localAccessCredentials(appConfig.server) ?? undefined,
      writesEnabled: !!appConfig.write?.enabled,
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
  if (preparedConfig.watch.enabled && !preparedConfig.vault.pcloud) {
    watcher = new VaultWatcher(
      preparedConfig.vault.root,
      preparedConfig.vault.exclude,
      {
        debounceMs: preparedConfig.watch.debounce_ms,
        maxBatchDelayMs: preparedConfig.watch.max_batch_delay_ms,
        ignoreInitial: preparedConfig.watch.ignore_initial,
      },
    );

    let watchedUpdates = Promise.resolve();
    watcher.setUpdateCallback((paths: string[]) => {
      freshnessMachine.changesDetected(paths.length);
      watchedUpdates = watchedUpdates.then(async () => {
        const currentStore = getAppState().store;
        if (!currentStore) return;
        try {
          freshnessMachine.writerStarted();
          await incrementalIndexUpdate(currentStore, preparedConfig, { paths });
          freshnessMachine.writerSucceeded();
        } catch (updateErr) {
          freshnessMachine.writerFailed((updateErr as Error).message);
          console.error(
            `Incremental index update failed: ${(updateErr as Error).message}`,
          );
        }
      });
    });

    await watcher.start();
    console.log(`Watcher started for vault: ${preparedConfig.vault.root}`);
  }

  let gitSync: GitSync | null = null;
  if (preparedConfig.sync.repo && !preparedConfig.vault.pcloud) {
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

  if (preparedConfig.vault.pcloud && preparedConfig.watch.enabled) {
    let running = false;
    const timer = setInterval(async () => {
      if (running) return;
      running = true;
      try {
        freshnessMachine.writerStarted();
        await indexVault(preparedConfig);
        freshnessMachine.writerSucceeded();
      } catch {
        freshnessMachine.writerFailed("SOURCE_UNAVAILABLE");
      } finally {
        running = false;
      }
    }, preparedConfig.vault.pcloud.poll_seconds * 1000);
    timer.unref();
    app.addHook("onClose", async () => {
      clearInterval(timer);
    });
  }

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

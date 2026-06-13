import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import {
  Config,
  IndexStore,
  getIndexPath,
  indexVault,
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
import { initApp, resetApp } from "./state.js";

export {
  initApp,
  resetApp,
  prepareServerAccessConfig,
  validateStartupIndexState,
};
export type { PrepareServerAccessOptions, StartupIndexState };

export async function createServer(
  appConfig: Config,
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

  return app;
}

export async function startServer(
  appConfig: Config,
  options: PrepareServerAccessOptions = {},
): Promise<void> {
  const preparedConfig = prepareServerAccessConfig(appConfig, options);
  const app = await createServer(preparedConfig);

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

  initApp(appStore, preparedConfig);

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

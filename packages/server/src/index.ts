import crypto from "node:crypto";
import path from "node:path";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { z } from "zod";
import {
  Config,
  ConfigManager,
  IndexStore,
  getIndexPath,
  defaultConfigPath,
  validateVaultPath,
  resolveVaultRelativePath,
  searchRequestSchema,
  relatedRequestSchema,
  indexVault,
  reindexVault,
  search,
  getRelated,
  getNote,
  getChunk,
  getAttachmentMetadata,
  getAttachmentBytes,
  IndexError,
  SearchError,
  RetrievalSizeError,
  PathSafetyError,
  InvalidPathError,
  VaultDiscovery,
  EmbeddingProvider,
} from "@vault-agent/core";

const indexRequestSchema = z
  .object({
    requireEmbeddings: z.boolean().optional(),
  })
  .strict();

const reindexRequestSchema = z
  .object({
    requireEmbeddings: z.boolean().optional(),
  })
  .strict();

let store: IndexStore | null = null;
let config: Config | null = null;
let embeddingProvider: EmbeddingProvider | null = null;

export function initApp(appStore: IndexStore, appConfig: Config): void {
  store = appStore;
  config = appConfig;
  if (appConfig.embedding.enabled && appConfig.embedding.model) {
    embeddingProvider = new EmbeddingProvider(appConfig);
  } else {
    embeddingProvider = null;
  }
}

export function resetApp(): void {
  store = null;
  config = null;
  embeddingProvider = null;
}

const NOTE_ID_REGEX = /^[0-9a-f]{32}$/;

function err(code: string, message: string, requestId: string) {
  return {
    error: {
      code,
      message,
      details: { requestId },
    },
  };
}

function validationErrorCode(error: z.ZodError, fallbackCode: string): string {
  const fields = new Set(error.issues.map((issue) => String(issue.path[0])));
  if (fields.has("limit")) return "INVALID_LIMIT";
  if (fields.has("mode")) return "INVALID_MODE";
  return fallbackCode;
}

function indexErrorStatus(error: IndexError): number | null {
  if (error.code === "INDEX_BUSY") return 409;
  if (error.code === "EMBEDDING_CONFIG_INVALID") return 400;
  if (
    error.code === "EMBEDDING_FAILED" ||
    error.code === "EMBEDDING_UNAVAILABLE"
  ) {
    return 503;
  }
  return null;
}

export interface PrepareServerAccessOptions {
  configPath?: string;
  defaultConfigPathOverride?: string;
}

export interface StartupIndexState {
  usable: boolean;
  warnings: Array<{
    code: string;
    message: string;
  }>;
}

export function prepareServerAccessConfig(
  appConfig: Config,
  options: PrepareServerAccessOptions = {},
): Config {
  const prepared = structuredClone(appConfig);
  const isLocalhost = isLocalhostHost(prepared.server.host);
  if (isLocalhost) return prepared;

  if (prepared.server.apiKey) {
    validateRemoteApiKey(prepared.server.apiKey);
    return prepared;
  }

  const resolvedDefaultConfigPath =
    options.defaultConfigPathOverride ?? defaultConfigPath();
  if (
    options.configPath &&
    path.resolve(options.configPath) !== path.resolve(resolvedDefaultConfigPath)
  ) {
    throw new Error(
      "API_KEY_REQUIRED: Non-localhost bind requires a configured API key when using a custom config path.",
    );
  }

  const generatedKey = crypto.randomBytes(32).toString("base64url");
  const manager = new ConfigManager(resolvedDefaultConfigPath);
  manager.set("server.apiKey", generatedKey);
  prepared.server.apiKey = generatedKey;
  return prepared;
}

function validateServerAccessConfig(appConfig: Config): void {
  if (isLocalhostHost(appConfig.server.host)) return;
  if (!appConfig.server.apiKey) {
    throw new Error(
      "API_KEY_REQUIRED: Non-localhost bind requires an API key.",
    );
  }
  validateRemoteApiKey(appConfig.server.apiKey);
}

function validateRemoteApiKey(apiKey: string): void {
  if (apiKey.length < 32) {
    throw new Error(
      "API_KEY_REQUIRED: Non-localhost bind requires an API key of at least 32 characters.",
    );
  }
}

function isLocalhostHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

export function validateStartupIndexState(
  appStore: IndexStore,
  appConfig: Config,
): StartupIndexState {
  const manifest = appStore.getManifest();
  if (!manifest) {
    return { usable: false, warnings: [] };
  }

  const staleness = appStore.checkStaleness(appConfig);
  if (staleness.incompatible) {
    throw new Error(
      `INDEX_INCOMPATIBLE: Existing index is incompatible. Run vault-agent reindex. ${staleness.details}`,
    );
  }

  if (staleness.stale) {
    return {
      usable: true,
      warnings: [
        {
          code: "INDEX_STALE",
          message: `${staleness.details}. Run vault-agent index or vault-agent reindex to refresh the index.`,
        },
      ],
    };
  }

  return { usable: true, warnings: [] };
}

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

  app.get("/health", async () => {
    const manifest = store?.getManifest() ?? null;
    let stale = false;
    if (manifest && config) {
      try {
        const staleness = store!.checkStaleness(config!);
        stale = staleness.stale;
      } catch {
        stale = true;
      }
    }
    return {
      data: {
        status: manifest ? (stale ? "degraded" : "ok") : "degraded",
        version: "0.1.0",
        index: manifest
          ? {
              available: true,
              stale,
              embeddingAvailable: manifest.embeddingModel !== null,
            }
          : {
              available: false,
              stale: false,
              embeddingAvailable: false,
            },
      },
      warnings: [],
    };
  });

  app.post("/index", async (request, reply) => {
    if (!store) {
      return reply
        .code(409)
        .send(
          err(
            "INDEX_NOT_FOUND",
            "No usable index. Start the server to build an initial index.",
            request.id,
          ),
        );
    }

    const bodyParse = indexRequestSchema.safeParse(request.body ?? {});
    if (!bodyParse.success) {
      return reply
        .code(400)
        .send(
          err(
            "INVALID_REQUEST",
            bodyParse.error.issues.map((i) => i.message).join(", "),
            request.id,
          ),
        );
    }

    const requireEmbeddings = bodyParse.data.requireEmbeddings === true;

    try {
      const result = await indexVault(appConfig, { requireEmbeddings });

      return {
        data: {
          mode: result.mode,
          notesIndexed: result.notesIndexed,
          chunksIndexed: result.chunksIndexed,
          notesSkipped: result.notesSkipped,
          warningCount: result.warnings.length,
        },
        warnings: result.warnings.slice(0, 100),
      };
    } catch (error) {
      if (error instanceof IndexError) {
        const status = indexErrorStatus(error);
        if (status === null) throw error;
        return reply
          .code(status)
          .send(err(error.code, error.message, request.id));
      }
      throw error;
    }
  });

  app.post("/reindex", async (request, reply) => {
    if (!store) {
      return reply
        .code(409)
        .send(
          err(
            "INDEX_NOT_FOUND",
            "No usable index. Start the server to build an initial index.",
            request.id,
          ),
        );
    }

    const bodyParse = reindexRequestSchema.safeParse(request.body ?? {});
    if (!bodyParse.success) {
      return reply
        .code(400)
        .send(
          err(
            "INVALID_REQUEST",
            bodyParse.error.issues.map((i) => i.message).join(", "),
            request.id,
          ),
        );
    }

    const requireEmbeddings = bodyParse.data.requireEmbeddings === true;

    try {
      const result = await reindexVault(appConfig, { requireEmbeddings });
      const reopenedStore = await IndexStore.open(store.getDbPath());
      store.close();
      initApp(reopenedStore, appConfig);

      return {
        data: {
          mode: result.mode,
          notesIndexed: result.notesIndexed,
          chunksIndexed: result.chunksIndexed,
          notesSkipped: result.notesSkipped,
          warningCount: result.warnings.length,
        },
        warnings: result.warnings.slice(0, 100),
      };
    } catch (error) {
      if (error instanceof IndexError) {
        const status = indexErrorStatus(error);
        if (status === null) throw error;
        return reply
          .code(status)
          .send(err(error.code, error.message, request.id));
      }
      throw error;
    }
  });

  app.post("/search", async (request, reply) => {
    if (!store) {
      return reply
        .code(409)
        .send(
          err(
            "INDEX_NOT_FOUND",
            "No usable index. Start the server to build an initial index.",
            request.id,
          ),
        );
    }

    const parseResult = searchRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      const code = validationErrorCode(parseResult.error, "INVALID_QUERY");
      return reply
        .code(400)
        .send(
          err(
            code,
            parseResult.error.issues.map((i) => i.message).join(", "),
            request.id,
          ),
        );
    }

    const { query, mode, limit } = parseResult.data;

    try {
      const result = await search(
        store!,
        query,
        mode,
        limit ?? 10,
        appConfig,
        embeddingProvider ?? undefined,
      );

      return {
        data: {
          requestedMode: result.requestedMode,
          usedMode: result.usedMode,
          limit: result.limit,
          results: result.results,
        },
        warnings: result.warnings,
      };
    } catch (error) {
      if (error instanceof SearchError && error.code === "INDEX_NOT_FOUND") {
        return reply
          .code(409)
          .send(err("INDEX_NOT_FOUND", error.message, request.id));
      }
      if (error instanceof SearchError && error.code === "INDEX_INCOMPATIBLE") {
        return reply
          .code(409)
          .send(err("INDEX_INCOMPATIBLE", error.message, request.id));
      }
      if (error instanceof SearchError && error.code === "INVALID_LIMIT") {
        return reply
          .code(400)
          .send(err("INVALID_LIMIT", error.message, request.id));
      }
      if (
        error instanceof SearchError &&
        error.code === "EMBEDDING_UNAVAILABLE"
      ) {
        return reply
          .code(503)
          .send(err("EMBEDDING_UNAVAILABLE", error.message, request.id));
      }
      throw error;
    }
  });

  app.post("/related", async (request, reply) => {
    if (!store) {
      return reply
        .code(409)
        .send(
          err(
            "INDEX_NOT_FOUND",
            "No usable index. Start the server to build an initial index.",
            request.id,
          ),
        );
    }

    const parseResult = relatedRequestSchema.safeParse(request.body);
    if (!parseResult.success) {
      const code = validationErrorCode(parseResult.error, "INVALID_REQUEST");
      return reply
        .code(400)
        .send(
          err(
            code,
            parseResult.error.issues.map((i) => i.message).join(", "),
            request.id,
          ),
        );
    }

    const { type, id, mode, limit } = parseResult.data;

    try {
      const result = await getRelated(
        store!,
        type,
        id,
        mode,
        limit ?? 10,
        appConfig,
        embeddingProvider ?? undefined,
      );

      return {
        data: {
          input: result.input,
          requestedMode: result.requestedMode,
          usedMode: result.usedMode,
          limit: result.limit,
          results: result.results,
        },
        warnings: result.warnings,
      };
    } catch (error) {
      if (error instanceof SearchError && error.code === "INDEX_NOT_FOUND") {
        return reply
          .code(409)
          .send(err("INDEX_NOT_FOUND", error.message, request.id));
      }
      if (error instanceof SearchError && error.code === "INDEX_INCOMPATIBLE") {
        return reply
          .code(409)
          .send(err("INDEX_INCOMPATIBLE", error.message, request.id));
      }
      if (error instanceof SearchError && error.code === "INVALID_ID") {
        return reply
          .code(400)
          .send(err("INVALID_ID", error.message, request.id));
      }
      if (error instanceof SearchError && error.code === "INVALID_LIMIT") {
        return reply
          .code(400)
          .send(err("INVALID_LIMIT", error.message, request.id));
      }
      if (error instanceof SearchError && error.code === "NOTE_NOT_FOUND") {
        return reply
          .code(404)
          .send(err("NOTE_NOT_FOUND", error.message, request.id));
      }
      if (error instanceof SearchError && error.code === "CHUNK_NOT_FOUND") {
        return reply
          .code(404)
          .send(err("CHUNK_NOT_FOUND", error.message, request.id));
      }
      if (
        error instanceof SearchError &&
        error.code === "EMBEDDING_UNAVAILABLE"
      ) {
        return reply
          .code(503)
          .send(err("EMBEDDING_UNAVAILABLE", error.message, request.id));
      }
      throw error;
    }
  });

  app.get("/notes/:noteId", async (request, reply) => {
    if (!store || !config) {
      return reply
        .code(409)
        .send(
          err(
            "INDEX_NOT_FOUND",
            "No usable index. Start the server to build an initial index.",
            request.id,
          ),
        );
    }

    const { noteId } = request.params as { noteId: string };
    const { allowLarge } = request.query as { allowLarge?: string };

    if (!NOTE_ID_REGEX.test(noteId)) {
      return reply
        .code(400)
        .send(err("INVALID_ID", "Invalid note ID format.", request.id));
    }

    try {
      const result = await getNote(
        store!,
        noteId,
        config!.vault.root,
        allowLarge === "true",
      );

      if (!result) {
        return reply
          .code(404)
          .send(err("NOTE_NOT_FOUND", `Note not found: ${noteId}`, request.id));
      }

      return {
        data: result,
        warnings: [],
      };
    } catch (error) {
      if (
        error instanceof RetrievalSizeError &&
        error.code === "NOTE_TOO_LARGE"
      ) {
        return reply
          .code(413)
          .send(err("NOTE_TOO_LARGE", error.message, request.id));
      }
      throw error;
    }
  });

  app.get("/chunks/:noteId/:chunkIndex", async (request, reply) => {
    if (!store) {
      return reply
        .code(409)
        .send(
          err(
            "INDEX_NOT_FOUND",
            "No usable index. Start the server to build an initial index.",
            request.id,
          ),
        );
    }

    const { noteId, chunkIndex } = request.params as {
      noteId: string;
      chunkIndex: string;
    };
    const index = parseInt(chunkIndex, 10);

    if (!NOTE_ID_REGEX.test(noteId)) {
      return reply
        .code(400)
        .send(err("INVALID_ID", "Invalid note ID format.", request.id));
    }

    if (isNaN(index) || index < 0) {
      return reply
        .code(400)
        .send(err("INVALID_ID", "Invalid chunk index.", request.id));
    }

    const result = await getChunk(store!, noteId, index);

    if (!result) {
      return reply
        .code(404)
        .send(
          err(
            "CHUNK_NOT_FOUND",
            `Chunk not found: ${noteId}:${index}`,
            request.id,
          ),
        );
    }

    return {
      data: result,
      warnings: [],
    };
  });

  app.get("/attachments/*", async (request, reply) => {
    if (!config) {
      return reply
        .code(500)
        .send(err("CONFIG_INVALID", "Server not configured.", request.id));
    }

    const vaultRelativePath = (request.params as { "*": string })["*"];
    const { download, allowLarge } = request.query as {
      download?: string;
      allowLarge?: string;
    };

    try {
      resolveVaultRelativePath(
        validateVaultPath(config!.vault.root),
        vaultRelativePath,
      );
    } catch (error) {
      if (error instanceof PathSafetyError) {
        return reply
          .code(403)
          .send(err("PATH_OUTSIDE_VAULT", error.message, request.id));
      }
      throw error;
    }

    if (
      !VaultDiscovery.isAttachmentAllowed(
        config!.vault.root,
        vaultRelativePath,
        config!.vault.exclude,
      )
    ) {
      return reply
        .code(403)
        .send(
          err(
            "ATTACHMENT_NOT_ALLOWED",
            `Attachment not allowed: ${vaultRelativePath}`,
            request.id,
          ),
        );
    }

    if (download === "true") {
      try {
        const result = await getAttachmentBytes(
          config!.vault.root,
          vaultRelativePath,
          allowLarge === "true",
          config!.vault.exclude,
        );

        if (!result) {
          return reply
            .code(404)
            .send(
              err(
                "ATTACHMENT_NOT_FOUND",
                `Attachment not found: ${vaultRelativePath}`,
                request.id,
              ),
            );
        }

        reply.header("Content-Type", result.contentType);
        reply.header(
          "Content-Disposition",
          `attachment; filename="${result.fileName}"`,
        );
        return reply.send(result.bytes);
      } catch (error) {
        if (
          error instanceof RetrievalSizeError &&
          error.code === "ATTACHMENT_TOO_LARGE"
        ) {
          return reply
            .code(413)
            .send(err("ATTACHMENT_TOO_LARGE", error.message, request.id));
        }
        if (error instanceof PathSafetyError) {
          return reply
            .code(403)
            .send(err("PATH_OUTSIDE_VAULT", error.message, request.id));
        }
        if (error instanceof InvalidPathError) {
          return reply
            .code(400)
            .send(err("INVALID_PATH", error.message, request.id));
        }
        throw error;
      }
    }

    try {
      const metadata = await getAttachmentMetadata(
        config!.vault.root,
        vaultRelativePath,
        config!.vault.exclude,
      );

      if (!metadata) {
        return reply
          .code(404)
          .send(
            err(
              "ATTACHMENT_NOT_FOUND",
              `Attachment not found: ${vaultRelativePath}`,
              request.id,
            ),
          );
      }

      return {
        data: metadata,
        warnings: [],
      };
    } catch (error) {
      if (error instanceof PathSafetyError) {
        return reply
          .code(403)
          .send(err("PATH_OUTSIDE_VAULT", error.message, request.id));
      }
      if (error instanceof InvalidPathError) {
        return reply
          .code(400)
          .send(err("INVALID_PATH", error.message, request.id));
      }
      throw error;
    }
  });

  return app;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

export async function startServer(
  appConfig: Config,
  options: PrepareServerAccessOptions = {},
): Promise<void> {
  const preparedConfig = prepareServerAccessConfig(appConfig, options);
  const app = await createServer(preparedConfig);

  const dbPath = getIndexPath(preparedConfig);
  const dir = await import("node:path").then((p) => p.dirname(dbPath));
  const fs = await import("node:fs");

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let appStore = await IndexStore.open(dbPath);

  const startupIndexState = validateStartupIndexState(appStore, preparedConfig);
  if (!startupIndexState.usable) {
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
  } else if (startupIndexState.warnings.length > 0) {
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

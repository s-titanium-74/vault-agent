import { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  Config,
  IndexError,
  IndexStore,
  indexVault,
  reindexVault,
} from "@vault-agent/core";
import { err, indexErrorStatus } from "../http-utils.js";
import { getAppState, initApp } from "../state.js";

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

export function registerIndexRoutes(
  app: FastifyInstance,
  appConfig: Config,
): void {
  app.post("/index", async (request, reply) => {
    const { store } = getAppState();
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
    const { store } = getAppState();
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
}

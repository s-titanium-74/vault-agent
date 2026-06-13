import { FastifyInstance } from "fastify";
import {
  Config,
  SearchError,
  getRelated,
  relatedRequestSchema,
  search,
  searchRequestSchema,
} from "@vault-agent/core";
import { err, validationErrorCode } from "../http-utils.js";
import { getAppState } from "../state.js";

export function registerSearchRoutes(
  app: FastifyInstance,
  appConfig: Config,
): void {
  app.post("/search", async (request, reply) => {
    const { store, embeddingProvider } = getAppState();
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
        store,
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
    const { store, embeddingProvider } = getAppState();
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
        store,
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
}

import { FastifyInstance, FastifyReply } from "fastify";
import {
  SearchError,
  getOverview,
  getTree,
  getTags,
  getFacets,
  overviewQuerySchema,
  treeQuerySchema,
  tagsQuerySchema,
  facetsQuerySchema,
  type OrientationContext,
} from "@vault-agent/core";
import { err } from "../http-utils.js";
import { getAppState } from "../state.js";

function makeOrientationContext(): OrientationContext {
  const { store, config, freshnessMachine } = getAppState();
  if (!store) {
    throw new Error("Store not available");
  }
  if (!config) {
    throw new Error("Config not available");
  }
  return {
    store,
    config,
    freshnessMachine: freshnessMachine ?? null,
  };
}

export function registerOrientationRoutes(app: FastifyInstance): void {
  app.get("/overview", async (request, reply) => {
    const { store } = getAppState();
    if (!store) {
      return reply
        .code(409)
        .send(
          err(
            "INDEX_NOT_FOUND",
            "No usable index found. Run `vault-agent index` or `vault-agent reindex`.",
            request.id,
          ),
        );
    }

    const parseResult = overviewQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply
        .code(400)
        .send(
          err(
            "INVALID_PARAMETER",
            parseResult.error.issues.map((i) => i.message).join(", "),
            request.id,
          ),
        );
    }

    try {
      const ctx = makeOrientationContext();
      const result = getOverview(ctx);
      return { data: result.data, warnings: result.warnings };
    } catch (error) {
      return handleOrientationError(error, reply, request.id);
    }
  });

  app.get("/tree", async (request, reply) => {
    const { store } = getAppState();
    if (!store) {
      return reply
        .code(409)
        .send(
          err(
            "INDEX_NOT_FOUND",
            "No usable index found. Run `vault-agent index` or `vault-agent reindex`.",
            request.id,
          ),
        );
    }

    const parseResult = treeQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply
        .code(400)
        .send(
          err(
            "INVALID_PARAMETER",
            parseResult.error.issues.map((i) => i.message).join(", "),
            request.id,
          ),
        );
    }

    try {
      const ctx = makeOrientationContext();
      const result = getTree(ctx, parseResult.data);
      return { data: result.data, warnings: result.warnings };
    } catch (error) {
      return handleOrientationError(error, reply, request.id);
    }
  });

  app.get("/tags", async (request, reply) => {
    const { store } = getAppState();
    if (!store) {
      return reply
        .code(409)
        .send(
          err(
            "INDEX_NOT_FOUND",
            "No usable index found. Run `vault-agent index` or `vault-agent reindex`.",
            request.id,
          ),
        );
    }

    const parseResult = tagsQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply
        .code(400)
        .send(
          err(
            "INVALID_PARAMETER",
            parseResult.error.issues.map((i) => i.message).join(", "),
            request.id,
          ),
        );
    }

    try {
      const ctx = makeOrientationContext();
      const result = getTags(ctx, parseResult.data);
      return { data: result.data, warnings: result.warnings };
    } catch (error) {
      return handleOrientationError(error, reply, request.id);
    }
  });

  app.get("/facets", async (request, reply) => {
    const { store } = getAppState();
    if (!store) {
      return reply
        .code(409)
        .send(
          err(
            "INDEX_NOT_FOUND",
            "No usable index found. Run `vault-agent index` or `vault-agent reindex`.",
            request.id,
          ),
        );
    }

    const parseResult = facetsQuerySchema.safeParse(request.query);
    if (!parseResult.success) {
      return reply
        .code(400)
        .send(
          err(
            "INVALID_PARAMETER",
            parseResult.error.issues.map((i) => i.message).join(", "),
            request.id,
          ),
        );
    }

    try {
      const ctx = makeOrientationContext();
      const result = getFacets(ctx, parseResult.data);
      return { data: result.data, warnings: result.warnings };
    } catch (error) {
      return handleOrientationError(error, reply, request.id);
    }
  });
}

function handleOrientationError(
  error: unknown,
  reply: FastifyReply,
  requestId: string,
): FastifyReply {
  if (error instanceof SearchError && error.code === "INDEX_NOT_FOUND") {
    return reply
      .code(409)
      .send(err("INDEX_NOT_FOUND", error.message, requestId));
  }
  if (error instanceof SearchError && error.code === "INDEX_INCOMPATIBLE") {
    return reply
      .code(409)
      .send(err("INDEX_INCOMPATIBLE", error.message, requestId));
  }
  throw error;
}

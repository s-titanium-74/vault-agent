import { FastifyInstance, FastifyReply } from "fastify";
import {
  SearchError,
  getMetadataProfile,
  getStyleProfile,
  profileQuerySchema,
  type ProfileContext,
  type ProfileParams,
} from "@vault-agent/core";
import { err } from "../http-utils.js";
import { getAppState } from "../state.js";

function makeProfileContext(): ProfileContext {
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

export function registerProfileRoutes(app: FastifyInstance): void {
  app.get("/profiles/metadata", async (request, reply) => {
    const unavailable = ensureStoreAvailable(request.id, reply);
    if (unavailable) return unavailable;

    const parseResult = profileQuerySchema.safeParse(request.query);
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
      const result = getMetadataProfile(
        makeProfileContext(),
        profileParamsFromQuery(parseResult.data),
      );
      return { data: result.data, warnings: result.warnings };
    } catch (error) {
      return handleProfileError(error, reply, request.id);
    }
  });

  app.get("/profiles/style", async (request, reply) => {
    const unavailable = ensureStoreAvailable(request.id, reply);
    if (unavailable) return unavailable;

    const parseResult = profileQuerySchema.safeParse(request.query);
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
      const result = getStyleProfile(
        makeProfileContext(),
        profileParamsFromQuery(parseResult.data),
      );
      return { data: result.data, warnings: result.warnings };
    } catch (error) {
      return handleProfileError(error, reply, request.id);
    }
  });
}

function profileParamsFromQuery(query: {
  limit?: number;
  pathPrefix?: string;
  tag?: string[];
  frontmatterType?: string[];
  frontmatterStatus?: string[];
  noteId?: string[];
  exampleSelection?: "path" | "representative";
}): ProfileParams {
  return {
    limit: query.limit,
    pathPrefix: query.pathPrefix,
    noteIds: query.noteId,
    exampleSelection: query.exampleSelection,
    filters: {
      ...(query.tag ? { tags: query.tag } : {}),
      ...((query.frontmatterType || query.frontmatterStatus) && {
        frontmatter: {
          ...(query.frontmatterType ? { type: query.frontmatterType } : {}),
          ...(query.frontmatterStatus
            ? { status: query.frontmatterStatus }
            : {}),
        },
      }),
    },
  };
}

function ensureStoreAvailable(
  requestId: string,
  reply: FastifyReply,
): FastifyReply | null {
  const { store } = getAppState();
  if (store) return null;
  return reply
    .code(409)
    .send(
      err(
        "INDEX_NOT_FOUND",
        "No usable index found. Run `vault-agent index` or `vault-agent reindex`.",
        requestId,
      ),
    );
}

function handleProfileError(
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
  if (error instanceof SearchError && error.code === "INVALID_PATH_FILTER") {
    return reply
      .code(400)
      .send(err("INVALID_PATH_FILTER", error.message, requestId));
  }
  if (error instanceof SearchError && error.code === "INVALID_TAG_FILTER") {
    return reply
      .code(400)
      .send(err("INVALID_TAG_FILTER", error.message, requestId));
  }
  if (
    error instanceof SearchError &&
    error.code === "INVALID_FRONTMATTER_FILTER"
  ) {
    return reply
      .code(400)
      .send(err("INVALID_FRONTMATTER_FILTER", error.message, requestId));
  }
  if (error instanceof SearchError && error.code === "INVALID_ID") {
    return reply.code(400).send(err("INVALID_ID", error.message, requestId));
  }
  throw error;
}

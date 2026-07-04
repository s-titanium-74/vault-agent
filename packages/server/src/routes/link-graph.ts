import { FastifyInstance, FastifyReply } from "fastify";
import {
  SearchError,
  getBacklinks,
  getBrokenLinks,
  getLinkSummary,
  getNoteLinks,
  getOrphanNotes,
  linkLimitQuerySchema,
  linkSummaryQuerySchema,
  type LinkGraphContext,
} from "@vault-agent/core";
import { NOTE_ID_REGEX, err } from "../http-utils.js";
import { getAppState } from "../state.js";

function makeLinkGraphContext(): LinkGraphContext {
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

export function registerLinkGraphRoutes(app: FastifyInstance): void {
  app.get("/links/notes/:noteId", async (request, reply) => {
    const unavailable = ensureStoreAvailable(request.id, reply);
    if (unavailable) return unavailable;

    const { noteId } = request.params as { noteId: string };
    if (!NOTE_ID_REGEX.test(noteId)) {
      return reply
        .code(400)
        .send(err("INVALID_ID", "Invalid note ID format.", request.id));
    }

    try {
      const result = getNoteLinks(makeLinkGraphContext(), noteId);
      return { data: result.data, warnings: result.warnings };
    } catch (error) {
      return handleLinkGraphError(error, reply, request.id);
    }
  });

  app.get("/links/backlinks/:noteId", async (request, reply) => {
    const unavailable = ensureStoreAvailable(request.id, reply);
    if (unavailable) return unavailable;

    const { noteId } = request.params as { noteId: string };
    if (!NOTE_ID_REGEX.test(noteId)) {
      return reply
        .code(400)
        .send(err("INVALID_ID", "Invalid note ID format.", request.id));
    }

    try {
      const result = getBacklinks(makeLinkGraphContext(), noteId);
      return { data: result.data, warnings: result.warnings };
    } catch (error) {
      return handleLinkGraphError(error, reply, request.id);
    }
  });

  app.get("/links/broken", async (request, reply) => {
    const unavailable = ensureStoreAvailable(request.id, reply);
    if (unavailable) return unavailable;

    const parseResult = linkLimitQuerySchema.safeParse(request.query);
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
      const result = getBrokenLinks(makeLinkGraphContext(), parseResult.data);
      return { data: result.data, warnings: result.warnings };
    } catch (error) {
      return handleLinkGraphError(error, reply, request.id);
    }
  });

  app.get("/links/orphans", async (request, reply) => {
    const unavailable = ensureStoreAvailable(request.id, reply);
    if (unavailable) return unavailable;

    const parseResult = linkLimitQuerySchema.safeParse(request.query);
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
      const result = getOrphanNotes(makeLinkGraphContext(), parseResult.data);
      return { data: result.data, warnings: result.warnings };
    } catch (error) {
      return handleLinkGraphError(error, reply, request.id);
    }
  });

  app.get("/links/summary", async (request, reply) => {
    const unavailable = ensureStoreAvailable(request.id, reply);
    if (unavailable) return unavailable;

    const parseResult = linkSummaryQuerySchema.safeParse(request.query);
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
      const result = getLinkSummary(makeLinkGraphContext(), parseResult.data);
      return { data: result.data, warnings: result.warnings };
    } catch (error) {
      return handleLinkGraphError(error, reply, request.id);
    }
  });
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

function handleLinkGraphError(
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
  if (error instanceof SearchError && error.code === "NOTE_NOT_FOUND") {
    return reply
      .code(404)
      .send(err("NOTE_NOT_FOUND", error.message, requestId));
  }
  if (error instanceof SearchError && error.code === "INVALID_PATH_FILTER") {
    return reply
      .code(400)
      .send(err("INVALID_PATH_FILTER", error.message, requestId));
  }
  throw error;
}

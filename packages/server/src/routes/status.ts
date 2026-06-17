import { FastifyInstance } from "fastify";
import { buildStatus } from "@vault-agent/core";
import { err } from "../http-utils.js";
import { getAppState } from "../state.js";

export function registerStatusRoute(app: FastifyInstance): void {
  app.get("/status", async (request, reply) => {
    const state = getAppState();
    const { store, config, watcher, gitSync, freshnessMachine } = state;

    if (!store || !config) {
      reply
        .code(409)
        .send(err("INDEX_NOT_FOUND", "No usable index.", request.id));
      return;
    }

    const staleness = store.checkStaleness(config);
    if (staleness.incompatible) {
      const freshnessInfo = freshnessMachine?.info ?? {
        state: "incompatible" as const,
        lastSuccessfulUpdateAt: null,
        pendingChangeCount: 0,
        reindexRequired: true,
        reindexReasons: [staleness.details],
      };

      const syncStatus = gitSync?.status ?? {
        enabled: config.sync.enabled,
        configured: Boolean(config.sync.repo),
        state: "idle" as const,
        pending: false,
        lastSuccessfulSyncAt: null,
        consecutiveFailures: 0,
        lastError: null,
      };

      const watcherStatus = watcher?.status ?? {
        enabled: config.watch.enabled,
        state: "unavailable" as const,
        lastEventAt: null,
        pending: false,
        lastError: {
          code: "INDEX_NOT_FOUND",
          message: "Watcher not initialized",
        },
      };

      const status = buildStatus(config, {
        index: {
          freshness: freshnessInfo,
          embeddingState: config.embedding.enabled
            ? store.isVecAvailable()
              ? "ready"
              : "unavailable"
            : "disabled",
        },
        watch: watcherStatus,
        sync: syncStatus,
      });

      reply.send({
        data: status,
        warnings: [{ code: "INDEX_INCOMPATIBLE", message: staleness.details }],
      });
      return;
    }

    let freshnessInfo = freshnessMachine?.info ?? {
      state: "fresh" as const,
      lastSuccessfulUpdateAt: null,
      pendingChangeCount: 0,
      reindexRequired: false,
      reindexReasons: [],
    };

    if (staleness.stale && !freshnessMachine) {
      freshnessInfo = {
        state: "stale",
        lastSuccessfulUpdateAt: null,
        pendingChangeCount: 0,
        reindexRequired: false,
        reindexReasons: [staleness.details],
      };
    }

    const syncStatus = gitSync?.status ?? {
      enabled: config.sync.enabled,
      configured: Boolean(config.sync.repo),
      state: "idle" as const,
      pending: false,
      lastSuccessfulSyncAt: null,
      consecutiveFailures: 0,
      lastError: null,
    };

    const watcherStatus = watcher?.status ?? {
      enabled: config.watch.enabled,
      state: config.watch.enabled ? "starting" : "disabled",
      lastEventAt: null,
      pending: false,
      lastError: null,
    };

    const status = buildStatus(config, {
      index: {
        freshness: freshnessInfo,
        embeddingState: config.embedding.enabled
          ? store.isVecAvailable()
            ? "ready"
            : "unavailable"
          : "disabled",
      },
      watch: watcherStatus,
      sync: syncStatus,
    });

    const warnings: Array<{ code: string; message: string }> = [];
    if (staleness.stale) {
      warnings.push({ code: "INDEX_STALE", message: staleness.details });
    }

    reply.send({ data: status, warnings });
  });
}

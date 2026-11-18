import { FastifyInstance } from "fastify";
import { getAppState } from "../state.js";

export function registerHealthRoute(app: FastifyInstance): void {
  app.get("/health", async () => {
    const { store, config } = getAppState();
    const manifest = store?.getManifest() ?? null;
    let stale = false;
    if (manifest && config) {
      try {
        const staleness = store!.checkStaleness(config!);
        stale = staleness.stale || staleness.incompatible;
      } catch {
        stale = true;
      }
    }
    const embeddingAvailable = !!(
      store &&
      config &&
      store.embeddingState(config) === "ready"
    );
    const embeddingIncomplete =
      !!config?.embedding.enabled && !embeddingAvailable;
    return {
      data: {
        status: manifest
          ? stale || embeddingIncomplete
            ? "degraded"
            : "ok"
          : "degraded",
        version: "0.2.5",
        index: manifest
          ? {
              available: true,
              stale,
              embeddingAvailable,
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
}

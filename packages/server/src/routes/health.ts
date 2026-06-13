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
}

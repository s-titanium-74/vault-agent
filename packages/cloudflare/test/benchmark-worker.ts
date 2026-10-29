// Synthetic local benchmark only; never deploy this administration route.
import worker from "../src/index.js";
import { tick } from "../src/ingestion.js";
import { measured, record } from "./remote-ingestion-worker.js";
import type { Env } from "../src/config.js";
export default {
  async fetch(request: Request, env: Env) {
    const m = measured(env);
    const start = Date.now();
    const scheduled = new URL(request.url).pathname === "/__tick";
    try {
      if (scheduled) {
        await tick(m.env);
        return Response.json({ ok: true });
      }
      return await worker.fetch(request, m.env);
    } finally {
      await record(
        env,
        scheduled ? "scheduled-simulation" : request.method,
        start,
        m.counts,
      );
    }
  },
};

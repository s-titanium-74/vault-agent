// Synthetic-only administration wrapper; never bind private vault resources.
import worker, { measured, record } from "./remote-ingestion-worker.js";
import { authenticate, config, type Env } from "../src/config.js";
import { tick } from "../src/ingestion.js";
export default {
  async fetch(request: Request, env: Env & { SYNTHETIC_RETENTION?: string }) {
    if (
      new URL(request.url).pathname !== "/__retention/tick" ||
      env.SYNTHETIC_RETENTION !== "true"
    )
      return worker.fetch(request, env);
    if (request.method !== "POST") return new Response(null, { status: 405 });
    try {
      const settings = config(env);
      if (new URL(request.url).protocol !== "https:")
        return new Response(null, { status: 403 });
      await authenticate(request, env, true);
      const origin = request.headers.get("Origin");
      if (origin && !settings.origins.includes(origin))
        return new Response(null, { status: 403 });
      if (!(await env.REQUEST_LIMITER.limit({ key: env.VAULT_ID })).success)
        return new Response(null, {
          status: 429,
          headers: { "Retry-After": "60" },
        });
    } catch {
      return Response.json(
        { error: { code: "ADMIN_REQUIRED" } },
        { status: 403 },
      );
    }
    const m = measured(env),
      start = Date.now();
    try {
      await tick(m.env);
      return Response.json(
        { ok: true },
        { headers: { "Cache-Control": "no-store" } },
      );
    } finally {
      await record(env, "retention-tick", start, m.counts);
    }
  },
  scheduled: worker.scheduled,
};

// Local synthetic tests only. Never deploy this unauthenticated test harness.
import worker from "./ingestion-worker.js";
import { tick, type ReconciliationLog } from "../src/ingestion.js";
import { measured } from "./remote-ingestion-worker.js";
import type { Env } from "../src/config.js";

export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname !== "/__idle")
      return worker.fetch(request, env);
    if (request.headers.has("X-Synthetic-Policy"))
      env = { ...env, EXCLUDE_PATHS: '["Notes/**"]' };
    if (request.headers.has("X-Synthetic-Model"))
      env = { ...env, EMBEDDING_MODEL_REVISION: "operator-v2" };
    const original = env.SOURCE;
    let pages = 0;
    env = {
      ...env,
      SOURCE: new Proxy(original, {
        get(target, key) {
          if (key === "list")
            return async (options: R2ListOptions) => {
              if (request.headers.has("X-Synthetic-Failure"))
                throw new Error(
                  "synthetic-private-path secret-token provider-response",
                );
              const page = await target.list(options);
              if (options.prefix?.endsWith("/source/")) {
                pages++;
                if (pages === 1 && request.headers.has("X-Synthetic-Epoch"))
                  await env.DB.prepare(
                    "UPDATE publications SET epoch=epoch+1",
                  ).run();
                if (pages === 1 && request.headers.has("X-Synthetic-Upload")) {
                  const id = crypto.randomUUID();
                  await env.DB.prepare(
                    "INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,created) SELECT ?,?,'upload','applying',data,? FROM ingestion_jobs WHERE id=(SELECT job FROM ingestion_state)",
                  )
                    .bind(id, id, Date.now())
                    .run();
                }
                if (pages === 1 && request.headers.has("X-Synthetic-Edit"))
                  await target.put(
                    options.prefix + "Notes/New.md",
                    "# New\nSynthetic change during list.",
                  );
                if (
                  request.headers.has("X-Synthetic-Duplicate") &&
                  page.objects.length
                )
                  page.objects.push(page.objects[0]!);
              }
              return page;
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    let mutatingStatements = 0;
    const originalDB = env.DB;
    env = {
      ...env,
      DB: new Proxy(originalDB, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              if (/^(INSERT|UPDATE|DELETE|DROP|CREATE|ALTER)/i.test(sql.trim()))
                mutatingStatements++;
              return target.prepare(sql);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    };
    const m = measured(env);
    const logs: ReconciliationLog[] = [];
    const start = Date.now();
    try {
      await tick(m.env, (entry) => logs.push(entry));
      return Response.json({
        counts: m.counts,
        mutatingStatements,
        logs,
        wallMs: Date.now() - start,
      });
    } catch {
      return Response.json(
        {
          counts: m.counts,
          mutatingStatements,
          logs,
          wallMs: Date.now() - start,
        },
        { status: 503 },
      );
    }
  },
};

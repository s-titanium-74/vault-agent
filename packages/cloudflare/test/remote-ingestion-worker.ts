// Disposable remote smoke entrypoint. Never deploy with real vault bindings.
// Collects operation counts and wall time only, without paths/content/secrets.
import worker from "../src/index.js";
import type { Env } from "../src/config.js";
export function measured(env: Env) {
  const counts = {
    queries: 0,
    rowsRead: 0,
    rowsWritten: 0,
    r2Get: 0,
    r2Head: 0,
    r2List: 0,
    r2Put: 0,
    r2Delete: 0,
    aiCalls: 0,
    aiInputs: 0,
    aiInputBytes: 0,
    vectorQueries: 0,
    vectorQueryDimensions: 0,
    vectorUpserts: 0,
  };
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const result = (r: D1Result) => {
    counts.rowsRead += r.meta.rows_read;
    counts.rowsWritten += r.meta.rows_written;
    return r;
  };
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(statement, {
      get(target, key) {
        if (key === "bind")
          return (...args: unknown[]) => wrap(target.bind(...args));
        if (key === "first")
          return async (column?: string) => {
            counts.queries++;
            const r = result(await target.all());
            const row = r.results[0] ?? null;
            return column && row ? row[column] : row;
          };
        if (key === "all" || key === "run")
          return async () => {
            counts.queries++;
            return result(await target[key]());
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    originals.set(proxy, statement);
    return proxy;
  };
  const DB = new Proxy(env.DB, {
    get(target, key) {
      if (key === "withSession")
        return (constraint?: string) => {
          const session = target.withSession(constraint);
          return new Proxy(session, {
            get(s, k) {
              if (k === "prepare") return (sql: string) => wrap(s.prepare(sql));
              if (k === "batch")
                return async (statements: D1PreparedStatement[]) => {
                  counts.queries += statements.length;
                  return (
                    await s.batch(
                      statements.map(
                        (statement) => originals.get(statement) ?? statement,
                      ),
                    )
                  ).map(result);
                };
              const value = Reflect.get(s, k);
              return typeof value === "function" ? value.bind(s) : value;
            },
          });
        };
      if (key === "prepare") return (sql: string) => wrap(target.prepare(sql));
      if (key === "batch")
        return async (statements: D1PreparedStatement[]) => {
          counts.queries += statements.length;
          const results = await target.batch(
            statements.map((s) => originals.get(s) ?? s),
          );
          return results.map(result);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const SOURCE = new Proxy(env.SOURCE, {
    get(target, key) {
      const value = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const names: Record<string, keyof typeof counts> = {
          get: "r2Get",
          head: "r2Head",
          list: "r2List",
          put: "r2Put",
          delete: "r2Delete",
        };
        if (typeof key === "string" && names[key]) counts[names[key]]++;
        return Reflect.apply(value, target, args);
      };
    },
  });
  const AI = env.AI
    ? new Proxy(env.AI, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (key === "run") {
              counts.aiCalls++;
              const input = args[1] as { text?: unknown };
              if (Array.isArray(input?.text)) {
                counts.aiInputs += input.text.length;
                counts.aiInputBytes += input.text.reduce(
                  (sum: number, text: unknown) =>
                    sum +
                    (typeof text === "string"
                      ? new TextEncoder().encode(text).length
                      : 0),
                  0,
                );
              }
            }
            return Reflect.apply(value, target, args);
          };
        },
      })
    : undefined;
  const VECTORS = env.VECTORS
    ? new Proxy(env.VECTORS, {
        get(target, key) {
          const value = Reflect.get(target, key);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (key === "query" && Array.isArray(args[0])) {
              counts.vectorQueries++;
              counts.vectorQueryDimensions += args[0].length;
            }
            if (key === "upsert" && Array.isArray(args[0]))
              counts.vectorUpserts += args[0].length;
            return Reflect.apply(value, target, args);
          };
        },
      })
    : undefined;
  return { env: { ...env, DB, SOURCE, AI, VECTORS }, counts };
}
export async function record(
  env: Env,
  kind: string,
  start: number,
  counts: unknown,
) {
  await env.DB.prepare(
    "INSERT INTO synthetic_telemetry(kind,wall_ms,counts) VALUES(?,?,?)",
  )
    .bind(kind, Date.now() - start, JSON.stringify(counts))
    .run();
}
export default {
  async fetch(request: Request, env: Env) {
    const m = measured(env),
      start = Date.now();
    try {
      return await worker.fetch(request, m.env);
    } finally {
      await record(env, request.method, start, m.counts);
    }
  },
  async scheduled(event: ScheduledController, env: Env) {
    const m = measured(env),
      start = Date.now();
    try {
      await worker.scheduled(event, m.env);
    } finally {
      await record(env, "scheduled", start, m.counts);
    }
  },
};

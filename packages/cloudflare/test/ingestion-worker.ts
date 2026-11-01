// Test-only entry point: scheduled handler is exercised without a real timer.
import worker from "../src/index.js";
import { tick } from "../src/ingestion.js";
import type { Env } from "../src/config.js";
export default {
  async fetch(request: Request, env: Env) {
    const sourceCounts = { get: 0, head: 0, list: 0, put: 0 };
    if (request.headers.has("X-Synthetic-Measure-Source"))
      env = {
        ...env,
        SOURCE: new Proxy(env.SOURCE, {
          get(target, key) {
            const value = Reflect.get(target, key);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              if (key in sourceCounts)
                sourceCounts[key as keyof typeof sourceCounts]++;
              return Reflect.apply(value, target, args);
            };
          },
        }),
      };
    if (request.headers.has("X-Synthetic-Disable-Ingestion"))
      env = { ...env, INGESTION_ENABLED: "false" } as Env;
    if (request.headers.has("X-Synthetic-Disable-Semantic"))
      env = { ...env, EXTERNAL_EMBEDDING_CONSENT: "false" } as Env;
    if (request.headers.has("X-Synthetic-Read-Race")) {
      const original = env.DB;
      let changed = false;
      env = {
        ...env,
        DB: new Proxy(original, {
          get(target, key) {
            if (key === "withSession")
              return (constraint: string) => {
                const session = target.withSession(constraint);
                return new Proxy(session, {
                  get(s, k) {
                    if (k === "prepare")
                      return (sql: string) => {
                        const wrap = (
                          statement: D1PreparedStatement,
                        ): D1PreparedStatement =>
                          new Proxy(statement, {
                            get(t, p) {
                              if (p === "bind")
                                return (...args: unknown[]) =>
                                  wrap(t.bind(...args));
                              if (p === "all")
                                return async () => {
                                  const result = await t.all();
                                  if (
                                    !changed &&
                                    sql.startsWith("SELECT data FROM notes")
                                  ) {
                                    changed = true;
                                    await original
                                      .prepare(
                                        "UPDATE publications SET epoch=epoch+1 WHERE store=(SELECT revision FROM deployment)",
                                      )
                                      .run();
                                  }
                                  return result;
                                };
                              const value = Reflect.get(t, p);
                              return typeof value === "function"
                                ? value.bind(t)
                                : value;
                            },
                          });
                        return wrap(s.prepare(sql));
                      };
                    const value = Reflect.get(s, k);
                    return typeof value === "function" ? value.bind(s) : value;
                  },
                });
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      };
    }
    if (request.headers.has("X-Synthetic-Policy-Change"))
      env = { ...env, EXCLUDE_PATHS: '["Notes/**"]' } as Env;
    if (request.headers.has("X-Synthetic-Lost-Admission")) {
      const original = env.DB;
      const DB = new Proxy(original, {
        get(target, key) {
          if (key === "prepare")
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.startsWith("UPDATE ingestion_state SET job="))
                return statement;
              const wrap = (s: D1PreparedStatement): D1PreparedStatement =>
                new Proxy(s, {
                  get(t, k) {
                    if (k === "bind")
                      return (...args: unknown[]) => wrap(t.bind(...args));
                    if (k === "run")
                      return async () => ({ meta: { changes: 0 } });
                    const value = Reflect.get(t, k);
                    return typeof value === "function" ? value.bind(t) : value;
                  },
                });
              return wrap(statement);
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      env = { ...env, DB };
    }
    if (String(env.EXTERNAL_EMBEDDING_CONSENT) === "true") {
      const index = {
        async describe() {
          return { dimensions: 1024, vectorCount: 1 };
        },
        async upsert(records: VectorizeVector[]) {
          for (const record of records)
            await env.DB.prepare(
              "INSERT OR REPLACE INTO synthetic_vectors VALUES(?,?,?)",
            )
              .bind(record.id, record.namespace, JSON.stringify(record))
              .run();
          return { mutationId: crypto.randomUUID() };
        },
        async getByIds(ids: string[]) {
          const records: VectorizeVector[] = [];
          for (const id of ids) {
            const row = await env.DB.prepare(
              "SELECT data FROM synthetic_vectors WHERE id=?",
            )
              .bind(id)
              .first<{ data: string }>();
            if (row) records.push(JSON.parse(row.data));
          }
          return records;
        },
        async deleteByIds(ids: string[]) {
          for (const id of ids)
            await env.DB.prepare("DELETE FROM synthetic_vectors WHERE id=?")
              .bind(id)
              .run();
          return { mutationId: crypto.randomUUID() };
        },
        async query(
          _values: unknown,
          options: {
            namespace: string;
            filter?: { chunkId: string };
            topK?: number;
          },
        ) {
          const control = await env.DB.prepare(
            "SELECT visible FROM synthetic_usage",
          ).first<{ visible: number }>();
          const rows = (
            await env.DB.prepare(
              "SELECT data FROM synthetic_vectors WHERE namespace=?",
            )
              .bind(options.namespace)
              .all<{ data: string }>()
          ).results;
          const matches = control?.visible
            ? rows
                .map((r) => JSON.parse(r.data))
                .filter(
                  (r) =>
                    !options.filter ||
                    r.metadata.chunkId === options.filter.chunkId,
                )
                .slice(0, options.topK ?? 100)
                .map((r) => ({ id: r.id, score: 0.99, metadata: r.metadata }))
            : [];
          return { matches, count: matches.length };
        },
      };
      env = {
        ...env,
        VECTORS: index as Vectorize,
        AI: {
          async run(_model: unknown, input: { text: string[] }) {
            const state = await env.DB.prepare(
              "SELECT fail FROM synthetic_usage",
            ).first<{ fail: number }>();
            if (state?.fail)
              throw new Error("synthetic-private-provider-error");
            await env.DB.prepare("UPDATE synthetic_usage SET calls=calls+?")
              .bind(input.text.length)
              .run();
            return {
              data: input.text.map(() =>
                Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0)),
              ),
            };
          },
        } as Ai,
      };
    }
    if (new URL(request.url).pathname === "/__tick") {
      await tick(env);
      return Response.json({ ok: true });
    }
    const response = await worker.fetch(request, env);
    if (request.headers.has("X-Synthetic-Measure-Source"))
      response.headers.set(
        "X-Synthetic-Source-Counts",
        JSON.stringify(sourceCounts),
      );
    return response;
  },
};

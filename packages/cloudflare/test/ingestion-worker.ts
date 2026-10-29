// Test-only entry point: scheduled handler is exercised without a real timer.
import worker from "../src/index.js";
import { tick } from "../src/ingestion.js";
import type { Env } from "../src/config.js";
export default {
  async fetch(request: Request, env: Env) {
    if (request.headers.has("X-Synthetic-Policy-Change"))
      env = { ...env, EXCLUDE_PATHS: '["Notes/**"]' } as Env;
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
    return worker.fetch(request, env);
  },
};

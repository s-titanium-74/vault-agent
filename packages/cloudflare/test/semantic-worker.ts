// Test-only binding doubles. The real Worker, D1, R2 and MCP transport execute
// in workerd; no hosted inference or Vectorize service is contacted.
import worker from "../src/index.js";
import type { Env } from "../src/config.js";
import { D1MetadataStore } from "../src/d1.js";
import { VectorizeStore, type VectorBinding } from "../src/vectorize.js";
import { sourcePolicy } from "@vault-agent/core/portable";
import { DIMENSION } from "../src/provider.js";

export default {
  async fetch(request: Request, env: Env) {
    const fail = request.headers.has("X-Synthetic-Failure");
    const records = async () => {
      const row = await env.DB.prepare(
        "SELECT s.* FROM snapshots s JOIN deployment d ON s.revision=d.revision WHERE d.id=1",
      ).first<{ revision: string; manifest: string }>();
      const metadata = new D1MetadataStore(
        env.DB,
        env.VAULT_ID,
        row!.revision,
        JSON.parse(row!.manifest),
        sourcePolicy(["."]),
      );
      const vectors = new VectorizeStore(undefined, metadata, "operator-v1");
      const { generation, namespace } = await vectors.identity();
      const chunks = await metadata.rows(
        "SELECT data FROM chunks WHERE revision=?",
        [row!.revision],
      );
      return Promise.all(
        chunks.map(async (row) => {
          const chunk = metadata.decode(row);
          return {
            id: await vectors.id(String(chunk.chunk_id)),
            namespace,
            values: [],
            metadata: {
              chunkId: String(chunk.chunk_id),
              contentHash: String(chunk.content_hash),
              generation,
            },
          };
        }),
      );
    };
    const index: VectorBinding = {
      describe: async () => ({
        dimensions: DIMENSION,
        vectorCount: 4,
        processedUpToDatetime: 0,
        processedUpToMutation: 0,
      }),
      query: async (_vector, options) => {
        if (fail) throw new Error("synthetic-private-provider-error");
        const matches = (await records())
          .filter((r) => r.namespace === options?.namespace)
          .slice(0, options?.topK)
          .map((r) => ({ id: r.id, score: 0.9 }));
        return { matches, count: matches.length };
      },
      getByIds: async (ids) =>
        (await records()).filter((r) => ids.includes(r.id)),
      upsert: async () => ({ mutationId: "unused" }),
      deleteByIds: async () => ({ mutationId: "unused" }),
    };
    const ai = {
      run: async (_model: string, input: { text: string[] }) => ({
        data: input.text.map(() =>
          Array.from({ length: DIMENSION }, (_, i) => (i === 0 ? 1 : 0)),
        ),
      }),
    };
    return worker.fetch(request, {
      ...env,
      AI: ai as Ai,
      VECTORS: index as Vectorize,
    });
  },
};

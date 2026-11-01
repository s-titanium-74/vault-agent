import * as core from "@vault-agent/core/portable";
import { config, type Env } from "./config.js";
import { D1MetadataStore } from "./d1.js";
import { VectorizeStore } from "./vectorize.js";
import {
  WorkersAIEmbeddingProvider,
  descriptor,
  ProviderOperations,
} from "./provider.js";

export async function semanticProgress(env: Env) {
  if (!config(env).semantic)
    return { state: "disabled", pendingInputs: 0, lastError: null };
  const row = await env.DB.prepare(
    "SELECT count(*) AS pending,sum(CASE WHEN error IS NOT NULL THEN 1 ELSE 0 END) AS failed FROM vector_work WHERE revision=(SELECT revision FROM deployment WHERE id=1) AND state<>'ready'",
  ).first<{ pending: number; failed: number }>();
  const pointer = await env.DB.prepare(
    "SELECT coalesce(p.snapshot,d.revision) AS snapshot,g.state,g.descriptor FROM deployment d LEFT JOIN publications p ON p.store=d.revision LEFT JOIN embedding_generations g ON g.revision=d.revision WHERE d.id=1",
  ).first<{ snapshot: string; state: string; descriptor: string }>();
  const incompatible =
    !!pointer &&
    (pointer.state !== "ready" ||
      pointer.descriptor !==
        JSON.stringify(descriptor(env.EMBEDDING_MODEL_REVISION)));
  return {
    state:
      row?.failed || incompatible
        ? "failed"
        : row?.pending
          ? "updating"
          : pointer
            ? "ready"
            : "updating",
    pendingInputs: row?.pending ?? 0,
    activeSnapshot: pointer?.snapshot ?? null,
    lastError: row?.failed || incompatible ? "EMBEDDING_UNAVAILABLE" : null,
  };
}

/** One resumable input per call. Immutable IDs make concurrent/replayed work harmless. */
export async function advanceSemantic(env: Env) {
  if (!config(env).semantic) return;
  const work = await env.DB.prepare(
    "SELECT w.*,s.manifest FROM vector_work w JOIN snapshots s ON s.revision=w.revision JOIN deployment d ON d.revision=w.revision WHERE w.state<>'ready' AND w.retry_at<=? ORDER BY w.chunk_id LIMIT 1",
  )
    .bind(Date.now())
    .first<{
      revision: string;
      chunk_id: string;
      input_key: string;
      content_hash: string;
      vector_id: string;
      receipt: string | null;
      manifest: string;
    }>();
  if (!work) return;
  try {
    const metadata = new D1MetadataStore(
      env.DB,
      env.VAULT_ID,
      work.revision,
      JSON.parse(work.manifest),
      config(env).allowed,
      true,
    );
    const chunk = await metadata.getChunkById(work.chunk_id);
    if (
      !chunk ||
      chunk.content_hash !== work.content_hash ||
      (await core.embeddingInputKey(
        descriptor(env.EMBEDDING_MODEL_REVISION),
        String(chunk.embedding_input_text),
      )) !== work.input_key
    )
      return;
    const [prepared] = await core.prepareEmbeddingBatch(
      [
        {
          chunkId: work.chunk_id,
          contentHash: work.content_hash,
          text: String(chunk.embedding_input_text),
        },
      ],
      {
        enabled: true,
        provider: new WorkersAIEmbeddingProvider(
          env.AI!,
          env.EMBEDDING_MODEL_REVISION,
        ),
        cache: {
          get: async (key) => {
            const row = await env.DB.prepare(
              "SELECT values_json FROM embedding_cache WHERE key=?",
            )
              .bind(key)
              .first<{ values_json: string }>();
            try {
              return row
                ? Float32Array.from(JSON.parse(row.values_json))
                : null;
            } catch {
              return null;
            }
          },
        },
      },
    );
    if (!prepared) return;
    if (prepared.generated)
      await env.DB.prepare(
        "INSERT OR REPLACE INTO embedding_cache VALUES(?,?,?)",
      )
        .bind(
          work.input_key,
          JSON.stringify(Array.from(prepared.values)),
          Date.now(),
        )
        .run();
    const vectors = new VectorizeStore(
      env.VECTORS,
      metadata,
      env.EMBEDDING_MODEL_REVISION,
    );
    const { namespace, generation } = await vectors.identity();
    const operations = new ProviderOperations();
    let receipt = work.receipt;
    if (!receipt) {
      const mutation = await operations.run(() =>
        env.VECTORS!.upsert([
          {
            id: work.vector_id,
            namespace,
            values: Array.from(prepared.values),
            metadata: {
              chunkId: work.chunk_id,
              contentHash: work.content_hash,
              generation,
              inputKey: work.input_key,
            },
          },
        ]),
      );
      receipt = mutation.mutationId;
    }
    const response = await operations.run(() =>
      env.VECTORS!.query(Array.from(prepared.values), {
        namespace,
        filter: { chunkId: work.chunk_id },
        topK: 100,
        returnValues: false,
        returnMetadata: "none",
      }),
    );
    const visible = response.matches.some((m) => m.id === work.vector_id);
    await env.DB.prepare(
      "UPDATE vector_work SET state=?,receipt=?,error=NULL,retry_at=0 WHERE revision=? AND chunk_id=? AND input_key=? AND vector_id=? AND state<>'ready' AND revision=(SELECT revision FROM deployment WHERE id=1)",
    )
      .bind(
        visible ? "ready" : "pending",
        receipt,
        work.revision,
        work.chunk_id,
        work.input_key,
        work.vector_id,
      )
      .run();
  } catch {
    await env.DB.prepare(
      "UPDATE vector_work SET state='failed',error='EMBEDDING_UNAVAILABLE',retry_at=? WHERE revision=? AND chunk_id=? AND input_key=? AND vector_id=? AND state<>'ready'",
    )
      .bind(
        Date.now() + 60000,
        work.revision,
        work.chunk_id,
        work.input_key,
        work.vector_id,
      )
      .run();
  }
}

/** Only unreferenced, aged immutable objects and vector versions can be reclaimed. */
export async function cleanupIncremental(env: Env) {
  const cutoff = Date.now() - 86400000;
  // Pausing reclamation while a writer prepares avoids reference resurrection races.
  const writer = await env.DB.prepare(
    "SELECT 1 AS busy FROM ingestion_jobs WHERE state NOT IN ('complete','failed','uploading','preparing') LIMIT 1",
  ).first();
  if (writer) return;
  const objects = (
    await env.DB.prepare(
      "SELECT object_key FROM retired_objects WHERE retired<? AND NOT EXISTS(SELECT 1 FROM source_objects o WHERE o.object_key=retired_objects.object_key) AND NOT EXISTS(SELECT 1 FROM sources s LEFT JOIN source_objects o ON o.revision=s.revision AND o.path=s.path WHERE o.object_key IS NULL AND ?||'/'||s.revision||'/'||s.path=retired_objects.object_key) LIMIT 16",
    )
      .bind(cutoff, env.VAULT_ID)
      .all<{ object_key: string }>()
  ).results;
  for (const object of objects) {
    if (!object.object_key.startsWith(`${env.VAULT_ID}/`)) continue;
    await env.SOURCE.delete(object.object_key);
    await env.DB.prepare("DELETE FROM retired_objects WHERE object_key=?")
      .bind(object.object_key)
      .run();
  }
  if (config(env).semantic) {
    const records = (
      await env.DB.prepare(
        "SELECT vector_id FROM retired_vectors WHERE retired<? AND NOT EXISTS(SELECT 1 FROM vector_work w WHERE w.vector_id=retired_vectors.vector_id) LIMIT 16",
      )
        .bind(cutoff)
        .all<{ vector_id: string }>()
    ).results;
    if (records.length) {
      const remaining = await env.VECTORS!.getByIds(
        records.map((r) => r.vector_id),
      );
      if (remaining.length) {
        await env.VECTORS!.deleteByIds(remaining.map((r) => r.id));
        return;
      }
      for (const r of records)
        await env.DB.prepare("DELETE FROM retired_vectors WHERE vector_id=?")
          .bind(r.vector_id)
          .run();
    }
  }
}

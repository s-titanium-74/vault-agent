// Disposable, synthetic-only remote smoke entrypoint. Never deploy this file
// as a vault server. Every test administration route requires the admin token.
import worker from "../src/index.js";
import { authenticate, config, type Env } from "../src/config.js";
import { CloudError, failure } from "../src/errors.js";
import { D1MetadataStore } from "../src/d1.js";
import { VectorizeStore } from "../src/vectorize.js";
import {
  WorkersAIEmbeddingProvider,
  MODEL,
  DIMENSION,
  descriptor,
  ProviderOperations,
} from "../src/provider.js";
import * as core from "@vault-agent/core/portable";
import { fixture, VAULT_ID } from "../scripts/fixture.js";
import initialMigration from "../migrations/0001_retrieval.sql";
import semanticMigration from "../migrations/0002_semantic.sql";

export const multilingualFiles = {
  "Guide/Huerto.md":
    "---\ntitle: Huerto\ntags: [garden]\ntype: guide\nstatus: active\n---\n# Huerto\nCultivar árboles frutales requiere tierra fértil, agua y luz solar. Podar las ramas en invierno.\n",
  "Guide/Fruit-ja.md":
    "---\ntitle: 果樹栽培\ntags: [garden]\ntype: guide\nstatus: active\n---\n# 果樹栽培\n果物の木を育てるには、日当たりのよい場所と水はけのよい土が必要です。冬には枝を剪定します。\n",
  "Guide/Network.md":
    "---\ntitle: Home network\ntags: [technology]\ntype: guide\nstatus: active\n---\n# Networking\nA router connects computers to the internet. Configure Wi-Fi passwords, IP addresses, and DNS servers.\n",
  "Guide/Astronomy.md":
    "---\ntitle: Astronomy\ntags: [science]\ntype: guide\nstatus: active\n---\n# Astronomy\nA telescope observes distant stars, planets, and galaxies in the night sky.\n",
};

export default {
  async fetch(request: Request, env: Env & { SYNTHETIC_SMOKE?: string }) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith("/__smoke/"))
      return worker.fetch(request, env);
    try {
      config(env);
      if (
        url.protocol !== "https:" ||
        env.SYNTHETIC_SMOKE !== "true" ||
        env.VAULT_ID !== VAULT_ID
      )
        throw new CloudError("SMOKE_DISABLED", 403);
      await authenticate(request, env, true);
      if (request.method !== "POST")
        throw new CloudError("METHOD_NOT_ALLOWED", 405);
      const operations = new ProviderOperations();
      const result = await action(url.pathname.slice(9), env, operations);
      return Response.json(
        { ...result, usage: operations.counts },
        { headers: { "Cache-Control": "no-store" } },
      );
    } catch (error) {
      const response = failure(
        error instanceof CloudError ? error.code : "SMOKE_FAILED",
        error instanceof CloudError ? error.status : 503,
      );
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
  },
};

async function action(
  name: string,
  env: Env,
  operations: ProviderOperations,
): Promise<Record<string, unknown>> {
  if (name === "setup") {
    for (const migration of [initialMigration, semanticMigration])
      for (const sql of migration
        .replace(/--[^\n]*/g, "")
        .split(";")
        .filter((s) => s.trim()))
        await env.DB.prepare(sql).run();
    const seed = await fixture(multilingualFiles);
    for (const sql of seed.statements) await env.DB.prepare(sql).run();
    await env.DB.prepare("DELETE FROM deployment").run();
    seed.manifest.embeddingModel = MODEL;
    seed.manifest.embeddingDimension = DIMENSION;
    await env.DB.prepare("UPDATE snapshots SET manifest=? WHERE revision=?")
      .bind(JSON.stringify(seed.manifest), seed.revision)
      .run();
    await env.DB.prepare(
      "INSERT INTO embedding_generations VALUES(?,?,?,'pending')",
    )
      .bind(
        seed.revision,
        await core.contentRevision(
          JSON.stringify(descriptor(env.EMBEDDING_MODEL_REVISION)),
        ),
        JSON.stringify(descriptor(env.EMBEDDING_MODEL_REVISION)),
      )
      .run();
    await env.DB.prepare(
      "CREATE TABLE smoke_vectors (chunk_id TEXT PRIMARY KEY, content_hash TEXT NOT NULL, values_json TEXT NOT NULL)",
    ).run();
    for (const object of seed.objects)
      await env.SOURCE.put(object.key, object.content);
    return {
      revision: seed.revision,
      notes: seed.notes.length,
      chunks: seed.chunks.length,
      objects: seed.objects.length,
    };
  }
  const snapshot = await env.DB.prepare(
    "SELECT revision,manifest FROM snapshots LIMIT 1",
  ).first<{ revision: string; manifest: string }>();
  if (!snapshot) throw new CloudError("INDEX_NOT_FOUND", 409);
  const metadata = new D1MetadataStore(
    env.DB,
    env.VAULT_ID,
    snapshot.revision,
    JSON.parse(snapshot.manifest),
    core.sourcePolicy(["."]),
  );
  const vectors = new VectorizeStore(
    env.VECTORS,
    metadata,
    env.EMBEDDING_MODEL_REVISION,
    operations,
  );
  if (name === "visibility-cycle" || name === "visibility-probe") {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS smoke_control (key TEXT PRIMARY KEY,value TEXT NOT NULL)",
    ).run();
    let stage: string;
    let started: number;
    const rows = await env.DB.prepare(
      "SELECT * FROM smoke_vectors ORDER BY chunk_id LIMIT 16",
    ).all<{ chunk_id: string; content_hash: string; values_json: string }>();
    const entries = rows.results.map((row) => ({
      chunkId: row.chunk_id,
      contentHash: row.content_hash,
      values: Float32Array.from(JSON.parse(row.values_json)),
    }));
    if (name === "visibility-cycle") {
      stage = await core.contentRevision(crypto.randomUUID());
      const { generation } = await vectors.identity();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO snapshots SELECT ?,vault_id,manifest,note_count,chunk_count,entry_count,indexed_bytes FROM snapshots WHERE revision=?",
        ).bind(stage, snapshot.revision),
        env.DB.prepare(
          "INSERT INTO notes SELECT ?,note_id,path,data FROM notes WHERE revision=?",
        ).bind(stage, snapshot.revision),
        env.DB.prepare(
          "INSERT INTO chunks SELECT ?,chunk_id,note_id,chunk_index,data FROM chunks WHERE revision=?",
        ).bind(stage, snapshot.revision),
        env.DB.prepare(
          "INSERT INTO embedding_generations VALUES(?,?,?,'pending')",
        ).bind(
          stage,
          generation,
          JSON.stringify(descriptor(env.EMBEDDING_MODEL_REVISION)),
        ),
        env.DB.prepare(
          "INSERT OR REPLACE INTO smoke_control VALUES('stage',?)",
        ).bind(stage),
      ]);
      const stagedMetadata = new D1MetadataStore(
        env.DB,
        env.VAULT_ID,
        stage,
        metadata.manifest,
        core.sourcePolicy(["."]),
      );
      const stagedVectors = new VectorizeStore(
        env.VECTORS,
        stagedMetadata,
        env.EMBEDDING_MODEL_REVISION,
        operations,
      );
      started = Date.now();
      const receipt = await stagedVectors.upsert(entries);
      await env.DB.prepare(
        "INSERT OR REPLACE INTO smoke_control VALUES('started',?)",
      )
        .bind(String(started))
        .run();
      return {
        mutationState: receipt.state,
        ready: await stagedVectors.visible(entries),
        elapsedMs: Date.now() - started,
      };
    }
    const stageRow = await env.DB.prepare(
      "SELECT value FROM smoke_control WHERE key='stage'",
    ).first<{ value: string }>();
    const startRow = await env.DB.prepare(
      "SELECT value FROM smoke_control WHERE key='started'",
    ).first<{ value: string }>();
    if (!stageRow || !startRow) throw new CloudError("INDEX_NOT_FOUND", 409);
    stage = stageRow.value;
    started = Number(startRow.value);
    const stagedMetadata = new D1MetadataStore(
      env.DB,
      env.VAULT_ID,
      stage,
      metadata.manifest,
      core.sourcePolicy(["."]),
    );
    const stagedVectors = new VectorizeStore(
      env.VECTORS,
      stagedMetadata,
      env.EMBEDDING_MODEL_REVISION,
      operations,
    );
    return {
      ready: await stagedVectors.visible(entries),
      elapsedMs: Date.now() - started,
    };
  }
  if (name === "stats") {
    const details = await env.VECTORS!.describe();
    return { vectorCount: details.vectorCount, dimensions: details.dimensions };
  }
  if (name === "embed") {
    const chunks = (
      await metadata.rows(
        "SELECT data FROM chunks WHERE revision=? ORDER BY chunk_id LIMIT 16",
        [snapshot.revision],
      )
    ).map((row) => metadata.decode(row));
    const provider = new WorkersAIEmbeddingProvider(
      env.AI!,
      env.EMBEDDING_MODEL_REVISION,
      operations,
    );
    const embedded = await provider.embed(
      chunks.map((c) => String(c.embedding_input_text)),
    );
    const entries = chunks.map((c, i) => ({
      chunkId: String(c.chunk_id),
      contentHash: String(c.content_hash),
      values: embedded.embeddings[i]!,
    }));
    const receipt = await vectors.upsert(entries);
    for (const entry of entries)
      await env.DB.prepare("INSERT OR REPLACE INTO smoke_vectors VALUES(?,?,?)")
        .bind(
          entry.chunkId,
          entry.contentHash,
          JSON.stringify(Array.from(entry.values)),
        )
        .run();
    return {
      chunks: chunks.length,
      dimension: embedded.dimension,
      mutationState: receipt.state,
    };
  }
  if (name === "probe") {
    const rows = await env.DB.prepare(
      "SELECT * FROM smoke_vectors ORDER BY chunk_id LIMIT 16",
    ).all<{ chunk_id: string; content_hash: string; values_json: string }>();
    const entries = rows.results.map((row) => ({
      chunkId: row.chunk_id,
      contentHash: row.content_hash,
      values: Float32Array.from(JSON.parse(row.values_json)),
    }));
    const ready = await vectors.visible(entries);
    if (ready)
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE embedding_generations SET state='ready' WHERE revision=?",
        ).bind(snapshot.revision),
        env.DB.prepare("INSERT OR REPLACE INTO deployment VALUES(1,?)").bind(
          snapshot.revision,
        ),
      ]);
    return { ready, checked: entries.length };
  }
  if (name === "pending" || name === "ready") {
    await env.DB.prepare(
      "UPDATE embedding_generations SET state=? WHERE revision=?",
    )
      .bind(name, snapshot.revision)
      .run();
    return { state: name };
  }
  if (name === "incompatible" || name === "compatible") {
    await env.DB.prepare(
      "UPDATE embedding_generations SET generation=? WHERE revision=?",
    )
      .bind(
        name === "incompatible"
          ? "0".repeat(64)
          : (await vectors.identity()).generation,
        snapshot.revision,
      )
      .run();
    return { compatible: name === "compatible" };
  }
  if (name === "revoke") {
    const note = await env.DB.prepare(
      "SELECT note_id FROM notes WHERE revision=? AND path='Guide/Network.md'",
    )
      .bind(snapshot.revision)
      .first<{ note_id: string }>();
    if (!note) throw new CloudError("NOTE_NOT_FOUND", 404);
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM grams WHERE revision=? AND chunk_id IN (SELECT chunk_id FROM chunks WHERE revision=? AND note_id=?)",
      ).bind(snapshot.revision, snapshot.revision, note.note_id),
      env.DB.prepare("DELETE FROM chunks WHERE revision=? AND note_id=?").bind(
        snapshot.revision,
        note.note_id,
      ),
      env.DB.prepare("DELETE FROM notes WHERE revision=? AND note_id=?").bind(
        snapshot.revision,
        note.note_id,
      ),
      env.DB.prepare(
        "DELETE FROM sources WHERE revision=? AND path='Guide/Network.md'",
      ).bind(snapshot.revision),
    ]);
    return { revokedNoteId: note.note_id };
  }
  if (name === "dimension-error") {
    let rejected = false;
    try {
      await env.VECTORS!.query(new Float32Array(768).fill(1), { topK: 1 });
    } catch {
      rejected = true;
    }
    return { rejected };
  }
  if (name === "clear-source") {
    const listing = await env.SOURCE.list({
      prefix: `${VAULT_ID}/`,
      limit: 100,
    });
    if (listing.truncated) throw new CloudError("SMOKE_BUDGET_EXCEEDED", 413);
    if (listing.objects.length)
      await env.SOURCE.delete(listing.objects.map((o) => o.key));
    return { deleted: listing.objects.length };
  }
  throw new CloudError("NOT_FOUND", 404);
}

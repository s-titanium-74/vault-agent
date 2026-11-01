import * as core from "@vault-agent/core/portable";
import { config, type Env } from "./config.js";
import { boundedBytes, CloudError } from "./errors.js";
import { descriptor } from "./provider.js";
import { D1MetadataStore, ftsName } from "./d1.js";
import { VectorizeStore } from "./vectorize.js";

export type ScanEntry = {
  path: string;
  kind: core.SourceKind;
  size: number;
  digest: string | null;
  etag: string | null;
  updated: string;
  object_version?: string | null;
};
type Staged = { key: string; note?: core.IndexRow; chunks?: core.IndexRow[] };
export const DELTA_MAX_BYTES = 512 * 1024;
export const DELTA_MAX_STATEMENTS = 80;
export const DELTA_MAX_GRAMS = 8000;

export async function publication(env: Env) {
  return env.DB.prepare(
    "SELECT d.revision AS store,coalesce(p.snapshot,d.revision) AS snapshot,coalesce(p.epoch,0) AS epoch FROM deployment d LEFT JOIN publications p ON p.store=d.revision WHERE d.id=1",
  ).first<{ store: string; snapshot: string; epoch: number }>();
}

export async function stageDeltaFile(
  env: Env,
  job: string,
  store: string,
  entry: ScanEntry,
) {
  if (!config(env).allowed(entry.path))
    throw new CloudError("SOURCE_EXCLUDED", 403);
  const object = await env.SOURCE.get(`${env.VAULT_ID}/source/${entry.path}`, {
    onlyIf: { etagMatches: entry.etag! },
  });
  if (
    !object ||
    !("body" in object) ||
    object.size !== entry.size ||
    (entry.object_version && object.version !== entry.object_version) ||
    object.customMetadata?.deleted === "true"
  )
    throw new CloudError("REVISION_CONFLICT", 409);
  const bytes = await boundedBytes(object.body, core.uploadLimit(entry.kind));
  const digest = await core.contentRevision(bytes);
  const old = await env.DB.prepare(
    "SELECT digest FROM sources WHERE revision=? AND path=? AND kind=?",
  )
    .bind(store, entry.path, entry.kind)
    .first<{ digest: string }>();
  const statements: D1PreparedStatement[] = [];
  if (old?.digest !== digest) {
    const staged: Staged = {
      key: `${env.VAULT_ID}/${store}/.updates/${job}/${entry.path}`,
    };
    if (entry.kind !== "attachment") {
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new CloudError("SOURCE_NOT_UTF8", 409);
      }
      if (entry.kind === "note") {
        const prepared = await core.prepareNoteUpdate(
          { ...entry, revision: digest },
          null,
          async () => text,
        );
        if (prepared.action !== "upsert")
          throw new CloudError("INDEX_INCOMPATIBLE", 409);
        if (
          jsonBytes(prepared.note) > 262144 ||
          prepared.chunks.some((c) => jsonBytes(c) > 262144) ||
          jsonBytes(prepared.chunks) > 1048576
        )
          throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
        staged.note = prepared.note;
        staged.chunks = prepared.chunks;
      }
    }
    await env.SOURCE.put(staged.key, bytes, { sha256: digest });
    statements.push(
      env.DB.prepare(
        "INSERT OR REPLACE INTO prepared_deltas VALUES(?,?,?)",
      ).bind(job, entry.path, JSON.stringify(staged)),
      env.DB.prepare("INSERT OR REPLACE INTO retired_objects VALUES(?,?)").bind(
        staged.key,
        Date.now(),
      ),
    );
  }
  statements.push(
    env.DB.prepare(
      "UPDATE ingestion_entries SET processed=1,digest=? WHERE job=? AND path=?",
    ).bind(digest, job, entry.path),
  );
  return { statements, reused: old?.digest === digest };
}
export const jsonBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;

/** Read staged inputs, build shared row deltas, then return a bounded publication batch. */
export async function prepareDeltaCommit(
  env: Env,
  job: string,
  store: string,
  manifest: core.IndexManifest,
  semantic: boolean,
) {
  ftsName(store);
  const [notes, chunks, sourceRows, stagedRows, entryRows] = await Promise.all([
    env.DB.prepare("SELECT data FROM notes WHERE revision=? ORDER BY note_id")
      .bind(store)
      .all<{ data: string }>(),
    env.DB.prepare("SELECT data FROM chunks WHERE revision=? ORDER BY chunk_id")
      .bind(store)
      .all<{ data: string }>(),
    env.DB.prepare(
      "SELECT s.*,o.object_key,v.digest AS observed_digest,v.etag AS observed_etag,v.object_version AS observed_version FROM sources s LEFT JOIN source_objects o ON o.revision=s.revision AND o.path=s.path LEFT JOIN source_observations v ON v.revision=s.revision AND v.path=s.path WHERE s.revision=?",
    )
      .bind(store)
      .all<
        ScanEntry & {
          object_key: string | null;
          observed_digest: string | null;
          observed_etag: string | null;
          observed_version: string | null;
        }
      >(),
    env.DB.prepare("SELECT path,data FROM prepared_deltas WHERE job=?")
      .bind(job)
      .all<{ path: string; data: string }>(),
    env.DB.prepare("SELECT * FROM ingestion_entries WHERE job=? ORDER BY path")
      .bind(job)
      .all<ScanEntry>(),
  ]);
  const beforeNotes = notes.results.map(
    (r) => JSON.parse(r.data) as core.IndexRow,
  );
  const beforeChunks = chunks.results.map(
    (r) => JSON.parse(r.data) as core.IndexRow,
  );
  const before = new Map(beforeNotes.map((r) => [String(r.path), r]));
  const sources = new Map(sourceRows.results.map((r) => [r.path, r]));
  const staged = new Map(
    stagedRows.results.map((r) => [r.path, JSON.parse(r.data) as Staged]),
  );
  const entries = new Map(entryRows.results.map((r) => [r.path, r]));
  const targetNotes: core.IndexRow[] = [],
    targetChunks: core.IndexRow[] = [];
  for (const entry of entries.values()) {
    if (entry.kind !== "note") continue;
    const prepared = staged.get(entry.path);
    if (prepared?.note) {
      targetNotes.push(prepared.note);
      targetChunks.push(...prepared.chunks!);
    } else {
      const old = before.get(entry.path);
      if (!old || entry.digest !== old.content_hash)
        throw new CloudError("REVISION_CONFLICT", 409);
      const update = await core.prepareNoteUpdate(
        { ...entry, revision: entry.digest! },
        old,
        async () => {
          throw new CloudError("REVISION_CONFLICT", 409);
        },
      );
      targetNotes.push(update.note);
      targetChunks.push(
        ...beforeChunks.filter((c) => c.note_id === old.note_id),
      );
    }
  }
  const resolve = core.createIndexLinkResolver(targetNotes);
  const linked = targetNotes.map(resolve);
  const nd = core.prepareIndexDelta(beforeNotes, linked, "note_id");
  const cd = core.prepareIndexDelta(beforeChunks, targetChunks, "chunk_id");
  const indexedBytes = [...linked, ...targetChunks].reduce(
    (n, r) => n + jsonBytes(r),
    0,
  );
  if (
    linked.length > 500 ||
    targetChunks.length > 2000 ||
    entries.size > 500 ||
    indexedBytes > 16 * 1024 * 1024
  )
    throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
  manifest.noteCount = linked.length;
  manifest.chunkCount = targetChunks.length;
  const statements: D1PreparedStatement[] = [];
  let grams = 0,
    bytes = 0;
  const lexicalInserts: D1PreparedStatement[] = [];
  const vectors = new VectorizeStore(
    env.VECTORS,
    new D1MetadataStore(
      env.DB,
      env.VAULT_ID,
      store,
      manifest,
      config(env).allowed,
      true,
    ),
    env.EMBEDDING_MODEL_REVISION,
  );
  // Only rows with changed lexical input need FTS/gram writes.
  const priorChunks = new Map(beforeChunks.map((r) => [String(r.chunk_id), r]));
  for (const c of [...cd.removals, ...cd.upserts]) {
    const id = String(c.chunk_id),
      old = priorChunks.get(id);
    const removed = cd.removals.includes(c);
    if (removed || old?.lexical_text !== c.lexical_text) {
      statements.push(
        env.DB.prepare(`DELETE FROM fts_${store} WHERE chunk_id=?`).bind(id),
        env.DB.prepare(
          "DELETE FROM grams WHERE revision=? AND chunk_id=?",
        ).bind(store, id),
      );
      if (!removed) {
        const terms = core.textToTrigrams(String(c.lexical_text));
        grams += terms.length;
        lexicalInserts.push(
          env.DB.prepare(
            `INSERT INTO fts_${store}(chunk_id,lexical_text) VALUES(?,?)`,
          ).bind(id, c.lexical_text),
          env.DB.prepare(
            "INSERT INTO grams SELECT ?,?,value FROM json_each(?)",
          ).bind(store, id, JSON.stringify(terms)),
        );
      }
    }
    if (
      semantic &&
      (removed ||
        !old ||
        old.embedding_input_text !== c.embedding_input_text ||
        old.content_hash !== c.content_hash)
    ) {
      const work = await env.DB.prepare(
        "SELECT vector_id FROM vector_work WHERE revision=? AND chunk_id=?",
      )
        .bind(store, id)
        .first<{ vector_id: string }>();
      if (old)
        statements.push(
          env.DB.prepare(
            "INSERT OR REPLACE INTO retired_vectors VALUES(?,?)",
          ).bind(work?.vector_id ?? (await vectors.id(id)), Date.now()),
        );
      statements.push(
        env.DB.prepare(
          "DELETE FROM ingestion_vectors WHERE revision=? AND chunk_id=?",
        ).bind(store, id),
        env.DB.prepare(
          "DELETE FROM vector_work WHERE revision=? AND chunk_id=?",
        ).bind(store, id),
      );
      if (!removed) {
        const key = await core.embeddingInputKey(
          descriptor(env.EMBEDDING_MODEL_REVISION),
          String(c.embedding_input_text),
        );
        statements.push(
          env.DB.prepare(
            "INSERT INTO vector_work(revision,chunk_id,input_key,content_hash,vector_id,state) VALUES(?,?,?,?,?,'pending')",
          ).bind(
            store,
            id,
            key,
            c.content_hash,
            await vectors.id(id, key, job),
          ),
        );
      }
    }
    if (removed)
      statements.push(
        env.DB.prepare(
          "DELETE FROM chunks WHERE revision=? AND chunk_id=?",
        ).bind(store, id),
      );
  }
  for (const n of nd.removals)
    statements.push(
      env.DB.prepare("DELETE FROM notes WHERE revision=? AND note_id=?").bind(
        store,
        n.note_id,
      ),
    );
  for (const n of nd.upserts) {
    bytes += jsonBytes(n);
    statements.push(
      env.DB.prepare(
        "INSERT INTO notes VALUES(?,?,?,?) ON CONFLICT(revision,note_id) DO UPDATE SET path=excluded.path,data=excluded.data",
      ).bind(store, n.note_id, n.path, JSON.stringify(n)),
    );
  }
  for (const c of cd.upserts) {
    bytes += jsonBytes(c);
    statements.push(
      env.DB.prepare(
        "INSERT INTO chunks VALUES(?,?,?,?,?) ON CONFLICT(revision,chunk_id) DO UPDATE SET note_id=excluded.note_id,chunk_index=excluded.chunk_index,data=excluded.data",
      ).bind(store, c.chunk_id, c.note_id, c.chunk_index, JSON.stringify(c)),
    );
  }
  statements.push(...lexicalInserts);
  for (const path of new Set([...sources.keys(), ...entries.keys()])) {
    const old = sources.get(path),
      entry = entries.get(path),
      change = staged.get(path);
    if (
      entry &&
      old &&
      core.indexRowsEqual(
        [old.kind, old.size, old.digest, old.updated],
        [entry.kind, entry.size, entry.digest, entry.updated],
      )
    )
      continue;
    const oldKey =
      old?.object_key ?? (old ? `${env.VAULT_ID}/${store}/${path}` : null);
    if (oldKey && (!entry || change))
      statements.push(
        env.DB.prepare(
          "DELETE FROM source_observations WHERE revision=? AND path=?",
        ).bind(store, path),
        env.DB.prepare(
          "INSERT OR REPLACE INTO retired_objects VALUES(?,?)",
        ).bind(oldKey, Date.now()),
      );
    if (!entry)
      statements.push(
        env.DB.prepare(
          "DELETE FROM source_objects WHERE revision=? AND path=?",
        ).bind(store, path),
        env.DB.prepare("DELETE FROM sources WHERE revision=? AND path=?").bind(
          store,
          path,
        ),
      );
    else {
      statements.push(
        env.DB.prepare(
          "INSERT INTO sources VALUES(?,?,?,?,?,?) ON CONFLICT(revision,path) DO UPDATE SET kind=excluded.kind,size=excluded.size,digest=excluded.digest,updated=excluded.updated",
        ).bind(
          store,
          path,
          entry.kind,
          entry.size,
          entry.digest,
          entry.updated,
        ),
      );
      if (change)
        statements.push(
          env.DB.prepare(
            "INSERT INTO source_objects VALUES(?,?,?) ON CONFLICT(revision,path) DO UPDATE SET object_key=excluded.object_key",
          ).bind(store, path, change.key),
        );
    }
  }
  const observations = entryRows.results
    .filter((e) => {
      const old = sources.get(e.path);
      return (
        e.object_version &&
        (!old ||
          old.observed_version !== e.object_version ||
          old.observed_etag !== e.etag ||
          old.observed_digest !== e.digest)
      );
    })
    .map((e) => ({
      path: e.path,
      digest: e.digest,
      etag: e.etag,
      version: e.object_version,
    }));
  if (observations.length) {
    bytes += jsonBytes(observations);
    statements.push(
      env.DB.prepare(
        "INSERT INTO source_observations(revision,path,digest,etag,object_version) SELECT ?,json_extract(value,'$.path'),json_extract(value,'$.digest'),json_extract(value,'$.etag'),json_extract(value,'$.version') FROM json_each(?) WHERE true ON CONFLICT(revision,path) DO UPDATE SET digest=excluded.digest,etag=excluded.etag,object_version=excluded.object_version",
      ).bind(store, JSON.stringify(observations)),
    );
  }
  statements.push(
    env.DB.prepare(
      "UPDATE snapshots SET manifest=?,note_count=?,chunk_count=?,entry_count=?,indexed_bytes=? WHERE revision=?",
    ).bind(
      JSON.stringify(manifest),
      linked.length,
      targetChunks.length,
      entries.size,
      indexedBytes,
      store,
    ),
  );
  return {
    statements,
    fits:
      bytes <= DELTA_MAX_BYTES &&
      grams <= DELTA_MAX_GRAMS &&
      statements.length + 8 <= DELTA_MAX_STATEMENTS,
    changedNotes: nd.upserts.length,
    changedChunks: cd.upserts.length,
  };
}

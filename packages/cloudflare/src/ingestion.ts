import * as core from "@vault-agent/core/portable";
import { config, type Env } from "./config.js";
import { CloudError, boundedBytes } from "./errors.js";
import { D1MetadataStore } from "./d1.js";
import { VectorizeStore } from "./vectorize.js";
import {
  WorkersAIEmbeddingProvider,
  descriptor,
  MODEL,
  DIMENSION,
} from "./provider.js";

type Data = {
  revision: string;
  parent: string | null;
  cursor?: string;
  signature?: string;
  manifest: core.IndexManifest;
  includes?: string[];
  deletes?: string[];
  requireEmbeddings?: boolean;
  force?: boolean;
  semantic?: boolean;
  embeddingError?: boolean;
  chunkCursor?: string;
  linkCursor?: string;
  vectorCursor?: string;
  validateCursor?: string;
  policy?: string;
  filesAccepted?: number;
  filesProcessed?: number;
  chunksProcessed?: number;
  notesSkipped?: number;
};
type Job = {
  id: string;
  kind: string;
  state: string;
  checkpoint: number;
  data: string;
  created: number;
  error: string | null;
  lease: string | null;
};
type Entry = {
  path: string;
  kind: core.SourceKind;
  size: number;
  digest: string | null;
  etag: string | null;
  updated: string;
  processed: number;
};
export const ingestionEnabled = (env: Env) =>
  String(env.INGESTION_ENABLED) === "true";
export const sourcePrefix = (env: Env) => `${env.VAULT_ID}/source/`;
const active = async (env: Env) =>
  (
    await env.DB.prepare("SELECT revision FROM deployment WHERE id=1").first<{
      revision: string;
    }>()
  )?.revision ?? null;
const revisionPattern = /^[a-f0-9]{64}$/;
const uuidPattern =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
function assertId(id: string) {
  if (!uuidPattern.test(id)) throw new CloudError("INVALID_PARAMETER");
}
export async function getJob(env: Env, id: string) {
  assertId(id);
  const row = await env.DB.prepare("SELECT * FROM ingestion_jobs WHERE id=?")
    .bind(id)
    .first<Job>();
  if (!row) throw new CloudError("JOB_NOT_FOUND", 404);
  return row;
}
function publicJob(row: Job) {
  const d = JSON.parse(row.data) as Data;
  return {
    jobId: row.id,
    state: row.state,
    checkpoint: row.checkpoint,
    parentRevision: d.parent,
    targetRevision: d.revision,
    retryAfterMs: 1000,
    error: row.error ? { code: row.error } : null,
    cleanupPending: true,
    filesAccepted: d.filesAccepted ?? 0,
    filesProcessed: d.filesProcessed ?? 0,
    chunksProcessed: d.chunksProcessed ?? 0,
    mode: d.force ? "full" : "incremental",
    notesIndexed: d.manifest.noteCount,
    chunksIndexed: d.manifest.chunkCount,
    notesSkipped: d.notesSkipped ?? 0,
    warningCount: d.embeddingError ? 1 : 0,
  };
}
export async function jobStatus(env: Env, id: string) {
  return publicJob(await getJob(env, id));
}
function emptyManifest(env: Env): core.IndexManifest {
  return {
    schemaVersion: core.INDEX_SCHEMA_VERSION,
    vaultIdentity: env.VAULT_ID,
    indexedFileExtensions: [".md", ".markdown"],
    effectiveExcludePatterns: [
      ...core.DEFAULT_EXCLUDE_PATTERNS,
      ...JSON.parse(env.EXCLUDE_PATHS),
    ],
    targetChunkSize: core.TARGET_CHUNK_SIZE,
    maxChunkSize: core.MAX_CHUNK_SIZE,
    embeddingModel: null,
    embeddingDimension: null,
    noteCount: 0,
    chunkCount: 0,
    indexedAt: Date.now(),
  };
}
async function policyDigest(env: Env) {
  return core.contentRevision(
    JSON.stringify([
      "ingestion-v1",
      env.INCLUDE_PATHS,
      env.EXCLUDE_PATHS,
      config(env).semantic,
      descriptor(env.EMBEDDING_MODEL_REVISION),
      core.INDEX_SCHEMA_VERSION,
      core.TARGET_CHUNK_SIZE,
      core.MAX_CHUNK_SIZE,
    ]),
  );
}
async function newData(env: Env, parent: string | null): Promise<Data> {
  return {
    revision: await core.contentRevision(crypto.randomUUID()),
    parent,
    manifest: emptyManifest(env),
    semantic: config(env).semantic,
    policy: await policyDigest(env),
  };
}
async function insertJob(
  env: Env,
  id: string,
  hash: string,
  kind: string,
  state: string,
  data: Data,
) {
  await env.DB.prepare(
    "INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,created) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING",
  )
    .bind(id, hash, kind, state, JSON.stringify(data), Date.now())
    .run();
  const job = await getJob(env, id);
  if (
    (
      await env.DB.prepare("SELECT request_hash FROM ingestion_jobs WHERE id=?")
        .bind(id)
        .first<{ request_hash: string }>()
    )?.request_hash !== hash
  )
    throw new CloudError("IDEMPOTENCY_CONFLICT", 409);
  return job;
}
const jsonSize = (v: unknown) =>
  new TextEncoder().encode(JSON.stringify(v)).length;
function checkedEntry(value: unknown, allowed: (p: string) => boolean): Entry {
  if (!value || typeof value !== "object")
    throw new CloudError("INVALID_PARAMETER");
  const e = value as Record<string, unknown>;
  if (typeof e.path !== "string" || e.path.length > 512 || !allowed(e.path))
    throw new CloudError("SOURCE_EXCLUDED", 403);
  const kind = core.uploadKind(e.path);
  if (
    !kind ||
    kind !== e.kind ||
    !Number.isSafeInteger(e.size) ||
    Number(e.size) < 0 ||
    Number(e.size) > core.uploadLimit(kind)
  )
    throw new CloudError("UPLOAD_TOO_LARGE", 413);
  if (
    typeof e.digest !== "string" ||
    !revisionPattern.test(e.digest) ||
    typeof e.updated !== "string" ||
    !Number.isFinite(Date.parse(e.updated))
  )
    throw new CloudError("INVALID_PARAMETER");
  return {
    path: e.path,
    kind,
    size: Number(e.size),
    digest: e.digest,
    etag: null,
    updated: e.updated,
    processed: 0,
  };
}
export async function createUpload(env: Env, id: string, input: unknown) {
  assertId(id);
  const p = input as {
    vaultId?: unknown;
    parentRevision?: unknown;
    includes?: unknown;
    entries?: unknown;
    deletes?: unknown;
    requireEmbeddings?: unknown;
  };
  if (
    !p ||
    p.vaultId !== env.VAULT_ID ||
    !Array.isArray(p.includes) ||
    !p.includes.length ||
    p.includes.length > 100 ||
    p.includes.some((v) => typeof v !== "string") ||
    !Array.isArray(p.entries) ||
    p.entries.length > 100 ||
    !Array.isArray(p.deletes) ||
    p.deletes.length > 100 ||
    p.entries.length + p.deletes.length > 100 ||
    (p.requireEmbeddings !== undefined &&
      typeof p.requireEmbeddings !== "boolean")
  )
    throw new CloudError("INVALID_PARAMETER");
  if (
    p.parentRevision !== null &&
    (typeof p.parentRevision !== "string" ||
      !revisionPattern.test(p.parentRevision))
  )
    throw new CloudError("INVALID_PARAMETER");
  const hash = await core.contentRevision(JSON.stringify(input));
  const existing = await env.DB.prepare(
    "SELECT id,request_hash FROM ingestion_jobs WHERE id=?",
  )
    .bind(id)
    .first<{ request_hash: string }>();
  if (existing) {
    if (existing.request_hash !== hash)
      throw new CloudError("IDEMPOTENCY_CONFLICT", 409);
    const prior = await getJob(env, id);
    if (prior.state !== "preparing") return publicJob(prior);
  }
  const includes = p.includes as string[];
  const scope = core.sourcePolicy(includes);
  const policy = config(env).allowed;
  const allowed = (path: string) => scope(path) && policy(path);
  const entries = p.entries.map((e) => checkedEntry(e, allowed));
  const deletes = p.deletes.map((path) => {
    if (typeof path !== "string" || !allowed(path) || !core.uploadKind(path))
      throw new CloudError("SOURCE_EXCLUDED", 403);
    return path;
  });
  if (
    new Set([...entries.map((e) => e.path), ...deletes]).size !==
    entries.length + deletes.length
  )
    throw new CloudError("INVALID_PARAMETER");
  if ((await active(env)) !== p.parentRevision)
    throw new CloudError("REVISION_CONFLICT", 409);
  const data = await newData(env, p.parentRevision as string | null);
  data.includes = includes;
  data.deletes = deletes;
  data.requireEmbeddings = p.requireEmbeddings === true;
  if (data.requireEmbeddings && !data.semantic)
    throw new CloudError("EMBEDDING_UNAVAILABLE", 503);
  data.filesAccepted = entries.length + deletes.length;
  // Capture preconditions before acknowledging intent. Creation is bounded to 100 files.
  for (const entry of entries)
    entry.etag =
      (await env.SOURCE.head(sourcePrefix(env) + entry.path))?.etag ?? null;
  const deleteEntries: Entry[] = [];
  for (const path of deletes) {
    const obj = await env.SOURCE.head(sourcePrefix(env) + path);
    deleteEntries.push({
      path,
      kind: core.uploadKind(path)!,
      size: 0,
      digest: null,
      etag: obj?.etag ?? null,
      updated: "1970-01-01T00:00:00.000Z",
      processed: 0,
    });
  }
  const job = await insertJob(env, id, hash, "upload", "preparing", data);
  if (job.state === "preparing") {
    await env.DB.batch([
      ...[...entries, ...deleteEntries].map((e) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO ingestion_entries(job,path,kind,size,digest,etag,updated) VALUES(?,?,?,?,?,?,?)",
        ).bind(id, e.path, e.kind, e.size, e.digest, e.etag, e.updated),
      ),
      env.DB.prepare(
        "UPDATE ingestion_jobs SET state='uploading' WHERE id=? AND state='preparing'",
      ).bind(id),
    ]);
  }
  return jobStatus(env, id);
}
export async function addManifest(env: Env, id: string, input: unknown) {
  // Additional immutable pages are keyed by their exact path/descriptor values.
  const job = await getJob(env, id);
  if (job.state !== "uploading") throw new CloudError("JOB_SEALED", 409);
  const d = JSON.parse(job.data) as Data;
  const scope = core.sourcePolicy(d.includes!);
  const policy = config(env).allowed;
  const page = input as { entries?: unknown; deletes?: unknown };
  if (
    !page ||
    !Array.isArray(page.entries) ||
    !Array.isArray(page.deletes) ||
    page.entries.length + page.deletes.length > 100
  )
    throw new CloudError("INVALID_PARAMETER");
  const allowed = (p: string) => scope(p) && policy(p);
  const entries = page.entries.map((e) => checkedEntry(e, allowed));
  for (const path of page.deletes) {
    if (typeof path !== "string" || !allowed(path) || !core.uploadKind(path))
      throw new CloudError("SOURCE_EXCLUDED", 403);
    entries.push({
      path,
      kind: core.uploadKind(path)!,
      size: 0,
      digest: null,
      etag: null,
      updated: "1970-01-01T00:00:00.000Z",
      processed: 0,
    });
  }
  if (new Set(entries.map((e) => e.path)).size !== entries.length)
    throw new CloudError("INVALID_PARAMETER");
  const count = await env.DB.prepare(
    "SELECT count(*) AS n FROM ingestion_entries WHERE job=?",
  )
    .bind(id)
    .first<{ n: number }>();
  if (count!.n > 500) throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
  for (const e of entries) {
    const existing = await env.DB.prepare(
      "SELECT * FROM ingestion_entries WHERE job=? AND path=?",
    )
      .bind(id, e.path)
      .first<Entry>();
    if (existing) {
      if (
        existing.digest !== e.digest ||
        existing.size !== e.size ||
        existing.updated !== e.updated
      )
        throw new CloudError("IDEMPOTENCY_CONFLICT", 409);
      continue;
    }
    const total = await env.DB.prepare(
      "SELECT count(*) AS n FROM ingestion_entries WHERE job=?",
    )
      .bind(id)
      .first<{ n: number }>();
    if (total!.n >= 500) throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
    e.etag = (await env.SOURCE.head(sourcePrefix(env) + e.path))?.etag ?? null;
    await env.DB.prepare(
      "INSERT INTO ingestion_entries(job,path,kind,size,digest,etag,updated) SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM ingestion_jobs WHERE id=? AND state='uploading')",
    )
      .bind(id, e.path, e.kind, e.size, e.digest, e.etag, e.updated, id)
      .run();
  }
  await env.DB.prepare(
    "UPDATE ingestion_jobs SET data=json_set(data,'$.filesAccepted',(SELECT count(*) FROM ingestion_entries WHERE job=?)) WHERE id=? AND state='uploading'",
  )
    .bind(id, id)
    .run();
  return jobStatus(env, id);
}
export async function uploadFile(
  env: Env,
  id: string,
  path: string,
  request: Request,
) {
  const job = await getJob(env, id);
  if (job.state !== "uploading") throw new CloudError("JOB_SEALED", 409);
  core.canonicalSourcePath(path);
  if (!config(env).allowed(path)) throw new CloudError("SOURCE_EXCLUDED", 403);
  const e = await env.DB.prepare(
    "SELECT * FROM ingestion_entries WHERE job=? AND path=? AND digest IS NOT NULL",
  )
    .bind(id, path)
    .first<Entry>();
  if (!e || !request.body) throw new CloudError("INVALID_PARAMETER");
  const bytes = await boundedBytes(request.body, core.uploadLimit(e.kind));
  if (
    bytes.length !== e.size ||
    (await core.contentRevision(bytes)) !== e.digest
  )
    throw new CloudError("SOURCE_REVISION_MISMATCH", 409);
  await env.SOURCE.put(`${env.VAULT_ID}/staging/${id}/${path}`, bytes, {
    sha256: e.digest!,
  });
  await env.DB.prepare(
    "UPDATE ingestion_entries SET processed=1 WHERE job=? AND path=? AND EXISTS(SELECT 1 FROM ingestion_jobs WHERE id=? AND state='uploading')",
  )
    .bind(id, path, id)
    .run();
  return jobStatus(env, id);
}
export async function commitUpload(env: Env, id: string) {
  const job = await getJob(env, id);
  if (job.state === "uploading") {
    const missing = await env.DB.prepare(
      "SELECT path FROM ingestion_entries WHERE job=? AND digest IS NOT NULL AND processed=0 LIMIT 1",
    )
      .bind(id)
      .first();
    if (missing) throw new CloudError("UPLOAD_INCOMPLETE", 409);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE ingestion_entries SET processed=0 WHERE job=? AND EXISTS(SELECT 1 FROM ingestion_jobs WHERE id=? AND state='uploading')",
      ).bind(id, id),
      env.DB.prepare(
        "UPDATE ingestion_jobs SET state='applying',checkpoint=checkpoint+1 WHERE id=? AND state='uploading'",
      ).bind(id),
    ]);
  }
  return jobStatus(env, id);
}

// Every D1 step mutation and checkpoint shares a transaction with a lease guard.
// A delayed worker that lost its fencing token cannot mutate staged rows/publish.
async function fenced(
  env: Env,
  job: Job,
  token: string,
  statements: D1PreparedStatement[],
  state: string,
  data: Data,
) {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO ingestion_guard VALUES(1,COALESCE((SELECT 1 FROM ingestion_jobs WHERE id=? AND lease=? AND checkpoint=? AND lease_until>?),0))",
    ).bind(job.id, token, job.checkpoint, Date.now()),
    ...statements,
    env.DB.prepare(
      "UPDATE ingestion_jobs SET state=?,data=?,checkpoint=checkpoint+1,lease=NULL,lease_until=0,error=NULL,attempts=0 WHERE id=? AND lease=?",
    ).bind(state, JSON.stringify(data), job.id, token),
  ]);
}
async function startScan(
  env: Env,
  force = false,
  requireEmbeddings = false,
  newScan = false,
) {
  if (requireEmbeddings && !config(env).semantic)
    throw new CloudError("EMBEDDING_UNAVAILABLE", 503);
  const existing = await env.DB.prepare(
    "SELECT job FROM ingestion_state WHERE id=1",
  ).first<{ job: string | null }>();
  if (existing?.job) {
    const job = await getJob(env, existing.job);
    if (!["complete", "failed"].includes(job.state)) {
      if (
        force ||
        newScan ||
        (requireEmbeddings && !JSON.parse(job.data).requireEmbeddings)
      )
        throw new CloudError("INDEX_BUSY", 409);
      return job.id;
    }
  }
  const id = crypto.randomUUID();
  const data = await newData(env, await active(env));
  data.force = force;
  data.requireEmbeddings = requireEmbeddings;
  await insertJob(env, id, id, "scan", "scanning", data);
  const won = await env.DB.prepare(
    "UPDATE ingestion_state SET job=?,error=NULL WHERE id=1 AND job IS ?",
  )
    .bind(id, existing?.job ?? null)
    .run();
  if (!won.meta.changes) {
    await env.DB.prepare(
      "UPDATE ingestion_jobs SET state='failed',error='INDEX_BUSY' WHERE id=?",
    )
      .bind(id)
      .run();
    // Explicit work requirements must retry admission after losing the writer race.
    if (force || newScan || requireEmbeddings)
      throw new CloudError("INDEX_BUSY", 409);
    return (await env.DB.prepare(
      "SELECT job FROM ingestion_state WHERE id=1",
    ).first<{ job: string }>())!.job;
  }
  return id;
}
export async function requestIndex(
  env: Env,
  force: boolean,
  requireEmbeddings: boolean,
  newScan = false,
) {
  return jobStatus(
    env,
    await startScan(env, force, requireEmbeddings, newScan),
  );
}
export async function advance(env: Env, id: string, checkpoint?: number) {
  let job = await getJob(env, id);
  if (["complete", "failed", "uploading", "preparing"].includes(job.state))
    return publicJob(job);
  if (checkpoint !== undefined && checkpoint !== job.checkpoint)
    return publicJob(job);
  const attempts = await env.DB.prepare(
    "SELECT attempts,lease_until FROM ingestion_jobs WHERE id=?",
  )
    .bind(id)
    .first<{ attempts: number; lease_until: number }>();
  if (attempts!.attempts >= 3 && attempts!.lease_until < Date.now()) {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE ingestion_jobs SET state='failed',error='INDEX_BUDGET_EXCEEDED' WHERE id=? AND checkpoint=? AND lease_until<?",
      ).bind(id, job.checkpoint, Date.now()),
      env.DB.prepare(
        "UPDATE ingestion_state SET error='INDEX_BUDGET_EXCEEDED' WHERE job=?",
      ).bind(id),
    ]);
    return publicJob(await getJob(env, id));
  }
  const token = crypto.randomUUID();
  const lock = await env.DB.prepare(
    "UPDATE ingestion_jobs SET lease=?,lease_until=?,attempts=attempts+1 WHERE id=? AND checkpoint=? AND lease_until<?",
  )
    .bind(token, Date.now() + 120000, id, job.checkpoint, Date.now())
    .run();
  if (!lock.meta.changes) return publicJob(await getJob(env, id));
  const d = JSON.parse(job.data) as Data;
  try {
    await step(env, job, token, d);
  } catch (error) {
    const code = error instanceof CloudError ? error.code : "INGESTION_FAILED";
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE ingestion_state SET error=? WHERE id=1 AND job=? AND EXISTS(SELECT 1 FROM ingestion_jobs WHERE id=? AND lease=?)",
      ).bind(code, id, id, token),
      env.DB.prepare(
        "UPDATE ingestion_jobs SET state='failed',error=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?",
      ).bind(code, id, token),
    ]);
  }
  job = await getJob(env, id);
  return publicJob(job);
}
async function step(env: Env, job: Job, token: string, d: Data) {
  if (job.kind === "scan" && d.policy && d.policy !== (await policyDigest(env)))
    throw new CloudError("CONFIGURATION_CHANGED", 409);
  const save = (state: string, sql: D1PreparedStatement[] = []) =>
    fenced(env, job, token, sql, state, d);
  if (job.state === "applying") {
    const entry = await env.DB.prepare(
      "SELECT * FROM ingestion_entries WHERE job=? AND processed=0 ORDER BY path LIMIT 1",
    )
      .bind(job.id)
      .first<Entry>();
    if (!entry) {
      await save("complete");
      return;
    }
    if (!config(env).allowed(entry.path))
      throw new CloudError("SOURCE_EXCLUDED", 403);
    const key = sourcePrefix(env) + entry.path;
    const current = await env.SOURCE.head(key);
    // On a lost response accept only our exact previously written intent.
    const expectedDigest =
      entry.digest ?? (await core.contentRevision(new Uint8Array()));
    const currentDigest = current?.checksums.sha256
      ? Array.from(new Uint8Array(current.checksums.sha256), (b) =>
          b.toString(16).padStart(2, "0"),
        ).join("")
      : null;
    if (
      current?.customMetadata?.upload !== job.id ||
      currentDigest !== expectedDigest
    ) {
      const staged = entry.digest
        ? await env.SOURCE.get(
            `${env.VAULT_ID}/staging/${job.id}/${entry.path}`,
          )
        : null;
      if (entry.digest && !staged)
        throw new CloudError("UPLOAD_INCOMPLETE", 409);
      const result = await env.SOURCE.put(
        key,
        staged?.body ?? new Uint8Array(),
        {
          sha256:
            entry.digest ?? (await core.contentRevision(new Uint8Array())),
          onlyIf: entry.etag
            ? { etagMatches: entry.etag }
            : { etagDoesNotMatch: "*" },
          customMetadata: {
            upload: job.id,
            ...(!entry.digest ? { deleted: "true" } : {}),
          },
        },
      );
      if (!result) throw new CloudError("REVISION_CONFLICT", 409);
    }
    d.filesProcessed = (d.filesProcessed ?? 0) + 1;
    await save("applying", [
      env.DB.prepare(
        "UPDATE ingestion_entries SET processed=1 WHERE job=? AND path=?",
      ).bind(job.id, entry.path),
    ]);
    return;
  }
  if (job.state === "scanning") {
    const page = await env.SOURCE.list({
      prefix: sourcePrefix(env),
      limit: 100,
      cursor: d.cursor,
      include: ["customMetadata"],
    });
    const rows: D1PreparedStatement[] = [];
    const allowed = config(env).allowed;
    for (const obj of page.objects) {
      const path = obj.key.slice(sourcePrefix(env).length);
      let kind: core.SourceKind | null;
      try {
        if (!allowed(path)) continue;
        kind = core.uploadKind(path);
      } catch {
        continue;
      }
      if (!kind || obj.customMetadata?.deleted === "true") continue;
      if (path.length > 512 || obj.size > core.uploadLimit(kind))
        throw new CloudError("UPLOAD_TOO_LARGE", 413);
      rows.push(
        env.DB.prepare(
          "INSERT OR REPLACE INTO ingestion_entries(job,path,kind,size,etag,updated) VALUES(?,?,?,?,?,?)",
        ).bind(
          job.id,
          path,
          kind,
          obj.size,
          obj.etag,
          obj.uploaded.toISOString(),
        ),
      );
    }
    d.filesAccepted = (d.filesAccepted ?? 0) + rows.length;
    d.cursor = page.truncated ? page.cursor : undefined;
    await save(page.truncated ? "scanning" : "planning", rows);
    return;
  }
  if (job.state === "planning") {
    const entries = (
      await env.DB.prepare(
        "SELECT path,etag FROM ingestion_entries WHERE job=? ORDER BY path LIMIT 501",
      )
        .bind(job.id)
        .all<{ path: string; etag: string }>()
    ).results;
    if (entries.length > 500)
      throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
    d.signature = await core.contentRevision(
      JSON.stringify([
        entries,
        env.INCLUDE_PATHS,
        env.EXCLUDE_PATHS,
        d.semantic,
        descriptor(env.EMBEDDING_MODEL_REVISION),
        core.INDEX_SCHEMA_VERSION,
      ]),
    );
    const previous = await env.DB.prepare(
      "SELECT signature FROM ingestion_state WHERE id=1",
    ).first<{ signature: string | null }>();
    if (
      !d.force &&
      !d.requireEmbeddings &&
      d.signature === previous?.signature
    ) {
      if (d.parent) {
        d.revision = d.parent;
        const previousManifest = await env.DB.prepare(
          "SELECT manifest FROM snapshots WHERE revision=?",
        )
          .bind(d.parent)
          .first<{ manifest: string }>();
        if (previousManifest)
          d.manifest = JSON.parse(previousManifest.manifest);
        d.notesSkipped = d.manifest.noteCount;
      }
      await save("complete", [
        env.DB.prepare(
          "UPDATE ingestion_state SET observed=?,error=NULL WHERE id=1 AND job=?",
        ).bind(Date.now(), job.id),
      ]);
      return;
    }
    await save("files", [
      env.DB.prepare(
        "INSERT INTO snapshots(revision,vault_id,manifest,note_count,chunk_count,entry_count,indexed_bytes,created) VALUES(?,?,?,0,0,0,0,?)",
      ).bind(d.revision, env.VAULT_ID, JSON.stringify(d.manifest), Date.now()),
      env.DB.prepare(
        `CREATE VIRTUAL TABLE fts_${d.revision} USING fts5(chunk_id UNINDEXED,lexical_text,tokenize='unicode61')`,
      ),
    ]);
    return;
  }
  if (job.state === "files") {
    const entry = await env.DB.prepare(
      "SELECT * FROM ingestion_entries WHERE job=? AND processed=0 ORDER BY path LIMIT 1",
    )
      .bind(job.id)
      .first<Entry>();
    if (!entry) {
      await save("chunks");
      return;
    }
    if (!config(env).allowed(entry.path))
      throw new CloudError("SOURCE_EXCLUDED", 403);
    const obj = await env.SOURCE.get(sourcePrefix(env) + entry.path, {
      onlyIf: { etagMatches: entry.etag! },
    });
    if (
      !obj ||
      !("body" in obj) ||
      obj.size !== entry.size ||
      obj.customMetadata?.deleted === "true"
    )
      throw new CloudError("REVISION_CONFLICT", 409);
    const bytes = await boundedBytes(obj.body, core.uploadLimit(entry.kind));
    const digest = await core.contentRevision(bytes);
    if (entry.kind === "guidance") {
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        throw new CloudError("SOURCE_NOT_UTF8", 409);
      }
    }
    const sql: D1PreparedStatement[] = [];
    if (entry.kind === "note") {
      const old = d.parent
        ? await env.DB.prepare(
            "SELECT n.data FROM notes n JOIN sources s ON n.revision=s.revision AND n.path=s.path WHERE n.revision=? AND n.path=? AND s.digest=?",
          )
            .bind(d.parent, entry.path, digest)
            .first<{ data: string }>()
        : null;
      if (
        !d.force &&
        old &&
        JSON.parse(old.data).wikilinks_json !== undefined
      ) {
        d.notesSkipped = (d.notesSkipped ?? 0) + 1;
        sql.push(
          env.DB.prepare(
            "INSERT INTO notes SELECT ?,note_id,path,data FROM notes WHERE revision=? AND path=?",
          ).bind(d.revision, d.parent, entry.path),
          env.DB.prepare(
            "INSERT INTO chunks SELECT ?,chunk_id,note_id,chunk_index,data FROM chunks WHERE revision=? AND note_id=?",
          ).bind(d.revision, d.parent, JSON.parse(old.data).note_id),
        );
      } else {
        let text: string;
        try {
          text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          throw new CloudError("SOURCE_NOT_UTF8", 409);
        }
        const { note, chunks } = await core.prepareSourceNote(
          { ...entry, revision: digest },
          text,
        );
        if (
          jsonSize(note) > 262144 ||
          chunks.some((c) => jsonSize(c) > 262144) ||
          jsonSize(chunks) > 1048576
        )
          throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
        sql.push(
          env.DB.prepare("INSERT INTO notes VALUES(?,?,?,?)").bind(
            d.revision,
            note.note_id,
            entry.path,
            JSON.stringify(note),
          ),
          env.DB.prepare(
            "INSERT INTO chunks SELECT ?,json_extract(value,'$.chunk_id'),json_extract(value,'$.note_id'),json_extract(value,'$.chunk_index'),value FROM json_each(?)",
          ).bind(d.revision, JSON.stringify(chunks)),
        );
      }
    }
    // Immutable snapshot write. Old fenced workers can only rewrite these exact bytes.
    await env.SOURCE.put(`${env.VAULT_ID}/${d.revision}/${entry.path}`, bytes, {
      sha256: digest,
    });
    sql.push(
      env.DB.prepare("INSERT INTO sources VALUES(?,?,?,?,?,?)").bind(
        d.revision,
        entry.path,
        entry.kind,
        bytes.length,
        digest,
        entry.updated,
      ),
      env.DB.prepare(
        "UPDATE ingestion_entries SET processed=1,digest=? WHERE job=? AND path=?",
      ).bind(digest, job.id, entry.path),
    );
    d.filesProcessed = (d.filesProcessed ?? 0) + 1;
    await save("files", sql);
    return;
  }
  if (job.state === "chunks") {
    const row = await env.DB.prepare(
      "SELECT chunk_id,data FROM chunks WHERE revision=? AND chunk_id>? ORDER BY chunk_id LIMIT 1",
    )
      .bind(d.revision, d.chunkCursor ?? "")
      .first<{ chunk_id: string; data: string }>();
    if (!row) {
      await save("links");
      return;
    }
    const c = JSON.parse(row.data) as core.IndexRow;
    d.chunkCursor = row.chunk_id;
    d.chunksProcessed = (d.chunksProcessed ?? 0) + 1;
    await save("chunks", [
      env.DB.prepare(
        `INSERT INTO fts_${d.revision}(chunk_id,lexical_text) VALUES(?,?)`,
      ).bind(row.chunk_id, c.lexical_text),
      env.DB.prepare(
        "INSERT INTO grams SELECT ?,?,value FROM json_each(?)",
      ).bind(
        d.revision,
        row.chunk_id,
        JSON.stringify(core.textToTrigrams(String(c.lexical_text))),
      ),
    ]);
    return;
  }
  if (job.state === "links") {
    const row = await env.DB.prepare(
      "SELECT note_id,data FROM notes WHERE revision=? AND note_id>? ORDER BY note_id LIMIT 1",
    )
      .bind(d.revision, d.linkCursor ?? "")
      .first<{ note_id: string; data: string }>();
    if (!row) {
      await save("counting");
      return;
    }
    const all = (
      await env.DB.prepare(
        "SELECT note_id,path,json_extract(data,'$.title') AS title,json_extract(data,'$.aliases_json') AS aliases FROM notes WHERE revision=? LIMIT 501",
      )
        .bind(d.revision)
        .all<{
          note_id: string;
          path: string;
          title: string | null;
          aliases: string;
        }>()
    ).results;
    if (all.length > 500) throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
    const stems = new Map<
      string,
      { noteId: string; title: string | null; aliases: string[] }[]
    >();
    const paths = new Map<string, string>();
    for (const n of all) {
      paths.set(n.path, n.note_id);
      const stem = n.path
        .split("/")
        .at(-1)!
        .replace(/\.(md|markdown)$/i, "");
      stems.set(stem, [
        ...(stems.get(stem) ?? []),
        { noteId: n.note_id, title: n.title, aliases: JSON.parse(n.aliases) },
      ]);
    }
    const resolve = core.createWikilinkResolver(
      stems,
      (p) => paths.get(p) ?? "",
    );
    const n = JSON.parse(row.data) as core.IndexRow;
    n.links_json = JSON.stringify(
      (JSON.parse(String(n.wikilinks_json ?? "[]")) as core.WikilinkInfo[]).map(
        (l) => resolve(l, String(n.path)),
      ),
    );
    d.linkCursor = row.note_id;
    await save("links", [
      env.DB.prepare(
        "UPDATE notes SET data=? WHERE revision=? AND note_id=?",
      ).bind(JSON.stringify(n), d.revision, row.note_id),
    ]);
    return;
  }
  if (job.state === "counting") {
    const counts = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM notes WHERE revision=?) AS notes,(SELECT count(*) FROM chunks WHERE revision=?) AS chunks,(SELECT count(*) FROM sources WHERE revision=?) AS entries,(SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM notes WHERE revision=?)+(SELECT coalesce(sum(length(CAST(data AS BLOB))),0) FROM chunks WHERE revision=?) AS bytes",
    )
      .bind(d.revision, d.revision, d.revision, d.revision, d.revision)
      .first<{
        notes: number;
        chunks: number;
        entries: number;
        bytes: number;
      }>();
    if (
      counts!.notes > 500 ||
      counts!.chunks > 2000 ||
      counts!.entries > 500 ||
      counts!.bytes > 16777216
    )
      throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
    d.manifest.noteCount = counts!.notes;
    d.manifest.chunkCount = counts!.chunks;
    if (d.semantic) {
      d.manifest.embeddingModel = MODEL;
      d.manifest.embeddingDimension = DIMENSION;
    }
    const sql = [
      env.DB.prepare(
        "UPDATE snapshots SET manifest=?,note_count=?,chunk_count=?,entry_count=?,indexed_bytes=? WHERE revision=?",
      ).bind(
        JSON.stringify(d.manifest),
        counts!.notes,
        counts!.chunks,
        counts!.entries,
        counts!.bytes,
        d.revision,
      ),
    ];
    if (d.semantic)
      sql.push(
        env.DB.prepare(
          "INSERT INTO embedding_generations VALUES(?,?,?,'pending')",
        ).bind(
          d.revision,
          await core.contentRevision(
            JSON.stringify(descriptor(env.EMBEDDING_MODEL_REVISION)),
          ),
          JSON.stringify(descriptor(env.EMBEDDING_MODEL_REVISION)),
        ),
      );
    await save(d.semantic ? "vectors" : "validating", sql);
    return;
  }
  if (job.state === "vectors") {
    const row = await env.DB.prepare(
      "SELECT chunk_id,data FROM chunks WHERE revision=? AND chunk_id>? ORDER BY chunk_id LIMIT 1",
    )
      .bind(d.revision, d.vectorCursor ?? "")
      .first<{ chunk_id: string; data: string }>();
    if (!row) {
      await save("validating", [
        env.DB.prepare(
          "UPDATE embedding_generations SET state=? WHERE revision=?",
        ).bind(d.embeddingError ? "unavailable" : "ready", d.revision),
      ]);
      return;
    }
    const c = JSON.parse(row.data) as core.IndexRow;
    try {
      const input = String(c.embedding_input_text);
      const cacheKey = await core.contentRevision(
        JSON.stringify([descriptor(env.EMBEDDING_MODEL_REVISION), input]),
      );
      let cached = await env.DB.prepare(
        "SELECT values_json FROM embedding_cache WHERE key=?",
      )
        .bind(cacheKey)
        .first<{ values_json: string }>();
      if (!cached) {
        const result = await new WorkersAIEmbeddingProvider(
          env.AI!,
          env.EMBEDDING_MODEL_REVISION,
        ).embed([input]);
        cached = {
          values_json: JSON.stringify(Array.from(result.embeddings[0]!)),
        };
        await fenced(
          env,
          job,
          token,
          [
            env.DB.prepare(
              "INSERT OR IGNORE INTO embedding_cache VALUES(?,?,?)",
            ).bind(cacheKey, cached.values_json, Date.now()),
          ],
          "vectors",
          d,
        );
        return;
      }
      const vectors = new VectorizeStore(
        env.VECTORS,
        new D1MetadataStore(
          env.DB,
          env.VAULT_ID,
          d.revision,
          d.manifest,
          config(env).allowed,
        ),
        env.EMBEDDING_MODEL_REVISION,
      );
      const entry = {
        chunkId: row.chunk_id,
        contentHash: String(c.content_hash),
        values: Float32Array.from(JSON.parse(cached.values_json)),
      };
      const receipt = await env.DB.prepare(
        "SELECT receipt FROM ingestion_vectors WHERE revision=? AND chunk_id=?",
      )
        .bind(d.revision, row.chunk_id)
        .first<{ receipt: string | null }>();
      if (!receipt) {
        // Deterministic IDs make replay after a lost receipt harmless.
        const result = await vectors.upsert([entry]);
        await save("vectors", [
          env.DB.prepare(
            "INSERT OR REPLACE INTO ingestion_vectors VALUES(?,?,?,?,0)",
          ).bind(d.revision, row.chunk_id, cacheKey, result.id),
        ]);
        return;
      }
      if (!(await vectors.visible([entry]))) {
        await save("vectors");
        return;
      }
      d.vectorCursor = row.chunk_id;
      await save("vectors", [
        env.DB.prepare(
          "UPDATE ingestion_vectors SET visible=1 WHERE revision=? AND chunk_id=?",
        ).bind(d.revision, row.chunk_id),
      ]);
      return;
    } catch (error) {
      if (d.requireEmbeddings) throw error;
      d.embeddingError = true;
      await save("validating", [
        env.DB.prepare(
          "UPDATE embedding_generations SET state='unavailable' WHERE revision=?",
        ).bind(d.revision),
      ]);
      return;
    }
  }
  if (job.state === "validating") {
    const entry = await env.DB.prepare(
      "SELECT * FROM ingestion_entries WHERE job=? AND path>? ORDER BY path LIMIT 1",
    )
      .bind(job.id, d.validateCursor ?? "")
      .first<Entry>();
    if (entry) {
      const obj = await env.SOURCE.head(sourcePrefix(env) + entry.path);
      if (
        !obj ||
        obj.etag !== entry.etag ||
        obj.customMetadata?.deleted === "true" ||
        !config(env).allowed(entry.path)
      )
        throw new CloudError("REVISION_CONFLICT", 409);
      d.validateCursor = entry.path;
      await save("validating");
      return;
    }
    await save("publishing");
    return;
  }
  if (job.state === "publishing") {
    if ((await active(env)) !== d.parent)
      throw new CloudError("REVISION_CONFLICT", 409);
    // CAS is checked inside the same fenced D1 transaction as pointer publication.
    await save("complete", [
      env.DB.prepare(
        "INSERT OR REPLACE INTO ingestion_guard VALUES(1,CASE WHEN (SELECT revision FROM deployment WHERE id=1) IS ? THEN 1 ELSE 0 END)",
      ).bind(d.parent),
      env.DB.prepare(
        "INSERT INTO deployment VALUES(1,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
      ).bind(d.revision),
      env.DB.prepare(
        "UPDATE ingestion_state SET signature=?,observed=?,error=NULL WHERE id=1 AND job=?",
      ).bind(d.signature, Date.now(), job.id),
    ]);
    return;
  }
  throw new CloudError("INVALID_JOB_STATE", 409);
}
export async function tick(env: Env) {
  if (!ingestionEnabled(env)) return;
  config(env);
  const deadline = Date.now() + 20000;
  await cleanupStep(env);
  // Finish committed upload intents without requiring their local client.
  const uploads = (
    await env.DB.prepare(
      "SELECT id FROM ingestion_jobs WHERE kind='upload' AND state='applying' ORDER BY created LIMIT 1",
    ).all<{ id: string }>()
  ).results;
  const id = uploads[0]?.id ?? (await startScan(env));
  for (let n = 0; n < 8 && Date.now() < deadline; n++) {
    const result = await advance(env, id);
    if (["complete", "failed"].includes(result.state)) break;
  }
}
export async function detectionStatus(env: Env) {
  if (!ingestionEnabled(env)) return null;
  const row = await env.DB.prepare(
    "SELECT s.*,j.state,j.error AS job_error,json_extract(j.data,'$.revision') AS target_revision FROM ingestion_state s LEFT JOIN ingestion_jobs j ON j.id=s.job WHERE s.id=1",
  ).first<{
    job: string | null;
    state: string | null;
    observed: number | null;
    error: string | null;
    job_error: string | null;
    target_revision: string | null;
  }>();
  const stale = !row?.observed || Date.now() - row.observed > 180000;
  return {
    state:
      row?.error || row?.state === "failed" || stale
        ? "stale"
        : row?.state && row.state !== "complete"
          ? "updating"
          : "observed",
    lastObservedAt: row?.observed ?? null,
    activeJobId:
      row?.state && !["complete", "failed"].includes(row.state)
        ? row.job
        : null,
    lastJobId: row?.job ?? null,
    targetRevision:
      row?.state && !["complete", "failed"].includes(row.state)
        ? row.target_revision
        : null,
    error: row?.error ?? row?.job_error ?? null,
    cleanupPending: await cleanupPending(env),
  };
}

/** One bounded cleanup step; retain snapshots and resumable plans for 24h. */
async function cleanupStep(env: Env) {
  const cutoff = Date.now() - 86400000;
  const old = await env.DB.prepare(
    "SELECT revision,manifest FROM snapshots WHERE vault_id=? AND created<? AND revision NOT IN (SELECT revision FROM deployment) AND revision NOT IN (SELECT json_extract(data,'$.revision') FROM ingestion_jobs WHERE state NOT IN ('failed','complete')) ORDER BY created LIMIT 1",
  )
    .bind(env.VAULT_ID, cutoff)
    .first<{ revision: string; manifest: string }>();
  if (old) {
    if (!revisionPattern.test(old.revision))
      throw new CloudError("INDEX_INCOMPATIBLE", 409);
    const chunks = (
      await env.DB.prepare(
        "SELECT chunk_id FROM chunks WHERE revision=? ORDER BY chunk_id LIMIT 16",
      )
        .bind(old.revision)
        .all<{ chunk_id: string }>()
    ).results;
    if (chunks.length) {
      const generation = await env.DB.prepare(
        "SELECT descriptor FROM embedding_generations WHERE revision=?",
      )
        .bind(old.revision)
        .first<{ descriptor: string }>();
      if (generation && !env.VECTORS) return;
      if (generation && env.VECTORS) {
        const desc = JSON.parse(generation.descriptor) as {
          modelRevision: string;
        };
        const metadata = new D1MetadataStore(
          env.DB,
          env.VAULT_ID,
          old.revision,
          JSON.parse(old.manifest),
          () => true,
        );
        const vectors = new VectorizeStore(
          env.VECTORS,
          metadata,
          desc.modelRevision,
        );
        const ids = await Promise.all(
          chunks.map((c) => vectors.id(c.chunk_id)),
        );
        const remaining = await env.VECTORS.getByIds(ids);
        if (remaining.length) {
          await vectors.delete(chunks.map((c) => c.chunk_id));
          return;
        }
      }
      await env.DB.batch(
        chunks.flatMap((c) => [
          env.DB.prepare(
            "DELETE FROM grams WHERE revision=? AND chunk_id=?",
          ).bind(old.revision, c.chunk_id),
          env.DB.prepare(
            "DELETE FROM chunks WHERE revision=? AND chunk_id=?",
          ).bind(old.revision, c.chunk_id),
        ]),
      );
      return;
    }
    const objects = await env.SOURCE.list({
      prefix: `${env.VAULT_ID}/${old.revision}/`,
      limit: 100,
    });
    if (objects.objects.length) {
      await env.SOURCE.delete(objects.objects.map((o) => o.key));
      return;
    }
    await env.DB.batch([
      env.DB.prepare(`DROP TABLE IF EXISTS fts_${old.revision}`),
      env.DB.prepare("DELETE FROM notes WHERE revision=?").bind(old.revision),
      env.DB.prepare("DELETE FROM sources WHERE revision=?").bind(old.revision),
      env.DB.prepare("DELETE FROM ingestion_vectors WHERE revision=?").bind(
        old.revision,
      ),
      env.DB.prepare("DELETE FROM embedding_generations WHERE revision=?").bind(
        old.revision,
      ),
      env.DB.prepare("DELETE FROM snapshots WHERE revision=?").bind(
        old.revision,
      ),
    ]);
    return;
  }
  const abandoned = await env.DB.prepare(
    "SELECT id FROM ingestion_jobs WHERE created<? AND state IN ('complete','failed','uploading','preparing') AND id IS NOT (SELECT job FROM ingestion_state WHERE id=1) ORDER BY created LIMIT 1",
  )
    .bind(cutoff)
    .first<{ id: string }>();
  if (abandoned) {
    const prefix = `${env.VAULT_ID}/staging/${abandoned.id}/`;
    const objects = await env.SOURCE.list({ prefix, limit: 100 });
    if (objects.objects.length) {
      await env.SOURCE.delete(objects.objects.map((o) => o.key));
      return;
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM ingestion_entries WHERE job=?").bind(
        abandoned.id,
      ),
      env.DB.prepare("DELETE FROM ingestion_jobs WHERE id=?").bind(
        abandoned.id,
      ),
    ]);
    return;
  }
  // Keep exact-input cache entries while a target can still reference them.
  await env.DB.prepare(
    "DELETE FROM embedding_cache WHERE key IN (SELECT c.key FROM embedding_cache c WHERE c.created<? AND NOT EXISTS(SELECT 1 FROM ingestion_vectors v WHERE v.cache_key=c.key) LIMIT 16) AND NOT EXISTS(SELECT 1 FROM ingestion_jobs WHERE state NOT IN ('complete','failed','uploading','preparing'))",
  )
    .bind(cutoff)
    .run();
}

async function cleanupPending(env: Env) {
  const row = await env.DB.prepare(
    "SELECT EXISTS(SELECT 1 FROM snapshots WHERE vault_id=? AND revision NOT IN (SELECT revision FROM deployment)) OR EXISTS(SELECT 1 FROM ingestion_entries e JOIN ingestion_jobs j ON e.job=j.id WHERE j.kind='upload' AND j.state IN ('complete','failed')) OR EXISTS(SELECT 1 FROM embedding_cache c WHERE NOT EXISTS(SELECT 1 FROM ingestion_vectors v WHERE v.cache_key=c.key)) AS pending",
  )
    .bind(env.VAULT_ID)
    .first<{ pending: number }>();
  return !!row?.pending;
}

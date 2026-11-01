import * as core from "@vault-agent/core/portable";
import { config, type Env } from "./config.js";
import { CloudError, boundedBytes } from "./errors.js";
import { D1MetadataStore } from "./d1.js";
import { VectorizeStore } from "./vectorize.js";
import {
  publication,
  stageDeltaFile,
  prepareDeltaCommit,
} from "./incremental.js";
import {
  advanceSemantic,
  semanticProgress,
  cleanupIncremental,
} from "./semantic-work.js";
import {
  WorkersAIEmbeddingProvider,
  descriptor,
  MODEL,
  DIMENSION,
} from "./provider.js";

type Data = {
  layout?: number;
  observations?: number;
  parentSnapshot?: string | null;
  parentEpoch?: number;
  incremental?: boolean;
  updatePath?: string;
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
  validateSeen?: string[];
  policy?: string;
  filesAccepted?: number;
  filesProcessed?: number;
  chunksProcessed?: number;
  notesSkipped?: number;
  removedPaths?: string[];
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
  object_version?: string | null;
};
export const ingestionEnabled = (env: Env) =>
  String(env.INGESTION_ENABLED) === "true";
export const sourcePrefix = (env: Env) => `${env.VAULT_ID}/source/`;

const reusableObservation =
  "s.kind=e.kind AND s.size=e.size AND s.updated=e.updated AND o.digest=s.digest AND o.etag=e.etag AND o.object_version=e.object_version AND length(o.object_version)>0";
function admitObservedObject(
  env: Env,
  obj: R2Object,
  allowed: (path: string) => boolean,
): Entry | null {
  const path = obj.key.slice(sourcePrefix(env).length);
  let kind: core.SourceKind | null;
  try {
    if (!allowed(path)) return null;
    kind = core.uploadKind(path);
  } catch {
    return null;
  }
  if (!kind || obj.customMetadata?.deleted === "true") return null;
  if (path.length > 512 || obj.size > core.uploadLimit(kind))
    throw new CloudError("UPLOAD_TOO_LARGE", 413);
  return {
    path,
    kind,
    size: obj.size,
    etag: obj.etag,
    updated: obj.uploaded.toISOString(),
    object_version: obj.version ?? null,
    digest: null,
    processed: 0,
  };
}
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
    parentRevision: d.parentSnapshot ?? d.parent,
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
    updatePath: d.updatePath ?? "rebuild",
  };
}
export async function jobStatus(env: Env, id: string) {
  const row = await getJob(env, id);
  return { ...publicJob(row), semantic: await semanticProgress(env) };
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
      "ingestion-v3",
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
async function sourceSignature(env: Env, entries: Entry[]) {
  return core.contentRevision(
    JSON.stringify([
      "source-signature-v2",
      await policyDigest(env),
      [...entries]
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
        .map((e) => [
          e.path,
          e.kind,
          e.size,
          e.etag,
          e.object_version ?? null,
          e.updated,
        ]),
    ]),
  );
}

// One statement captures the durable reader/writer state on either side of LIST.
async function detectionFence(env: Env) {
  return env.DB.prepare(
    "SELECT s.job,s.signature,s.error,j.state,j.checkpoint,d.revision AS store,p.snapshot,p.epoch,(SELECT id FROM ingestion_jobs WHERE kind='upload' AND state='applying' ORDER BY created LIMIT 1) AS upload FROM ingestion_state s LEFT JOIN ingestion_jobs j ON j.id=s.job LEFT JOIN deployment d ON d.id=1 LEFT JOIN publications p ON p.store=d.revision WHERE s.id=1",
  ).first<{
    job: string | null;
    signature: string | null;
    error: string | null;
    state: string | null;
    checkpoint: number | null;
    store: string | null;
    snapshot: string | null;
    epoch: number | null;
    upload: string | null;
  }>();
}

async function probeSources(env: Env, deadline: number) {
  const before = await detectionFence(env);
  let pages = 0;
  const entries = new Map<string, Entry>();
  if (
    !before?.store ||
    !before.signature ||
    before.error ||
    before.state !== "complete" ||
    before.upload
  )
    return { result: "changed" as const, pages, files: 0 };
  const allowed = config(env).allowed;
  let cursor: string | undefined;
  while (pages < 8 && Date.now() < deadline) {
    const page = await env.SOURCE.list({
      prefix: sourcePrefix(env),
      limit: 100,
      cursor,
      include: ["customMetadata"],
    });
    pages++;
    for (const obj of page.objects) {
      const entry = admitObservedObject(env, obj, allowed);
      if (!entry) continue;
      if (entries.has(entry.path))
        throw new CloudError("REVISION_CONFLICT", 409);
      entries.set(entry.path, entry);
      if (entries.size > 500)
        throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
    }
    if (!page.truncated) {
      const signature = await sourceSignature(env, [...entries.values()]);
      const after = await detectionFence(env);
      return {
        result:
          signature === before.signature &&
          JSON.stringify(before) === JSON.stringify(after)
            ? ("unchanged" as const)
            : ("changed" as const),
        pages,
        files: entries.size,
      };
    }
    cursor = page.cursor;
  }
  return { result: "deferred" as const, pages, files: entries.size };
}
async function newData(env: Env, parent: string | null): Promise<Data> {
  const current = await publication(env);
  return {
    layout: 2,
    observations: 1,
    parentSnapshot: current?.snapshot ?? null,
    parentEpoch: current?.epoch ?? 0,
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
  if (((await publication(env))?.snapshot ?? null) !== p.parentRevision)
    throw new CloudError("REVISION_CONFLICT", 409);
  const data = await newData(env, await active(env));
  if (data.parentSnapshot !== p.parentRevision)
    throw new CloudError("REVISION_CONFLICT", 409);
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
  if (job.state === "complete") {
    const completed = JSON.parse(job.data) as Data;
    if (
      job.kind === "scan" &&
      config(env).semantic &&
      (await publication(env))?.snapshot === completed.revision
    )
      await advanceSemantic(env);
    return jobStatus(env, id);
  }
  if (["failed", "uploading", "preparing"].includes(job.state))
    return publicJob(job);
  if (checkpoint !== undefined && checkpoint !== job.checkpoint)
    return publicJob(job);
  const attempts = await env.DB.prepare(
    "SELECT attempts,lease_until FROM ingestion_jobs WHERE id=?",
  )
    .bind(id)
    .first<{ attempts: number; lease_until: number }>();
  if (attempts!.attempts >= 3 && attempts!.lease_until < Date.now()) {
    const interrupted = JSON.parse(job.data) as Data;
    await env.DB.batch([
      ...(interrupted.incremental && interrupted.signature
        ? [
            env.DB.prepare(
              "INSERT OR IGNORE INTO delta_fallbacks VALUES(?)",
            ).bind(interrupted.signature),
          ]
        : []),
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
      ...(d.incremental &&
      job.state === "publishing" &&
      d.signature &&
      code !== "REVISION_CONFLICT"
        ? [
            env.DB.prepare(
              "INSERT OR IGNORE INTO delta_fallbacks SELECT ? WHERE EXISTS(SELECT 1 FROM ingestion_jobs WHERE id=? AND lease=?)",
            ).bind(d.signature, id, token),
          ]
        : []),
      env.DB.prepare(
        "UPDATE ingestion_state SET error=? WHERE id=1 AND job=? AND EXISTS(SELECT 1 FROM ingestion_jobs WHERE id=? AND lease=?)",
      ).bind(code, id, id, token),
      env.DB.prepare(
        "UPDATE ingestion_jobs SET state='failed',error=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?",
      ).bind(code, id, token),
    ]);
  }
  job = await getJob(env, id);
  return { ...publicJob(job), semantic: await semanticProgress(env) };
}
async function step(env: Env, job: Job, token: string, d: Data) {
  if (job.kind === "scan" && (d.layout !== 2 || d.observations !== 1))
    throw new CloudError("INGESTION_UPGRADE_REQUIRED", 409);
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
      const observed = admitObservedObject(env, obj, allowed);
      if (!observed) continue;
      rows.push(
        env.DB.prepare(
          "INSERT OR REPLACE INTO ingestion_entries(job,path,kind,size,etag,updated,object_version) VALUES(?,?,?,?,?,?,?)",
        ).bind(
          job.id,
          observed.path,
          observed.kind,
          observed.size,
          observed.etag,
          observed.updated,
          observed.object_version,
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
        "SELECT path,kind,size,etag,object_version,updated FROM ingestion_entries WHERE job=? ORDER BY path LIMIT 501",
      )
        .bind(job.id)
        .all<Entry>()
    ).results;
    if (entries.length > 500)
      throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
    const parentRow = d.parent
      ? await env.DB.prepare("SELECT manifest FROM snapshots WHERE revision=?")
          .bind(d.parent)
          .first<{ manifest: string }>()
      : null;
    const parentManifest: core.IndexManifest | null = parentRow
      ? JSON.parse(parentRow.manifest)
      : null;
    if (
      parentManifest &&
      (parentManifest.schemaVersion !== core.INDEX_SCHEMA_VERSION ||
        parentManifest.targetChunkSize !== core.TARGET_CHUNK_SIZE ||
        parentManifest.maxChunkSize !== core.MAX_CHUNK_SIZE)
    )
      d.force = true;

    const previousSources = d.parent
      ? (
          await env.DB.prepare(
            "SELECT path,kind,digest AS revision FROM sources WHERE revision=? LIMIT 501",
          )
            .bind(d.parent)
            .all<core.IndexedSource>()
        ).results
      : [];
    if (previousSources.length > 500)
      throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
    d.removedPaths = core
      .planSourceChanges(
        previousSources,
        entries.map((entry) => ({
          path: entry.path,
          source: {
            path: entry.path,
            kind:
              previousSources.find((p) => p.path === entry.path)?.kind ??
              "note",
            revision: null,
          },
        })),
        { complete: true },
      )
      .filter((change) => change.action === "remove")
      .map((change) => change.path);

    d.signature = await sourceSignature(env, entries);
    const previous = await env.DB.prepare(
      "SELECT signature FROM ingestion_state WHERE id=1",
    ).first<{ signature: string | null }>();
    if (
      !d.force &&
      !d.requireEmbeddings &&
      d.signature === previous?.signature
    ) {
      if (d.parent) {
        d.revision = d.parentSnapshot ?? d.parent;
        if (parentManifest) d.manifest = parentManifest;
        d.notesSkipped = d.manifest.noteCount;
      }
      await save("complete", [
        env.DB.prepare(
          "UPDATE ingestion_state SET observed=?,error=NULL WHERE id=1 AND job=?",
        ).bind(Date.now(), job.id),
      ]);
      return;
    }
    const fallback = await env.DB.prepare(
      "SELECT signature FROM delta_fallbacks WHERE signature=?",
    )
      .bind(d.signature)
      .first();
    if (!d.force && !d.requireEmbeddings && d.parent && !fallback) {
      const legacyRows = await env.DB.prepare(
        "SELECT 1 FROM notes WHERE revision=? AND json_type(data,'$.wikilinks_json') IS NOT 'text' LIMIT 1",
      )
        .bind(d.parent)
        .first();
      const model = parentManifest!;
      const generation = d.semantic
        ? await env.DB.prepare(
            "SELECT descriptor,state FROM embedding_generations WHERE revision=?",
          )
            .bind(d.parent)
            .first<{ descriptor: string; state: string }>()
        : null;
      if (
        !legacyRows &&
        model.schemaVersion === core.INDEX_SCHEMA_VERSION &&
        model.targetChunkSize === core.TARGET_CHUNK_SIZE &&
        model.maxChunkSize === core.MAX_CHUNK_SIZE &&
        ((!d.semantic && model.embeddingModel === null) ||
          (d.semantic &&
            generation?.state === "ready" &&
            generation.descriptor ===
              JSON.stringify(descriptor(env.EMBEDDING_MODEL_REVISION))))
      ) {
        d.incremental = true;
        d.updatePath = "incremental";
        d.manifest.embeddingModel = model.embeddingModel;
        d.manifest.embeddingDimension = model.embeddingDimension;
        const reusable = (
          await env.DB.prepare(
            `SELECT e.kind FROM ingestion_entries e JOIN sources s ON s.revision=? AND s.path=e.path JOIN source_observations o ON o.revision=s.revision AND o.path=s.path WHERE e.job=? AND ${reusableObservation}`,
          )
            .bind(d.parent, job.id)
            .all<{ kind: string }>()
        ).results;
        d.filesProcessed = reusable.length;
        d.notesSkipped = reusable.filter((e) => e.kind === "note").length;
        await save("delta_files", [
          env.DB.prepare(
            `UPDATE ingestion_entries AS e SET processed=1,digest=s.digest FROM sources s JOIN source_observations o ON o.revision=s.revision AND o.path=s.path WHERE s.revision=? AND e.job=? AND e.path=s.path AND ${reusableObservation}`,
          ).bind(d.parent, job.id),
        ]);
        return;
      }
    }
    d.updatePath = fallback ? "rebuild-recovery" : "rebuild";
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
  if (job.state === "delta_files") {
    const entry = await env.DB.prepare(
      "SELECT * FROM ingestion_entries WHERE job=? AND processed=0 ORDER BY path LIMIT 1",
    )
      .bind(job.id)
      .first<Entry>();
    if (!entry) {
      await save("delta_prepare");
      return;
    }
    const prepared = await stageDeltaFile(env, job.id, d.parent!, entry);
    d.filesProcessed = (d.filesProcessed ?? 0) + 1;
    if (prepared.reused && entry.kind === "note")
      d.notesSkipped = (d.notesSkipped ?? 0) + 1;
    await save("delta_files", prepared.statements);
    return;
  }
  if (job.state === "delta_prepare") {
    const delta = await prepareDeltaCommit(
      env,
      job.id,
      d.parent!,
      d.manifest,
      !!d.semantic,
    );
    if (!delta.fits) {
      d.incremental = false;
      d.updatePath = "rebuild-budget";
      d.filesProcessed = 0;
      d.notesSkipped = 0;
      d.chunksProcessed = 0;
      await save("files", [
        env.DB.prepare(
          "UPDATE ingestion_entries SET processed=0 WHERE job=?",
        ).bind(job.id),
        env.DB.prepare(
          "INSERT INTO snapshots(revision,vault_id,manifest,note_count,chunk_count,entry_count,indexed_bytes,created) VALUES(?,?,?,0,0,0,0,?)",
        ).bind(
          d.revision,
          env.VAULT_ID,
          JSON.stringify(d.manifest),
          Date.now(),
        ),
        env.DB.prepare(
          `CREATE VIRTUAL TABLE fts_${d.revision} USING fts5(chunk_id UNINDEXED,lexical_text,tokenize='unicode61')`,
        ),
      ]);
      return;
    }
    d.chunksProcessed = delta.changedChunks;
    await save("validating");
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
      (entry.object_version && obj.version !== entry.object_version) ||
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
            "SELECT data FROM notes WHERE revision=? AND path=?",
          )
            .bind(d.parent, entry.path)
            .first<{ data: string }>()
        : null;
      const prepared = await core.prepareNoteUpdate(
        { ...entry, revision: digest },
        old ? JSON.parse(old.data) : null,
        async () => {
          try {
            return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          } catch {
            throw new CloudError("SOURCE_NOT_UTF8", 409);
          }
        },
        { force: d.force },
      );
      if (prepared.action === "reuse") {
        d.notesSkipped = (d.notesSkipped ?? 0) + 1;
        sql.push(
          env.DB.prepare("INSERT INTO notes VALUES(?,?,?,?)").bind(
            d.revision,
            prepared.note.note_id,
            entry.path,
            JSON.stringify(prepared.note),
          ),
          env.DB.prepare(
            "INSERT INTO chunks SELECT ?,chunk_id,note_id,chunk_index,data FROM chunks WHERE revision=? AND note_id=?",
          ).bind(d.revision, d.parent, prepared.note.note_id),
        );
      } else {
        const { note, chunks } = prepared;
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
    if (entry.object_version)
      sql.push(
        env.DB.prepare(
          "INSERT OR REPLACE INTO source_observations VALUES(?,?,?,?,?)",
        ).bind(
          d.revision,
          entry.path,
          digest,
          entry.etag,
          entry.object_version,
        ),
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
        "SELECT note_id,path,json_extract(data,'$.title') AS title,json_extract(data,'$.aliases_json') AS aliases_json FROM notes WHERE revision=? LIMIT 501",
      )
        .bind(d.revision)
        .all<core.IndexRow>()
    ).results;
    if (all.length > 500) throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
    const n = core.createIndexLinkResolver(all)(JSON.parse(row.data));
    d.linkCursor = row.note_id;
    await save("links", [
      env.DB.prepare(
        "UPDATE notes SET data=? WHERE revision=? AND note_id=?",
      ).bind(JSON.stringify(n), d.revision, row.note_id),
    ]);
    return;
  }
  if (job.state === "counting") {
    const revoked = await env.DB.prepare(
      "SELECT (SELECT count(*) FROM sources WHERE revision=? AND path IN (SELECT value FROM json_each(?)))+(SELECT count(*) FROM notes WHERE revision=? AND path IN (SELECT value FROM json_each(?))) AS n",
    )
      .bind(
        d.revision,
        JSON.stringify(d.removedPaths ?? []),
        d.revision,
        JSON.stringify(d.removedPaths ?? []),
      )
      .first<{ n: number }>();
    if (revoked!.n) throw new CloudError("REVISION_CONFLICT", 409);

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
      const [prepared] = await core.prepareEmbeddingBatch(
        [
          {
            chunkId: row.chunk_id,
            contentHash: String(c.content_hash),
            text: String(c.embedding_input_text),
          },
        ],
        {
          enabled: config(env).semantic,
          provider: new WorkersAIEmbeddingProvider(
            env.AI!,
            env.EMBEDDING_MODEL_REVISION,
          ),
          cache: {
            get: async (key) => {
              const cached = await env.DB.prepare(
                "SELECT values_json FROM embedding_cache WHERE key=?",
              )
                .bind(key)
                .first<{ values_json: string }>();
              try {
                return cached
                  ? Float32Array.from(JSON.parse(cached.values_json))
                  : null;
              } catch {
                return null;
              }
            },
          },
        },
      );
      if (!prepared) throw new CloudError("EMBEDDING_UNAVAILABLE", 503);
      const cacheKey = prepared.cacheKey;
      if (prepared.generated) {
        await fenced(
          env,
          job,
          token,
          [
            env.DB.prepare(
              "INSERT OR REPLACE INTO embedding_cache VALUES(?,?,?)",
            ).bind(
              cacheKey,
              JSON.stringify(Array.from(prepared.values)),
              Date.now(),
            ),
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
        values: prepared.values,
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
    const page = await env.SOURCE.list({
      prefix: sourcePrefix(env),
      limit: 100,
      cursor: d.validateCursor,
      include: ["customMetadata"],
    });
    const allowed = config(env).allowed;
    const actual = page.objects
      .map((o) => admitObservedObject(env, o, allowed))
      .filter((e): e is Entry => e !== null);
    const expected = (
      await env.DB.prepare(
        "SELECT * FROM ingestion_entries WHERE job=? AND path IN (SELECT value FROM json_each(?))",
      )
        .bind(job.id, JSON.stringify(actual.map((e) => e.path)))
        .all<Entry>()
    ).results;
    const planned = new Map(expected.map((e) => [e.path, e]));
    const seen = new Set(d.validateSeen ?? []);
    for (const entry of actual) {
      const old = planned.get(entry.path);
      if (
        seen.has(entry.path) ||
        !old ||
        !core.indexRowsEqual(
          [
            old.kind,
            old.size,
            old.etag,
            old.object_version ?? null,
            old.updated,
          ],
          [
            entry.kind,
            entry.size,
            entry.etag,
            entry.object_version ?? null,
            entry.updated,
          ],
        )
      )
        throw new CloudError("REVISION_CONFLICT", 409);
      seen.add(entry.path);
    }
    if (seen.size > 500) throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
    if (page.truncated) {
      d.validateCursor = page.cursor;
      d.validateSeen = [...seen];
      await save("validating");
      return;
    }
    const total = (await env.DB.prepare(
      "SELECT count(*) AS n FROM ingestion_entries WHERE job=?",
    )
      .bind(job.id)
      .first<{ n: number }>())!.n;
    if (seen.size !== total) throw new CloudError("REVISION_CONFLICT", 409);
    d.validateCursor = undefined;
    d.validateSeen = undefined;
    await save("publishing");
    return;
  }
  if (job.state === "publishing") {
    const current = await publication(env);
    if (
      (current?.store ?? null) !== d.parent ||
      (current?.snapshot ?? null) !== d.parentSnapshot ||
      (current?.epoch ?? 0) !== d.parentEpoch
    )
      throw new CloudError("REVISION_CONFLICT", 409);
    const guard = env.DB.prepare(
      "INSERT OR REPLACE INTO ingestion_guard VALUES(1,CASE WHEN coalesce((SELECT epoch FROM publications WHERE store=?),0)=? AND (SELECT revision FROM deployment WHERE id=1) IS ? THEN 1 ELSE 0 END)",
    ).bind(d.parent, d.parentEpoch, d.parent);
    if (d.incremental) {
      const delta = await prepareDeltaCommit(
        env,
        job.id,
        d.parent!,
        d.manifest,
        !!d.semantic,
      );
      if (!delta.fits) throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
      await save("complete", [
        guard,
        ...delta.statements,
        env.DB.prepare(
          "INSERT INTO publications VALUES(?,?,?) ON CONFLICT(store) DO UPDATE SET snapshot=excluded.snapshot,epoch=excluded.epoch",
        ).bind(d.parent, d.revision, d.parentEpoch! + 1),
        env.DB.prepare(
          "UPDATE ingestion_state SET signature=?,observed=?,error=NULL WHERE id=1 AND job=?",
        ).bind(d.signature, Date.now(), job.id),
      ]);
      return;
    }
    // CAS is checked inside the same fenced D1 transaction as pointer publication.
    await save("complete", [
      guard,
      env.DB.prepare(
        "INSERT OR REPLACE INTO ingestion_guard VALUES(1,CASE WHEN (SELECT revision FROM deployment WHERE id=1) IS ? THEN 1 ELSE 0 END)",
      ).bind(d.parent),
      env.DB.prepare(
        "INSERT INTO deployment VALUES(1,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision",
      ).bind(d.revision),
      env.DB.prepare("INSERT INTO publications VALUES(?,?,?)").bind(
        d.revision,
        d.revision,
        d.parentEpoch! + 1,
      ),
      env.DB.prepare(
        "UPDATE ingestion_state SET signature=?,observed=?,error=NULL WHERE id=1 AND job=?",
      ).bind(d.signature, Date.now(), job.id),
    ]);
    return;
  }
  throw new CloudError("INVALID_JOB_STATE", 409);
}
export type ReconciliationLog = {
  event: "reconciliation";
  result: "start" | "unchanged" | "changed" | "resumed" | "deferred" | "failed";
  files?: number;
  pages?: number;
  elapsedMs?: number;
  errorCode?: string;
};
const logCodes = new Set([
  "CONFIG_INVALID",
  "UPLOAD_TOO_LARGE",
  "INDEX_BUDGET_EXCEEDED",
  "REVISION_CONFLICT",
  "INDEX_BUSY",
  "INGESTION_UPGRADE_REQUIRED",
  "EMBEDDING_UNAVAILABLE",
  "SOURCE_REVISION_MISMATCH",
  "SOURCE_UNAVAILABLE",
]);
function logCode(code: string) {
  return logCodes.has(code) ? code : "INGESTION_FAILED";
}
export async function tick(
  env: Env,
  log: (entry: ReconciliationLog) => void = (entry) => console.log(entry),
) {
  if (!ingestionEnabled(env)) return;
  const start = Date.now();
  log({ event: "reconciliation", result: "start" });
  try {
    config(env);
    const deadline = start + 20000;
    await cleanupIncremental(env);
    await cleanupStep(env);
    // Resume durable work before a read-only probe; uploads must remain autonomous.
    const state = await detectionFence(env);
    const resumed =
      state?.upload ??
      (state?.job &&
      state.state &&
      !["complete", "failed"].includes(state.state)
        ? state.job
        : null);
    const probe = resumed
      ? { result: "resumed" as const, files: 0, pages: 0 }
      : await probeSources(env, deadline);
    let failure: string | undefined;
    if (probe.result !== "unchanged") {
      const id = resumed ?? (await startScan(env));
      for (let n = 0; n < 8 && Date.now() < deadline; n++) {
        const result = await advance(env, id);
        if (result.state === "failed")
          failure = logCode(result.error?.code ?? "");
        if (["complete", "failed"].includes(result.state)) break;
      }
    }
    if (Date.now() < deadline) await advanceSemantic(env);
    log({
      event: "reconciliation",
      ...probe,
      result: failure ? "failed" : probe.result,
      elapsedMs: Date.now() - start,
      ...(failure ? { errorCode: failure } : {}),
    });
  } catch (error) {
    const code = logCode(error instanceof CloudError ? error.code : "");
    log({
      event: "reconciliation",
      result: "failed",
      elapsedMs: Date.now() - start,
      errorCode: code,
    });
    // The platform may log uncaught exceptions: never rethrow raw binding errors.
    throw new CloudError(code, 503);
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
  return {
    state:
      row?.error || row?.state === "failed"
        ? "stale"
        : row?.state && row.state !== "complete"
          ? "updating"
          : row?.observed
            ? "idle"
            : "unknown",
    lastObservedAt: row?.observed ?? null,
    monitoring: "not_persisted",
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
      const work = (
        await env.DB.prepare(
          "SELECT vector_id FROM vector_work WHERE revision=? AND chunk_id IN (SELECT value FROM json_each(?))",
        )
          .bind(old.revision, JSON.stringify(chunks.map((c) => c.chunk_id)))
          .all<{ vector_id: string }>()
      ).results;
      if (work.length && !config(env).semantic) return;
      if (work.length) {
        const remaining = await env.VECTORS!.getByIds(
          work.map((w) => w.vector_id),
        );
        if (remaining.length) {
          await env.VECTORS!.deleteByIds(remaining.map((w) => w.id));
          return;
        }
      }
      const generation = await env.DB.prepare(
        "SELECT descriptor FROM embedding_generations WHERE revision=?",
      )
        .bind(old.revision)
        .first<{ descriptor: string }>();
      if (generation && !config(env).semantic) return;
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
            "DELETE FROM vector_work WHERE revision=? AND chunk_id=?",
          ).bind(old.revision, c.chunk_id),
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
      env.DB.prepare("DELETE FROM source_objects WHERE revision=?").bind(
        old.revision,
      ),
      env.DB.prepare("DELETE FROM source_observations WHERE revision=?").bind(
        old.revision,
      ),
      env.DB.prepare("DELETE FROM publications WHERE store=?").bind(
        old.revision,
      ),
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
    "SELECT id,kind,data FROM ingestion_jobs WHERE created<? AND state IN ('complete','failed','uploading','preparing') AND id IS NOT (SELECT job FROM ingestion_state WHERE id=1) ORDER BY created LIMIT 1",
  )
    .bind(cutoff)
    .first<{ id: string; kind: string; data: string }>();
  if (abandoned) {
    const data = JSON.parse(abandoned.data) as Data & {
      cleanupCursor?: string;
    };
    // A crash after R2 PUT but before the fenced checkpoint can leave no receipt.
    // Discover those objects by the owned job prefix; never delete published refs.
    if (
      abandoned.kind === "scan" &&
      data.parent &&
      revisionPattern.test(data.parent)
    ) {
      const page = await env.SOURCE.list({
        prefix: `${env.VAULT_ID}/${data.parent}/.updates/${abandoned.id}/`,
        limit: 100,
        cursor: data.cleanupCursor,
      });
      if (page.objects.length)
        await env.DB.prepare(
          "INSERT OR IGNORE INTO retired_objects SELECT value,? FROM json_each(?) WHERE NOT EXISTS(SELECT 1 FROM source_objects WHERE object_key=value)",
        )
          .bind(
            Date.now(),
            JSON.stringify(page.objects.map((object) => object.key)),
          )
          .run();
      if (page.truncated) {
        await env.DB.prepare(
          "UPDATE ingestion_jobs SET data=json_set(data,'$.cleanupCursor',?) WHERE id=?",
        )
          .bind(page.cursor, abandoned.id)
          .run();
        return;
      }
    }
    const prefix = `${env.VAULT_ID}/staging/${abandoned.id}/`;
    const objects = await env.SOURCE.list({ prefix, limit: 100 });
    if (objects.objects.length) {
      await env.SOURCE.delete(objects.objects.map((o) => o.key));
      return;
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM prepared_deltas WHERE job=?").bind(
        abandoned.id,
      ),
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
  const cache = await env.DB.prepare(
    "SELECT 1 FROM embedding_cache c WHERE c.created<? AND NOT EXISTS(SELECT 1 FROM ingestion_vectors v WHERE v.cache_key=c.key) AND NOT EXISTS(SELECT 1 FROM vector_work w WHERE w.input_key=c.key) AND NOT EXISTS(SELECT 1 FROM ingestion_jobs WHERE state NOT IN ('complete','failed','uploading','preparing')) LIMIT 1",
  )
    .bind(cutoff)
    .first();
  if (!cache) return;
  await env.DB.prepare(
    "DELETE FROM embedding_cache WHERE key IN (SELECT c.key FROM embedding_cache c WHERE c.created<? AND NOT EXISTS(SELECT 1 FROM ingestion_vectors v WHERE v.cache_key=c.key) AND NOT EXISTS(SELECT 1 FROM vector_work w WHERE w.input_key=c.key) LIMIT 16) AND NOT EXISTS(SELECT 1 FROM ingestion_jobs WHERE state NOT IN ('complete','failed','uploading','preparing'))",
  )
    .bind(cutoff)
    .run();
}

async function cleanupPending(env: Env) {
  const row = await env.DB.prepare(
    "SELECT EXISTS(SELECT 1 FROM snapshots WHERE vault_id=? AND revision NOT IN (SELECT revision FROM deployment)) OR EXISTS(SELECT 1 FROM ingestion_entries e JOIN ingestion_jobs j ON e.job=j.id WHERE j.kind='upload' AND j.state IN ('complete','failed')) OR EXISTS(SELECT 1 FROM embedding_cache c WHERE NOT EXISTS(SELECT 1 FROM ingestion_vectors v WHERE v.cache_key=c.key) AND NOT EXISTS(SELECT 1 FROM vector_work w WHERE w.input_key=c.key)) OR EXISTS(SELECT 1 FROM retired_vectors) OR EXISTS(SELECT 1 FROM retired_objects r WHERE NOT EXISTS(SELECT 1 FROM source_objects o WHERE o.object_key=r.object_key)) AS pending",
  )
    .bind(env.VAULT_ID)
    .first<{ pending: number }>();
  return !!row?.pending;
}

import {
  contentRevision,
  uploadLimit,
  type SourceKind,
} from "@vault-agent/core/portable";
import { type Env } from "./config.js";
import { CloudError, boundedBytes } from "./errors.js";

export type UploadBaseline = { digest: string | null; job: string };
export type UploadTarget = {
  path: string;
  kind: SourceKind;
  digest: string | null;
  etag: string | null;
  baseline_job?: string | null;
  upload_attempted?: number;
};

const conflict = () => new CloudError("UPLOAD_CONFLICT", 409);
export function baseline(env: Env, path: string) {
  return env.DB.prepare("SELECT digest,job FROM upload_baselines WHERE path=?")
    .bind(path)
    .first<UploadBaseline>();
}

/** Read one bounded current object; custom metadata is never a content digest. */
export async function currentUploadTarget(
  env: Env,
  path: string,
  kind: SourceKind,
) {
  const key = `${env.VAULT_ID}/source/${path}`;
  const object = await env.SOURCE!.head(key);
  if (!object) return { object: null, digest: null };
  if (object.customMetadata?.deleted === "true")
    return { object, digest: null };
  if (object.size > uploadLimit(kind)) throw conflict();
  if (object.checksums.sha256)
    return {
      object,
      digest: Array.from(new Uint8Array(object.checksums.sha256), (b) =>
        b.toString(16).padStart(2, "0"),
      ).join(""),
    };
  const body = await env.SOURCE!.get(key, {
    onlyIf: { etagMatches: object.etag },
  });
  if (!body || !("body" in body)) throw conflict();
  // ETags alone cannot distinguish same-byte rewrites; reject a changed observed
  // generation as well, before using its bytes as the comparison input.
  if (body.version !== object.version || body.size !== object.size) {
    await body.body.cancel();
    throw conflict();
  }
  const bytes = await boundedBytes(body.body, uploadLimit(kind));
  if (bytes.length !== object.size) throw conflict();
  return { object, digest: await contentRevision(bytes) };
}

function compare(
  prior: UploadBaseline | null,
  current: string | null,
  proposed: string | null,
) {
  if (current === proposed) return;
  if (prior ? prior.digest !== current : current !== null) throw conflict();
}

/** Capture a genuine common ancestor, never adopt HEAD's digest as a baseline. */
export async function captureUploadTarget(env: Env, entry: UploadTarget) {
  const prior = await baseline(env, entry.path);
  const current = await currentUploadTarget(env, entry.path, entry.kind);
  compare(prior, current.digest, entry.digest);
  return {
    etag: current.object?.etag ?? null,
    baseline_job: prior?.job ?? null,
  };
}

/** Recheck at commit; an attempted write with a lost receipt is not blindly retried. */
export async function checkUploadTarget(env: Env, entry: UploadTarget) {
  const prior = await baseline(env, entry.path);
  if ((prior?.job ?? null) !== (entry.baseline_job ?? null)) throw conflict();
  const current = await currentUploadTarget(env, entry.path, entry.kind);
  // A matching receipt and an independently identical object both need no PUT.
  if (current.digest === entry.digest) return { write: false };
  if (entry.upload_attempted) throw conflict();
  compare(prior, current.digest, entry.digest);
  if ((current.object?.etag ?? null) !== entry.etag)
    throw new CloudError("REVISION_CONFLICT", 409);
  return { write: true };
}

/** Include in the same fenced D1 batch as the processed checkpoint. */
export function acknowledgeUpload(env: Env, entry: UploadTarget, job: string) {
  return [
    env.DB.prepare(
      "INSERT OR REPLACE INTO ingestion_guard VALUES(1,CASE WHEN (SELECT job FROM upload_baselines WHERE path=?) IS ? THEN 1 ELSE 0 END)",
    ).bind(entry.path, entry.baseline_job ?? null),
    env.DB.prepare(
      "INSERT INTO upload_baselines(path,digest,job,acknowledged) VALUES(?,?,?,?) ON CONFLICT(path) DO UPDATE SET digest=excluded.digest,job=excluded.job,acknowledged=excluded.acknowledged",
    ).bind(entry.path, entry.digest, job, Date.now()),
  ];
}

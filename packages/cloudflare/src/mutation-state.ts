import type { Env } from "./config.js";
import { CloudError } from "./errors.js";

export interface R2MutationPath {
  path: string;
  note_id: string | null;
  owner: string;
  item_index: number;
  state: "saved" | "deleted" | "uncertain";
  digest: string | null;
  object_version: string | null;
  version: string | null;
  updated: number;
}
export async function mutationEpoch(env: Env): Promise<number | null> {
  const exists = await env.DB.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='r2_mutation_meta'",
  ).first();
  if (!exists) return null;
  const row = await env.DB.prepare(
    "SELECT epoch FROM r2_mutation_meta WHERE id=1",
  ).first<{ epoch: number }>();
  if (!row) throw new CloudError("INDEX_UNAVAILABLE", 503);
  return row.epoch;
}
export function mutationPath(env: Env, path: string) {
  return env.DB.prepare("SELECT * FROM r2_mutation_paths WHERE path=?")
    .bind(path)
    .first<R2MutationPath>();
}
/** Index membership never overrides a pending mutation, tombstone or newer generation. */
export async function mutationSuppression(env: Env, store: string) {
  const rows = await env.DB.prepare(
    "SELECT m.path,m.state,m.digest,m.object_version,s.digest AS indexed_digest,o.object_version AS indexed_version FROM r2_mutation_paths m JOIN sources s ON s.path=m.path AND s.revision=? LEFT JOIN source_observations o ON o.revision=s.revision AND o.path=s.path LIMIT 501",
  )
    .bind(store)
    .all<{
      path: string;
      state: string;
      digest: string | null;
      object_version: string | null;
      indexed_digest: string;
      indexed_version: string | null;
    }>();
  if (rows.results.length > 500)
    throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
  return new Set(
    rows.results
      .filter(
        (r) =>
          r.state !== "saved" ||
          r.digest !== r.indexed_digest ||
          r.object_version !== r.indexed_version,
      )
      .map((r) => r.path),
  );
}

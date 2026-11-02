import { config, type Env } from "./config.js";
import { R2MutationService } from "./mutations.js";
import { r2SourceVersion, type R2MutationPath } from "./mutation-state.js";
import { uploadKind } from "@vault-agent/core/portable";
import { CloudError } from "./errors.js";

export interface MutationMaintenanceSummary {
  recoveryInspected: number;
  cleanupInspected: number;
  pathsInspected: number;
  failed: boolean;
}
/** Existing-history maintenance only; never allocates IDs or writes source bytes. */
export async function maintainMutations(
  env: Env,
  deadline: number,
  now: () => number = Date.now,
): Promise<MutationMaintenanceSummary> {
  const result: MutationMaintenanceSummary = {
    recoveryInspected: 0,
    cleanupInspected: 0,
    pathsInspected: 0,
    failed: false,
  };
  if (env.SOURCE_PROVIDER === "pcloud" || !env.SOURCE) return result;
  try {
    if (
      !(await env.DB.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='r2_mutation_maintenance'",
      ).first())
    )
      return result;
    const history = await env.DB.prepare(
      "SELECT EXISTS(SELECT 1 FROM r2_mutation_operations) OR EXISTS(SELECT 1 FROM r2_mutation_paths) AS present",
    ).first<{ present: number }>();
    if (!history?.present || now() >= deadline) return result;
    config(env);
    const service = await R2MutationService.open(env, {
      settings: { enabled: true },
      now,
    });
    try {
      result.recoveryInspected = (await service.recover(4, deadline)).inspected;
    } catch {
      result.failed = true;
    }
    try {
      result.cleanupInspected = (await service.cleanup(2, deadline)).inspected;
    } catch {
      result.failed = true;
    }
    if (now() < deadline)
      result.pathsInspected = await refreshMutationPaths(env, 8, deadline, now);
  } catch {
    // No raw provider responses, paths, IDs, or credentials enter platform logs.
    result.failed = true;
  }
  return result;
}

/** A verified published generation, never a stale index alone, may restore access. */
export async function refreshMutationPaths(
  env: Env,
  limit = 8,
  deadline = Infinity,
  now: () => number = Date.now,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new CloudError("INVALID_REQUEST");
  const settings = config(env);
  const cursor = await env.DB.prepare(
    "SELECT refresh_cursor FROM r2_mutation_maintenance WHERE id=1",
  ).first<{ refresh_cursor: string }>();
  const rows = await env.DB.prepare(
    "SELECT * FROM r2_mutation_paths WHERE state IN ('saved','deleted') AND path>? ORDER BY path LIMIT ?",
  )
    .bind(cursor?.refresh_cursor ?? "", limit)
    .all<R2MutationPath>();
  let inspected = 0,
    last = cursor?.refresh_cursor ?? "";
  for (const row of rows.results) {
    if (now() >= deadline) break;
    inspected++;
    last = row.path;
    if (
      !settings.allowed(row.path) ||
      row.path.split("/").some((p) => p.startsWith(".")) ||
      !uploadKind(row.path)
    )
      continue;
    try {
      const head = await env.SOURCE!.head(`${env.VAULT_ID}/source/${row.path}`);
      const absent = !head || head.customMetadata?.deleted === "true";
      if (absent && row.state === "deleted") continue;
      let digest: string | null = null,
        version: string | null = null;
      if (!absent) {
        if (head.version === row.object_version) continue;
        const observed = await env.DB.prepare(
          "SELECT s.digest,s.size,o.object_version FROM deployment d JOIN sources s ON s.revision=d.revision AND s.path=? JOIN source_observations o ON o.revision=s.revision AND o.path=s.path WHERE d.id=1",
        )
          .bind(row.path)
          .first<{ digest: string; size: number; object_version: string }>();
        if (
          !observed ||
          observed.object_version !== head.version ||
          observed.size !== head.size
        )
          continue;
        digest = observed.digest;
        version = await r2SourceVersion(
          env.VAULT_ID,
          row.path,
          head.version,
          digest,
        );
      }
      await env.DB.batch([
        env.DB.prepare(
          "INSERT OR REPLACE INTO ingestion_guard VALUES(1,COALESCE((SELECT 1 FROM r2_mutation_paths WHERE path=? AND owner=? AND item_index=? AND state=? AND object_version IS ? AND updated=?),0))",
        ).bind(
          row.path,
          row.owner,
          row.item_index,
          row.state,
          row.object_version,
          row.updated,
        ),
        env.DB.prepare(
          "UPDATE r2_mutation_paths SET state=?,digest=?,object_version=?,version=?,updated=? WHERE path=?",
        ).bind(
          absent ? "deleted" : "saved",
          digest,
          head?.version ?? null,
          version,
          now(),
          row.path,
        ),
        env.DB.prepare("UPDATE r2_mutation_meta SET epoch=epoch+1 WHERE id=1"),
      ]);
    } catch {
      // A concurrent mutation wins; binding errors retain the prior suppression.
    }
  }
  const next =
    inspected === rows.results.length && rows.results.length < limit
      ? ""
      : last;
  if (next !== cursor?.refresh_cursor)
    await env.DB.prepare(
      "UPDATE r2_mutation_maintenance SET refresh_cursor=? WHERE id=1 AND refresh_cursor=?",
    )
      .bind(next, cursor?.refresh_cursor ?? "")
      .run();
  return inspected;
}

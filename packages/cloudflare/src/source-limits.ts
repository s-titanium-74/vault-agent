import { uploadLimit, type SourceKind } from "@vault-agent/core/portable";

/** Only previously opted-in mutation paths can exceed legacy source admission. */
export async function cloudSourceLimit(
  db: D1Database,
  path: string,
  kind: SourceKind,
  size: number,
) {
  const legacy = uploadLimit(kind);
  if (size <= legacy || kind === "attachment" || size > 20 * 1024 * 1024)
    return legacy;
  if (
    !(await db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='r2_mutation_paths'",
      )
      .first())
  )
    return legacy;
  const managed = await db
    .prepare("SELECT state FROM r2_mutation_paths WHERE path=?")
    .bind(path)
    .first<{ state: string }>();
  return managed && managed.state !== "uncertain" ? 20 * 1024 * 1024 : legacy;
}

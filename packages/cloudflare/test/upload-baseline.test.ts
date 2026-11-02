import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { VAULT_ID } from "../scripts/fixture.js";

let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let bucket: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
const admin = randomBytes(32).toString("hex");
const read = randomBytes(32).toString("hex");
const prefix = `${VAULT_ID}/source/`;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
async function request(
  route: string,
  input?: unknown,
  extra: Record<string, string> = {},
  method?: string,
) {
  const response = await mf.dispatchFetch(
    `https://vault.example.invalid${route}`,
    {
      method: method ?? (input === undefined ? "GET" : "POST"),
      headers: {
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
        ...extra,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    },
  );
  return { status: response.status, ...((await response.json()) as any) };
}
const entry = (path: string, text: string) => ({
  path,
  kind: path.endsWith(".md") ? "note" : "attachment",
  size: Buffer.byteLength(text),
  digest: sha(text),
  updated: "2026-01-01T00:00:00.000Z",
});
async function plan(path: string, text: string | null, id = randomUUID()) {
  const result = await request(
    "/uploads",
    {
      vaultId: VAULT_ID,
      parentRevision: null,
      includes: ["Notes", "images"],
      entries: text === null ? [] : [entry(path, text)],
      deletes: text === null ? [path] : [],
    },
    { "Idempotency-Key": id },
  );
  return { id, ...result };
}
async function stage(id: string, path: string, text: string) {
  const response = await mf.dispatchFetch(
    `https://vault.example.invalid/uploads/${id}/files/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${admin}` },
      body: text,
    },
  );
  expect(response.status).toBe(200);
}
async function apply(id: string, fault?: string) {
  const committed = await request(`/uploads/${id}/commit`, {});
  expect(committed.status).toBe(200);
  return request(
    `/jobs/${id}/advance`,
    { checkpoint: committed.data.checkpoint },
    fault ? { "X-Synthetic-Upload-Fault": fault } : {},
  );
}
async function resume(id: string) {
  await db
    .prepare("UPDATE ingestion_jobs SET lease_until=0 WHERE id=?")
    .bind(id)
    .run();
  const job = (await request(`/jobs/${id}`)).data;
  return request(`/jobs/${id}/advance`, { checkpoint: job.checkpoint });
}
async function uploaded(path: string, text: string | null) {
  const job = await plan(path, text);
  expect(job.status).toBe(200);
  if (text !== null) await stage(job.id, path, text);
  const result = await apply(job.id);
  expect(result.data.error).toBeNull();
  await resume(job.id);
  return job.id;
}
async function baseline(path: string) {
  return db
    .prepare("SELECT * FROM upload_baselines WHERE path=?")
    .bind(path)
    .first();
}
beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["test/upload-baseline-worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    tsconfig: "tsconfig.json",
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-10-28",
      d1Databases: { DB: "upload-baseline", LEGACY: "upload-baseline-legacy" },
      r2Buckets: { SOURCE: "upload-baseline" },
      ratelimits: {
        REQUEST_LIMITER: {
          namespace_id: "1054",
          simple: { limit: 100000, period: 60 },
        },
      },
      bindings: {
        VAULT_ID,
        READ_TOKEN: read,
        ADMIN_TOKEN: admin,
        INCLUDE_PATHS: '["Notes","images"]',
        EXCLUDE_PATHS: "[]",
        ALLOWED_ORIGINS: "[]",
        PROFILE_VALUE_ALLOWLIST: "[]",
        INGESTION_ENABLED: "true",
        EXTERNAL_EMBEDDING_CONSENT: "false",
      },
    }),
  );
  db = await mf.getD1Database("DB");
  bucket = await mf.getR2Bucket("SOURCE");
  for (const name of (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    for (const sql of (await readFile(`migrations/${name}`, "utf8"))
      .replace(/--[^\n]*/g, "")
      .split(";")
      .filter((s) => s.trim()))
      await db.prepare(sql).run();
});
afterAll(async () => mf?.dispose());

describe("durable upload common ancestor", () => {
  it("migrates without inventing baselines and fences old upload binaries/plans", async () => {
    const legacy = await mf.getD1Database("LEGACY");
    const runMigration = async (name: string) => {
      for (const sql of (await readFile(`migrations/${name}`, "utf8"))
        .replace(/--[^\n]*/g, "")
        .split(";")
        .filter((s) => s.trim()))
        await legacy.prepare(sql).run();
    };
    for (const name of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql") && n < "0006")
      .sort())
      await runMigration(name);
    for (const state of [
      "preparing",
      "uploading",
      "applying",
      "complete",
      "failed",
    ])
      await legacy
        .prepare(
          "INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,created,lease,lease_until) VALUES(?,?,'upload',?,'{}',0,'legacy-token',9999999999999)",
        )
        .bind(state, state, state)
        .run();
    await runMigration("0006_upload_baselines.sql");
    expect(
      (await legacy.prepare("SELECT * FROM upload_baselines").all()).results,
    ).toEqual([]);
    for (const state of ["preparing", "uploading", "applying"])
      expect(
        await legacy
          .prepare(
            "SELECT state,error,lease,lease_until FROM ingestion_jobs WHERE id=?",
          )
          .bind(state)
          .first(),
      ).toMatchObject({
        state: "failed",
        error: "UPLOAD_BASELINE_REQUIRED",
        lease: null,
        lease_until: 0,
      });
    expect(
      await legacy
        .prepare("SELECT state FROM ingestion_jobs WHERE id='complete'")
        .first(),
    ).toEqual({ state: "complete" });
    await expect(
      legacy
        .prepare(
          "INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,created) VALUES('old','old','upload','preparing','{}',0)",
        )
        .run(),
    ).rejects.toThrow();
    await expect(
      legacy
        .prepare(
          "UPDATE ingestion_jobs SET state='applying' WHERE id='applying'",
        )
        .run(),
    ).rejects.toThrow();
    await legacy
      .prepare(
        "INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,created) VALUES('new','new','upload','preparing','{\"uploadContract\":2}',0)",
      )
      .run();
  });
  it("creates then updates unchanged cloud content and persists content-free baselines", async () => {
    const path = "Notes/Normal.md";
    await uploaded(path, "# Synthetic\nfirst\n");
    const id = await uploaded(path, "# Synthetic\nsecond\n");
    expect(await baseline(path)).toMatchObject({
      digest: sha("# Synthetic\nsecond\n"),
      job: id,
    });
    expect(JSON.stringify(await baseline(path))).not.toContain("Synthetic");
    expect(await (await bucket.get(prefix + path))!.text()).toContain("second");
  });
  it.each(["Notes/Prior-edit.md", "images/prior.png"])(
    "rejects prior cloud edits before staging: %s",
    async (path) => {
      await uploaded(path, "original");
      await bucket.put(prefix + path, "cloud-edit");
      const result = await plan(path, "local-edit");
      expect(result).toMatchObject({
        status: 409,
        error: { code: "UPLOAD_CONFLICT" },
      });
      expect(
        await db
          .prepare("SELECT id FROM ingestion_jobs WHERE id=?")
          .bind(result.id)
          .first(),
      ).toBeNull();
      expect(
        (await bucket.list({ prefix: `${VAULT_ID}/staging/${result.id}/` }))
          .objects,
      ).toHaveLength(0);
      expect(await (await bucket.get(prefix + path))!.text()).toBe(
        "cloud-edit",
      );
    },
  );
  it.each(["physical", "marker"])(
    "does not recreate a cloud deletion (%s)",
    async (kind) => {
      const path = `Notes/Deleted-${kind}.md`;
      await uploaded(path, "ancestor");
      if (kind === "physical") await bucket.delete(prefix + path);
      else
        await bucket.put(prefix + path, "", {
          customMetadata: { deleted: "true" },
        });
      expect(await plan(path, "ancestor")).toMatchObject({
        status: 409,
        error: { code: "UPLOAD_CONFLICT" },
      });
    },
  );
  it("rejects an unknown existing target and allows identical adoption without a rewrite", async () => {
    const path = "Notes/Legacy.md";
    await bucket.put(prefix + path, "legacy content");
    expect(await plan(path, "different")).toMatchObject({
      status: 409,
      error: { code: "UPLOAD_CONFLICT" },
    });
    const before = await bucket.head(prefix + path);
    const id = await uploaded(path, "legacy content");
    expect((await bucket.head(prefix + path))!.version).toBe(before!.version);
    expect(await baseline(path)).toMatchObject({
      digest: sha("legacy content"),
      job: id,
    });
    await uploaded(path, "next version");
  });
  it("acknowledges identical independently edited content without overwriting it", async () => {
    const path = "Notes/Agree.md";
    await uploaded(path, "ancestor");
    await bucket.put(prefix + path, "agreed");
    const before = await bucket.head(prefix + path);
    await uploaded(path, "agreed");
    expect((await bucket.head(prefix + path))!.version).toBe(before!.version);
  });
  it("protects explicit deletes from prior cloud edits and preserves deletion baselines", async () => {
    const path = "Notes/Delete.md";
    await uploaded(path, "ancestor");
    await bucket.put(prefix + path, "cloud edit");
    expect(await plan(path, null)).toMatchObject({
      status: 409,
      error: { code: "UPLOAD_CONFLICT" },
    });
    await uploaded(path, "cloud edit");
    const id = await uploaded(path, null);
    expect(await baseline(path)).toMatchObject({ digest: null, job: id });
    expect((await bucket.head(prefix + path))!.customMetadata?.deleted).toBe(
      "true",
    );
    await uploaded(path, "explicit recreation");
  });
  it("protects unknown deletes, while absent deletes are harmless no-ops", async () => {
    const path = "Notes/Unknown-delete.md";
    await bucket.put(prefix + path, "cloud only");
    expect(await plan(path, null)).toMatchObject({
      status: 409,
      error: { code: "UPLOAD_CONFLICT" },
    });
    const absent = "Notes/Already-absent.md";
    await uploaded(absent, null);
    expect(await bucket.head(prefix + absent)).toBeNull();
    expect(await baseline(absent)).toMatchObject({ digest: null });
  });
  it("checks additional manifest pages and leaves rejected targets unstaged", async () => {
    const job = await plan("Notes/Page-one.md", "first");
    await bucket.put(prefix + "Notes/Page-two.md", "cloud only");
    const result = await request(
      `/uploads/${job.id}/manifest`,
      { entries: [entry("Notes/Page-two.md", "local")], deletes: [] },
      {},
      "PUT",
    );
    expect(result).toMatchObject({
      status: 409,
      error: { code: "UPLOAD_CONFLICT" },
    });
    expect(
      await db
        .prepare("SELECT path FROM ingestion_entries WHERE job=? AND path=?")
        .bind(job.id, "Notes/Page-two.md")
        .first(),
    ).toBeNull();
    expect(await bucket.head(prefix + "Notes/Page-one.md")).toBeNull();
  });
  it("checks deletes on additional manifest pages", async () => {
    const path = "Notes/Page-delete.md";
    await uploaded(path, "ancestor");
    await bucket.put(prefix + path, "cloud edit");
    const job = await plan("Notes/Page-delete-first.md", "first");
    expect(
      await request(
        `/uploads/${job.id}/manifest`,
        { entries: [], deletes: [path] },
        {},
        "PUT",
      ),
    ).toMatchObject({ status: 409, error: { code: "UPLOAD_CONFLICT" } });
    expect(await (await bucket.get(prefix + path))!.text()).toBe("cloud edit");
  });
  it.each([false, true])(
    "rechecks cloud content after admission (delete=%s)",
    async (deleting) => {
      const path = `Notes/Late-${deleting}.md`;
      await uploaded(path, "ancestor");
      const job = await plan(path, deleting ? null : "local edit");
      if (!deleting) await stage(job.id, path, "local edit");
      await bucket.put(prefix + path, "late cloud edit");
      const result = await apply(job.id);
      expect(result.data).toMatchObject({
        state: "failed",
        error: { code: "UPLOAD_CONFLICT" },
      });
      expect(await (await bucket.get(prefix + path))!.text()).toBe(
        "late cloud edit",
      );
    },
  );
  it("retains conditional PUT at the last write boundary", async () => {
    const path = "Notes/Conditional.md";
    await uploaded(path, "ancestor");
    const job = await plan(path, "local edit");
    await stage(job.id, path, "local edit");
    const result = await apply(job.id, "racing-edit");
    expect(result.data).toMatchObject({
      state: "failed",
      error: { code: "REVISION_CONFLICT" },
    });
    expect(await (await bucket.get(prefix + path))!.text()).toContain(
      "late cloud edit",
    );
  });
  it("rejects a competing plan after another upload acknowledged the path", async () => {
    const path = "Notes/Competing.md";
    await uploaded(path, "ancestor");
    const stale = await plan(path, "stale desired");
    await stage(stale.id, path, "stale desired");
    const newer = await uploaded(path, "newer desired");
    expect((await apply(stale.id)).data).toMatchObject({
      state: "failed",
      error: { code: "UPLOAD_CONFLICT" },
    });
    expect(await baseline(path)).toMatchObject({
      job: newer,
      digest: sha("newer desired"),
    });
  });
  it("recovers a lost PUT receipt without rewriting R2", async () => {
    const path = "Notes/Lost-receipt.md";
    await uploaded(path, "ancestor");
    const job = await plan(path, "desired");
    await stage(job.id, path, "desired");
    expect((await apply(job.id, "after-put")).status).toBe(500);
    const before = await bucket.head(prefix + path);
    expect(await baseline(path)).toMatchObject({ digest: sha("ancestor") });
    expect((await resume(job.id)).data.error).toBeNull();
    expect((await bucket.head(prefix + path))!.version).toBe(before!.version);
    expect(await baseline(path)).toMatchObject({
      digest: sha("desired"),
      job: job.id,
    });
  });
  it("rolls back an obsolete acknowledgment and preserves a newer baseline/checkpoint", async () => {
    const path = "Notes/Ack-race.md";
    await uploaded(path, "ancestor");
    const job = await plan(path, "desired");
    await stage(job.id, path, "desired");
    const result = await apply(job.id, "newer-ack");
    expect(result.data.state).toBe("failed");
    expect(await baseline(path)).toMatchObject({
      job: "synthetic-newer-owner",
      digest: sha("# Synthetic\nnewer acknowledged upload\n"),
    });
    expect(
      await db
        .prepare(
          "SELECT processed FROM ingestion_entries WHERE job=? AND path=?",
        )
        .bind(job.id, path)
        .first(),
    ).toEqual({ processed: 0 });
    expect(await (await bucket.get(prefix + path))!.text()).toContain(
      "newer acknowledged upload",
    );
  });
  it("acknowledges a saved source through a fresh identical plan after a failed D1 commit", async () => {
    const path = "Notes/D1-failure.md";
    await uploaded(path, "ancestor");
    await db
      .prepare(
        "CREATE TRIGGER synthetic_baseline_failure BEFORE UPDATE ON upload_baselines WHEN NEW.path='Notes/D1-failure.md' BEGIN SELECT RAISE(ABORT,'synthetic'); END",
      )
      .run();
    const job = await plan(path, "desired");
    await stage(job.id, path, "desired");
    expect((await apply(job.id)).data.state).toBe("failed");
    expect(await baseline(path)).toMatchObject({ digest: sha("ancestor") });
    expect(
      await db
        .prepare(
          "SELECT processed FROM ingestion_entries WHERE job=? AND path=?",
        )
        .bind(job.id, path)
        .first(),
    ).toEqual({ processed: 0 });
    const before = await bucket.head(prefix + path);
    await db.prepare("DROP TRIGGER synthetic_baseline_failure").run();
    await uploaded(path, "desired");
    expect((await bucket.head(prefix + path))!.version).toBe(before!.version);
    expect(await baseline(path)).toMatchObject({ digest: sha("desired") });
  });
  it("allows only one of two concurrent different plans to change a source", async () => {
    const path = "Notes/Concurrent.md";
    await uploaded(path, "ancestor");
    const first = await plan(path, "first");
    const second = await plan(path, "second");
    await stage(first.id, path, "first");
    await stage(second.id, path, "second");
    const results = await Promise.all([apply(first.id), apply(second.id)]);
    expect(
      results.filter((result) => result.data.state === "failed"),
    ).toHaveLength(1);
    const text = await (await bucket.get(prefix + path))!.text();
    expect(["first", "second"]).toContain(text);
    expect(await baseline(path)).toMatchObject({ digest: sha(text) });
  });
  it.each(["ancestor", "different cloud edit"])(
    "never replays an uncertain PUT over subsequent content: %s",
    async (text) => {
      const path = `Notes/Uncertain-${text === "ancestor" ? "revert" : "edit"}.md`;
      await uploaded(path, "ancestor");
      const job = await plan(path, "desired");
      await stage(job.id, path, "desired");
      expect((await apply(job.id, "after-put")).status).toBe(500);
      await bucket.put(prefix + path, text);
      expect((await resume(job.id)).data).toMatchObject({
        state: "failed",
        error: { code: "UPLOAD_CONFLICT" },
      });
      expect(await (await bucket.get(prefix + path))!.text()).toBe(text);
      expect(await baseline(path)).toMatchObject({ digest: sha("ancestor") });
    },
  );
  it("fails closed after an attempt was recorded but no PUT receipt exists", async () => {
    const path = "Notes/Attempt-only.md";
    await uploaded(path, "ancestor");
    const job = await plan(path, "desired");
    await stage(job.id, path, "desired");
    expect((await apply(job.id, "before-put")).status).toBe(500);
    expect((await resume(job.id)).data).toMatchObject({
      state: "failed",
      error: { code: "UPLOAD_CONFLICT" },
    });
    expect(await (await bucket.get(prefix + path))!.text()).toBe("ancestor");
  });
  it("retains baselines after expiring job history and does not infer one from indexes", async () => {
    const path = "Notes/Retained.md";
    const id = await uploaded(path, "ancestor");
    await db
      .prepare("DELETE FROM ingestion_entries WHERE job=?")
      .bind(id)
      .run();
    await db.prepare("DELETE FROM ingestion_jobs WHERE id=?").bind(id).run();
    await bucket.put(prefix + path, "later cloud edit");
    expect(await baseline(path)).toMatchObject({
      job: id,
      digest: sha("ancestor"),
    });
    expect(await plan(path, "ancestor")).toMatchObject({
      status: 409,
      error: { code: "UPLOAD_CONFLICT" },
    });
  });
});

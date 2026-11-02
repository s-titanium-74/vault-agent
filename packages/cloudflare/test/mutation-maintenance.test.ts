import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import * as core from "../../core/src/portable/index.js";
import { VAULT_ID } from "../scripts/fixture.js";
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let bucket: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
const admin = randomBytes(32).toString("hex"),
  read = randomBytes(32).toString("hex");
const prefix = `${VAULT_ID}/source/`,
  now = Date.now();
async function req(path: string, input?: unknown) {
  const response = await mf.dispatchFetch(
    `https://vault.example.invalid${path}`,
    {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    },
  );
  return { status: response.status, ...((await response.json()) as any) };
}
async function action(action: string, args: Record<string, unknown> = {}) {
  return req("/__mutations", { action, now, ...args });
}
async function source(path: string) {
  return (await action("read", { path })).data;
}
async function note(path: string) {
  return req(`/notes/${await core.noteIdFromPath(path)}`);
}
async function mutate(
  operations: unknown[],
  options: Record<string, unknown> = {},
) {
  const op = await action("preview", { input: { operations }, ...options });
  expect(op.status, JSON.stringify(op)).toBe(200);
  return action("apply", {
    id: op.data.operation_id,
    binding: op.data.preview_binding,
    input: { operations },
    ...options,
  });
}
async function drive(job: any) {
  for (let n = 0; n < 600 && !["complete", "failed"].includes(job.state); n++)
    job = (
      await req(`/jobs/${job.jobId}/advance`, { checkpoint: job.checkpoint })
    ).data;
  expect(job.state, JSON.stringify(job)).toBe("complete");
  return job;
}
async function publish(rebuild = false) {
  const pending = await db
    .prepare(
      "SELECT j.id,j.checkpoint FROM ingestion_state s JOIN ingestion_jobs j ON j.id=s.job WHERE j.state NOT IN ('complete','failed')",
    )
    .first<{ id: string; checkpoint: number }>();
  if (pending) await drive((await req(`/jobs/${pending.id}`)).data);
  return drive(
    (await req(rebuild ? "/reindex" : "/index", { newScan: true })).data,
  );
}
beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["test/mutations-worker.ts"],
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
      d1Databases: { DB: "maintenance", LEGACY: "maintenance-legacy" },
      r2Buckets: { SOURCE: "maintenance" },
      ratelimits: {
        REQUEST_LIMITER: {
          namespace_id: "1056",
          simple: { limit: 100000, period: 60 },
        },
      },
      bindings: {
        VAULT_ID,
        READ_TOKEN: read,
        ADMIN_TOKEN: admin,
        INCLUDE_PATHS: '["."]',
        EXCLUDE_PATHS: '["**/secret.md"]',
        ALLOWED_ORIGINS: "[]",
        PROFILE_VALUE_ALLOWLIST: "[]",
        INGESTION_ENABLED: "true",
        EXTERNAL_EMBEDDING_CONSENT: "false",
        EMBEDDING_MODEL_REVISION: "operator-v1",
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
  await bucket.put(
    prefix + "Notes/Keep.md",
    "# Keep\nSynthetic unrelated orchard.",
  );
  await publish();
});
afterAll(async () => mf?.dispose());

it("migrates captured retention without extending terminal deadlines or expiring unresolved state", async () => {
  const legacy = await mf.getD1Database("LEGACY");
  const migrate = async (name: string) => {
    for (const sql of (await readFile(`migrations/${name}`, "utf8"))
      .replace(/--[^\n]*/g, "")
      .split(";")
      .filter((s) => s.trim()))
      await legacy.prepare(sql).run();
  };
  for (const file of (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql") && n < "0008")
    .sort())
    await migrate(file);
  for (const state of ["completed", "reconciling"])
    await legacy
      .prepare(
        "INSERT INTO r2_mutation_operations(id,nonce,digest,policy,issued,expires,preview,state,completed,cleanup_after) VALUES(?,?,?, ?,0,86400000,1,?,100,86400100)",
      )
      .bind(state, state, "synthetic-digest", "synthetic-policy", state)
      .run();
  await migrate("0008_r2_mutation_maintenance.sql");
  expect(
    await legacy
      .prepare(
        "SELECT retention_ms,completed,cleanup_after FROM r2_mutation_operations WHERE id='completed'",
      )
      .first(),
  ).toEqual({
    retention_ms: 86400000,
    completed: 100,
    cleanup_after: 86400100,
  });
  expect(
    await legacy
      .prepare(
        "SELECT retention_ms,completed,cleanup_after FROM r2_mutation_operations WHERE id='reconciling'",
      )
      .first(),
  ).toEqual({ retention_ms: 86400000, completed: null, cleanup_after: null });
});

it("does no R2 maintenance or durable writes without mutation history", async () => {
  const epoch = (await db
    .prepare("SELECT epoch FROM r2_mutation_meta")
    .first())!.epoch;
  expect((await action("maintain")).data).toEqual({
    recoveryInspected: 0,
    cleanupInspected: 0,
    pathsInspected: 0,
    failed: false,
  });
  expect(
    (await db.prepare("SELECT epoch FROM r2_mutation_meta").first())!.epoch,
  ).toBe(epoch);
  expect(
    (await bucket.list({ prefix: `${VAULT_ID}/mutations/` })).objects,
  ).toHaveLength(0);
});
it("resumes a lost source receipt through the scheduled path even with ingestion disabled", async () => {
  const result = await mutate(
    [
      {
        type: "create_note",
        path: "Notes/Recovered.md",
        content: "# Recovered\nSynthetic body",
      },
    ],
    { interrupt: "published" },
  );
  expect(result.error.code).toBe("INTERRUPTED");
  const before = (await bucket.head(prefix + "Notes/Recovered.md"))!.version;
  await db
    .prepare(
      "UPDATE r2_mutation_operations SET lease_until=0 WHERE state='applying'",
    )
    .run();
  const jobs = (await db
    .prepare("SELECT count(*) AS n FROM ingestion_jobs")
    .first())!.n;
  await req("/__tick?ingestion=false");
  expect((await note("Notes/Recovered.md")).data.content).toContain(
    "Synthetic body",
  );
  expect((await bucket.head(prefix + "Notes/Recovered.md"))!.version).toBe(
    before,
  );
  expect(
    (await db.prepare("SELECT count(*) AS n FROM ingestion_jobs").first())!.n,
  ).toBe(jobs);
  expect(
    (await db.prepare("SELECT state FROM r2_mutation_operations").first())!
      .state,
  ).toBe("completed");
});
it("finishes an expired invocation whose items were already acknowledged", async () => {
  await mutate(
    [
      {
        type: "create_note",
        path: "Notes/Applied.md",
        content: "acknowledged",
      },
    ],
    { interrupt: "applied" },
  );
  await db
    .prepare(
      "UPDATE r2_mutation_operations SET lease_until=0 WHERE state='applying'",
    )
    .run();
  await req("/__tick?ingestion=false");
  expect(
    (await db
      .prepare(
        "SELECT count(*) AS n FROM r2_mutation_operations WHERE state='applying'",
      )
      .first())!.n,
  ).toBe(0);
});
it("does not let unresolved early receipts starve later recovery, and never clears their suppression", async () => {
  for (let i = 0; i < 5; i++)
    await mutate(
      [
        {
          type: "create_note",
          path: `Notes/Uncertain-${i}.md`,
          content: "never dispatched",
        },
      ],
      { interrupt: "committing" },
    );
  await mutate(
    [{ type: "create_note", path: "Notes/Fair-recovery.md", content: "saved" }],
    { interrupt: "published" },
  );
  await db
    .prepare(
      "UPDATE r2_mutation_operations SET lease_until=0 WHERE state='applying'",
    )
    .run();
  for (let i = 0; i < 3; i++) {
    const result = (await action("maintain", { now: now + 120001 })).data;
    expect(result.recoveryInspected).toBeLessThanOrEqual(4);
  }
  expect((await note("Notes/Fair-recovery.md")).data.content).toBe("saved");
  expect((await note("Notes/Uncertain-0.md")).status).toBe(503);
  expect(
    (await db
      .prepare(
        "SELECT count(*) AS n FROM r2_mutation_paths WHERE state='uncertain'",
      )
      .first())!.n,
  ).toBe(5);
});
it("stops admitting maintenance work at the deadline and skips pCloud", async () => {
  expect((await action("maintain", { deadline: now })).data).toEqual({
    recoveryInspected: 0,
    cleanupInspected: 0,
    pathsInspected: 0,
    failed: false,
  });
  expect((await action("maintain", { provider: "pcloud" })).data).toEqual({
    recoveryInspected: 0,
    cleanupInspected: 0,
    pathsInspected: 0,
    failed: false,
  });
});
it("observes external absence and does not restore a recreated path from the old index", async () => {
  const path = "Notes/Recreated.md";
  await mutate([
    { type: "create_note", path, content: "# Original\nOldSourceMarker" },
  ]);
  await publish();
  await bucket.delete(prefix + path);
  await action("refresh", { limit: 100 });
  expect((await note(path)).status).toBe(404);
  expect(
    (await req("/search", { query: "OldSourceMarker", mode: "lexical" })).data
      .results,
  ).toEqual([]);
  await bucket.put(prefix + path, "# Recreated\nFreshSourceMarker");
  await action("refresh", { limit: 100 });
  expect((await note(path)).status).toBe(404);
  await publish();
  await action("refresh", { limit: 100 });
  expect((await note(path)).data.content).toContain("FreshSourceMarker");
  expect(
    (await req("/search", { query: "FreshSourceMarker", mode: "lexical" })).data
      .results[0].path,
  ).toBe(path);
  expect(
    await db
      .prepare("SELECT path FROM upload_baselines WHERE path=?")
      .bind(path)
      .first(),
  ).toBeNull();
});
it("keeps mutation deletion suppressed until a verified recreated generation is published", async () => {
  const path = "Notes/Deleted-then-recreated.md";
  await mutate([{ type: "create_note", path, content: "old" }]);
  await publish();
  const expected_version = (await source(path)).version;
  const deletion = (
    await mutate([{ type: "delete_file", path, expected_version }])
  ).data;
  await bucket.put(prefix + path, "explicit external recreation");
  await action("refresh", { limit: 100 });
  expect((await note(path)).status).toBe(404);
  await publish();
  await action("refresh", { limit: 100 });
  expect((await note(path)).data.content).toBe("explicit external recreation");
  expect(
    (await action("status", { id: deletion.operation_id })).data.results[0]
      .index_state,
  ).toBe("pending");
});
it("keeps uncertain paths blocked even when indexing can observe external content", async () => {
  await bucket.put(prefix + "Notes/Uncertain-0.md", "external source");
  await publish();
  await action("refresh", { limit: 100 });
  expect((await note("Notes/Uncertain-0.md")).status).toBe(503);
});
it("advances a bounded durable path cursor without widening the configured scope", async () => {
  const first = (await action("refresh", { limit: 2 })).data;
  expect(first).toBe(2);
  const cursor = (await db
    .prepare("SELECT refresh_cursor FROM r2_mutation_maintenance")
    .first())!.refresh_cursor;
  await action("refresh", { limit: 2 });
  expect(
    (await db
      .prepare("SELECT refresh_cursor FROM r2_mutation_maintenance")
      .first())!.refresh_cursor,
  ).not.toBe(cursor);
});
it("indexes a managed oversized note as metadata only in both incremental and full publication", async () => {
  const path = "Notes/Large.md",
    content =
      "---\ntitle: Large synthetic note\ntags: [oversized]\n---\n" +
      "x".repeat(2 * 1024 * 1024 + 128);
  const result = (await mutate([{ type: "create_note", path, content }])).data;
  expect(result.results[0]).toMatchObject({
    status: "applied",
    oversized_for_index: true,
  });
  await publish();
  const id = await core.noteIdFromPath(path);
  for (const rebuild of [false, true]) {
    if (rebuild) await publish(true);
    const row = await db
      .prepare(
        "SELECT data FROM notes WHERE revision=(SELECT revision FROM deployment WHERE id=1) AND note_id=?",
      )
      .bind(id)
      .first<{ data: string }>();
    expect(JSON.parse(row!.data)).toMatchObject({
      oversized: 1,
      body_text: "",
      frontmatter_title: "Large synthetic note",
    });
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM chunks WHERE revision=(SELECT revision FROM deployment WHERE id=1) AND note_id=?",
        )
        .bind(id)
        .first())!.n,
    ).toBe(0);
    expect((await req(`/notes/${id}?allowLarge=true`)).data.content).toBe(
      content,
    );
    expect((await note("Notes/Keep.md")).status).toBe(200);
  }
  expect(
    (await action("status", { id: result.operation_id })).data.results[0]
      .index_state,
  ).toBe("fresh");
}, 30000);
it("keeps the unmanaged oversized source and upload admission limits unchanged", async () => {
  const path = "Notes/Unmanaged-large.md";
  await bucket.put(prefix + path, "y".repeat(2 * 1024 * 1024 + 1));
  const start = (await req("/index", { newScan: true })).data;
  let job = start;
  for (let n = 0; n < 20 && job.state !== "failed"; n++)
    job = (
      await req(`/jobs/${job.jobId}/advance`, { checkpoint: job.checkpoint })
    ).data;
  expect(job.error.code).toBe("UPLOAD_TOO_LARGE");
  await bucket.delete(prefix + path);
});
it("cleans terminal staging at the captured retention without deleting unresolved state or source bytes", async () => {
  const path = "Notes/Retention.md";
  const result = (
    await mutate([{ type: "create_note", path, content: "retained source" }], {
      settings: { history_retention_days: 1 },
    })
  ).data;
  const before = await db
    .prepare(
      "SELECT cleanup_after,retention_ms FROM r2_mutation_operations WHERE id=?",
    )
    .bind(result.operation_id)
    .first();
  expect(before!.retention_ms).toBe(86400000);
  await action("maintain", {
    now: now + 12 * 3600000,
    settings: { history_retention_days: 7 },
  });
  expect(
    await db
      .prepare(
        "SELECT cleanup_after,retention_ms FROM r2_mutation_operations WHERE id=?",
      )
      .bind(result.operation_id)
      .first(),
  ).toEqual(before);
  for (let n = 0; n < 20; n++)
    await action("maintain", { now: now + 2 * 86400000 });
  expect(
    await db
      .prepare("SELECT id FROM r2_mutation_operations WHERE id=?")
      .bind(result.operation_id)
      .first(),
  ).toBeNull();
  expect((await note(path)).data.content).toBe("retained source");
  expect((await note("Notes/Uncertain-0.md")).status).toBe(503);
});
it("defers failed private-stage cleanup without blocking unrelated indexing or deleting source bytes", async () => {
  await db
    .prepare(
      "UPDATE r2_mutation_operations SET cleanup_after=0,cleanup_retry_after=0 WHERE state='completed'",
    )
    .run();
  await bucket.put(
    prefix + "Notes/Progress.md",
    "# Progress\nFresh unrelated content.",
  );
  await req("/__tick?staging_failure=true");
  await publish();
  expect((await note("Notes/Progress.md")).data.content).toContain(
    "Fresh unrelated content",
  );
  expect((await note("Notes/Uncertain-0.md")).status).toBe(503);
  expect((await note("Notes/Keep.md")).status).toBe(200);
  const result = await action("maintain", {
    staging_failure: true,
    now: now + 30 * 86400000,
  });
  expect(JSON.stringify(result)).not.toContain("private provider response");
});

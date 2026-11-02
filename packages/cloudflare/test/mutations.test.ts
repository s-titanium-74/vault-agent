import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import * as core from "../../core/src/portable/index.js";
import { VAULT_ID } from "../scripts/fixture.js";
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let bucket: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
const admin = randomBytes(32).toString("hex"),
  read = randomBytes(32).toString("hex");
const prefix = `${VAULT_ID}/source/`;
const now = Date.now();
async function req(path: string, input?: unknown, token = admin) {
  const response = await mf.dispatchFetch(
    `https://vault.example.invalid${path}`,
    {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    },
  );
  return { status: response.status, ...((await response.json()) as any) };
}
async function internal(action: string, args: Record<string, unknown> = {}) {
  return req("/__mutations", { action, now, ...args });
}
async function latest(path: string) {
  return (await internal("read", { path })).data;
}
async function preview(
  operations: unknown[],
  args: Record<string, unknown> = {},
) {
  return internal("preview", { input: { operations }, ...args });
}
async function apply(
  op: any,
  operations: unknown[],
  args: Record<string, unknown> = {},
) {
  return internal("apply", {
    id: op.operation_id,
    binding: op.preview_binding,
    input: { operations },
    ...args,
  });
}
async function mutate(
  operations: unknown[],
  args: Record<string, unknown> = {},
) {
  const op = await preview(operations, args);
  expect(op.status, JSON.stringify(op)).toBe(200);
  const result = await apply(op.data, operations, args);
  expect(result.status, JSON.stringify(result)).toBe(200);
  return result.data;
}
async function note(path: string) {
  return req(`/notes/${await core.noteIdFromPath(path)}`, undefined, read);
}
async function publish() {
  let job = (await req("/index", { newScan: true })).data;
  for (let n = 0; n < 300 && !["complete", "failed"].includes(job.state); n++)
    job = (
      await req(`/jobs/${job.jobId}/advance`, { checkpoint: job.checkpoint })
    ).data;
  expect(job.state, JSON.stringify(job)).toBe("complete");
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
      d1Databases: { DB: "mutations" },
      r2Buckets: { SOURCE: "mutations" },
      ratelimits: {
        REQUEST_LIMITER: {
          namespace_id: "1055",
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
  for (const [path, content] of Object.entries({
    "Notes/Keep.md": "# Keep\nSynthetic orchard. [[Target]]\n",
    "Notes/Target.md":
      "---\ntitle: Old synthetic title\ntags: [private-marker]\n---\n# Target\nUniqueDeletedMarker\n",
    "images/target.svg": "<svg>synthetic attachment</svg>",
    "AGENTS.md": "# Guidance\nSynthetic guidance.",
  }))
    await bucket.put(prefix + path, content);
  await publish();
});
afterAll(async () => mf?.dispose());
describe("internal R2 mutations and durable read suppression", () => {
  it("keeps public Workers tools read-only and rejects disabled internal capability", async () => {
    expect(
      await preview(
        [{ type: "create_note", path: "Notes/Disabled.md", content: "never" }],
        { settings: { enabled: false } },
      ),
    ).toMatchObject({ error: { code: "WRITE_DISABLED" } });
    const tools = await req(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      admin,
    );
    expect(tools.result.tools.map((t: any) => t.name)).not.toContain(
      "apply_changes",
    );
    const call = await req("/mcp", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "apply_changes", arguments: {} },
    });
    expect(call.error.code).toBe(-32602);
    expect(await bucket.head(prefix + "Notes/Disabled.md")).toBeNull();
    expect(
      (await db
        .prepare("SELECT count(*) AS n FROM r2_mutation_operations")
        .first())!.n,
    ).toBe(0);
  });
  it("creates and retrieves the latest UTF-8/BOM source before indexing", async () => {
    const content =
      "\ufeff---\ntitle: New synthetic title\ntags: [example]\n---\n# New\r\nExact body\r\n";
    const result = await mutate([
      { type: "create_note", path: "Notes/New.md", content },
    ]);
    expect(result.results[0]).toMatchObject({
      status: "applied",
      index_state: "pending",
    });
    expect(result.results[0].version).toMatch(/^r2v1\.[a-f0-9]{64}$/);
    const retrieved = await note("Notes/New.md");
    expect(retrieved.data).toMatchObject({
      content,
      title: "New synthetic title",
      metadata: { tags: ["example"] },
      index_state: "pending",
      version: result.results[0].version,
    });
    expect(JSON.stringify(result)).not.toContain("Exact body");
    expect(
      (await req("/attachments/Notes%2FNew.md?download=true", undefined, read))
        .status,
    ).toBe(404);
  });
  it("enforces preview binding, request identity, and same-ID replay without rewriting", async () => {
    const operations = [
      {
        type: "create_note",
        path: "Notes/Replay.md",
        content: "# Replay\nSynthetic secret body",
      },
    ];
    const op = (await preview(operations)).data;
    expect(
      await internal("apply", { id: op.operation_id, input: { operations } }),
    ).toMatchObject({ error: { code: "PREVIEW_REQUIRED" } });
    expect(
      await apply(op, [{ ...operations[0], content: "other" }]),
    ).toMatchObject({ error: { code: "IDEMPOTENCY_CONFLICT" } });
    const first = await apply(op, operations);
    expect(first.data.state).toBe("completed");
    const version = (await bucket.head(prefix + "Notes/Replay.md"))!.version;
    expect((await apply(op, operations)).data).toEqual(first.data);
    expect((await bucket.head(prefix + "Notes/Replay.md"))!.version).toBe(
      version,
    );
    const rows = await db
      .prepare("SELECT * FROM r2_mutation_items WHERE operation_id=?")
      .bind(op.operation_id)
      .all();
    expect(JSON.stringify(rows.results)).not.toContain("secret body");
  });
  it("supports direct allocation, ordered literal/regex capture patches, and stale version rejection", async () => {
    const source = await latest("Notes/Replay.md");
    const operations = [
      {
        type: "patch_note",
        path: "Notes/Replay.md",
        expected_version: source.version,
        replacements: [
          { match_type: "literal", pattern: "Replay", replacement: "Example" },
          {
            match_type: "regex",
            pattern: "(Synthetic) (secret)",
            replacement: "$2 $1",
          },
        ],
      },
    ];
    const op = (
      await preview(operations, {
        preview: false,
        settings: { mode: "direct" },
      })
    ).data;
    expect(
      (await apply(op, operations, { settings: { mode: "direct" } })).data
        .results[0].status,
    ).toBe("applied");
    expect((await latest("Notes/Replay.md")).content).toBe(
      "# Example\nsecret Synthetic body",
    );
    const stale = await mutate([
      {
        type: "replace_note",
        path: "Notes/Replay.md",
        expected_version: source.version,
        content: "stale",
      },
    ]);
    expect(stale.results[0]).toMatchObject({
      status: "failed",
      code: "SOURCE_REVISION_MISMATCH",
    });
  });
  it("handles partial item failure but rejects duplicate/oversized envelopes before source writes", async () => {
    const result = await mutate([
      { type: "create_note", path: "Notes/Replay.md", content: "collision" },
      { type: "create_note", path: "Notes/Partial.md", content: "success" },
    ]);
    expect(result.results.map((r: any) => r.status)).toEqual([
      "failed",
      "applied",
    ]);
    const duplicate = [
      { type: "create_note", path: "Notes/Duplicate.md", content: "a" },
      { type: "create_note", path: "Notes/Duplicate.md", content: "b" },
    ];
    expect((await preview(duplicate)).status).toBeGreaterThanOrEqual(400);
    expect(await bucket.head(prefix + "Notes/Duplicate.md")).toBeNull();
    expect(
      (
        await preview(
          [
            {
              type: "create_note",
              path: "Notes/Too-big.md",
              content: "oversized",
            },
          ],
          { settings: { max_file_bytes: 3 } },
        )
      ).status,
    ).toBeGreaterThanOrEqual(400);
  });
  it("denies hidden/excluded paths and unsupported attachments", async () => {
    for (const path of [
      "Notes/secret.md",
      "Notes/.hidden.md",
      "Other/.git/config.md",
    ])
      expect(
        (await mutate([{ type: "create_note", path, content: "never" }]))
          .results[0],
      ).toMatchObject({ status: "failed", code: "SOURCE_EXCLUDED" });
    expect(
      (
        await mutate([
          {
            type: "upload_attachment",
            path: "images/unknown.exe",
            content_base64: "YQ==",
          },
        ])
      ).results[0].status,
    ).toBe("failed");
  });
  it("keeps pCloud read-only and rejects another vault, rotated signing key and changed policy", async () => {
    const operations = [
      { type: "create_note", path: "Notes/Policy.md", content: "body" },
    ];
    expect(await preview(operations, { provider: "pcloud" })).toMatchObject({
      error: { code: "SOURCE_WRITE_UNSUPPORTED" },
    });
    const op = (await preview(operations)).data;
    expect(
      await apply(op, operations, { vaultId: randomUUID() }),
    ).toMatchObject({ error: { code: "OPERATION_INVALID" } });
    expect(
      await apply(op, operations, {
        adminToken: randomBytes(32).toString("hex"),
      }),
    ).toMatchObject({ error: { code: "OPERATION_INVALID" } });
    expect(
      await apply(op, operations, { settings: { max_file_bytes: 10 } }),
    ).toMatchObject({ error: { code: "PREVIEW_CHANGED" } });
    expect(await bucket.head(prefix + "Notes/Policy.md")).toBeNull();
  });
  it("keeps changed sources hidden from stale results until a matching source generation is published", async () => {
    const before = await latest("Notes/Target.md");
    const operation = await mutate([
      {
        type: "replace_note",
        path: "Notes/Target.md",
        expected_version: before.version,
        content: "# Replacement\nUniqueNewMarker\n",
      },
    ]);
    const old = await req(
      "/search",
      { query: "UniqueDeletedMarker", mode: "lexical" },
      read,
    );
    expect(old.data.results).toEqual([]);
    expect((await note("Notes/Target.md")).data.content).toContain(
      "UniqueNewMarker",
    );
    await publish();
    const fresh = await req(
      "/search",
      { query: "UniqueNewMarker", mode: "lexical" },
      read,
    );
    expect(fresh.data.results).toHaveLength(1);
    expect(fresh.data.results[0]).toMatchObject({
      path: "Notes/Target.md",
      title: "Replacement",
    });
    expect((await note("Notes/Target.md")).data.index_state).toBe("fresh");
    expect(
      (await internal("status", { id: operation.operation_id })).data.results[0]
        .index_state,
    ).toBe("fresh");
  });
  it("rejects stale chunk references even after the newer index is fresh", async () => {
    const old = await req(
      "/search",
      { query: "UniqueNewMarker", mode: "lexical" },
      read,
    );
    const reference = old.data.results[0];
    expect(reference.version).toMatch(/^chunk1:/);
    const before = await latest("Notes/Target.md");
    await mutate([
      {
        type: "replace_note",
        path: "Notes/Target.md",
        expected_version: before.version,
        content: "# Replacement\nLatestChunkMarker\n",
      },
    ]);
    await publish();
    const id = await core.noteIdFromPath("Notes/Target.md");
    expect(
      await req(
        `/chunks/${id}/0?expected_version=${encodeURIComponent(reference.version)}`,
        undefined,
        read,
      ),
    ).toMatchObject({ status: 409, error: { code: "REVISION_CHANGED" } });
    const latestVersion = (await latest("Notes/Target.md")).version;
    expect(
      (
        await req(
          `/chunks/${id}/0?expected_version=${latestVersion}`,
          undefined,
          read,
        )
      ).data.content,
    ).toContain("LatestChunkMarker");
  });
  it("revokes deleted data on every content-bearing surface before reindexing", async () => {
    const source = await latest("Notes/Target.md");
    const deleted = await mutate([
      {
        type: "delete_file",
        path: "Notes/Target.md",
        expected_version: source.version,
      },
    ]);
    expect(deleted.results[0]).toMatchObject({
      status: "applied",
      index_state: "pending",
    });
    expect((await bucket.head(prefix + "Notes/Target.md"))!.size).toBe(0);
    expect((await note("Notes/Target.md")).status).toBe(404);
    const id = await core.noteIdFromPath("Notes/Target.md");
    const requests = [
      req("/search", { query: "LatestChunkMarker", mode: "lexical" }, read),
      req(
        "/related",
        {
          type: "note",
          id: await core.noteIdFromPath("Notes/Keep.md"),
          mode: "lexical",
        },
        read,
      ),
      ...[
        "/overview",
        "/tree",
        "/tags",
        "/facets",
        "/profiles/metadata",
        "/profiles/style",
        "/links/broken",
        "/links/orphans",
        "/links/summary",
        `/links/backlinks/${id}`,
        `/chunks/${id}/0`,
      ].map((p) => req(p, undefined, read)),
    ];
    for (const result of await Promise.all(requests)) {
      expect(JSON.stringify(result)).not.toContain("LatestChunkMarker");
      expect(JSON.stringify(result)).not.toContain(id);
    }
    expect((await note("Notes/Keep.md")).status).toBe(200);
  });
  it("creates/replaces/deletes allowed attachments with latest versions and no stale bytes", async () => {
    const created = await mutate([
      {
        type: "upload_attachment",
        path: "images/new.svg",
        content_base64: btoa("<svg>first</svg>"),
      },
    ]);
    const version = created.results[0].version;
    expect(
      (
        await mutate([
          {
            type: "upload_attachment",
            path: "images/new.svg",
            content_base64: "YQ==",
          },
        ])
      ).results[0].code,
    ).toBe("FILE_ALREADY_EXISTS");
    const replacement = await mutate([
      {
        type: "upload_attachment",
        path: "images/new.svg",
        replace: true,
        expected_version: version,
        content_base64: btoa("<svg>latest</svg>"),
      },
    ]);
    const metadata = await req(
      "/attachments/images%2Fnew.svg",
      undefined,
      read,
    );
    expect(metadata.data.version).toBe(replacement.results[0].version);
    const response = await mf.dispatchFetch(
      "https://vault.example.invalid/attachments/images%2Fnew.svg?download=true",
      { headers: { Authorization: `Bearer ${read}` } },
    );
    expect(await response.text()).toBe("<svg>latest</svg>");
    await mutate([
      {
        type: "delete_file",
        path: "images/new.svg",
        expected_version: replacement.results[0].version,
      },
    ]);
    expect(
      (await req("/attachments/images%2Fnew.svg", undefined, read)).status,
    ).toBe(404);
  });
  it("invalidates a read context admitted before a source mutation", async () => {
    expect(
      await internal("read-race", {
        input: {
          operations: [
            {
              type: "create_note",
              path: "Notes/Race.md",
              content: "# Race\nSynthetic",
            },
          ],
        },
      }),
    ).toMatchObject({ error: { code: "REVISION_CHANGED" } });
  });
  it.each(["generation", "conditional"])(
    "rejects a late %s race and restores the prior access state",
    async (kind) => {
      const path = `Notes/Write-race-${kind}.md`;
      await mutate([{ type: "create_note", path, content: "ancestor" }]);
      const expected_version = (await latest(path)).version;
      const result = await mutate(
        [{ type: "replace_note", path, expected_version, content: "desired" }],
        kind === "generation"
          ? { generation_race: path }
          : { conditional_race: true },
      );
      expect(result.results[0]).toMatchObject({
        status: "failed",
        code: "SOURCE_REVISION_MISMATCH",
      });
      expect((await note(path)).data.content).toContain("external");
      expect(
        await db
          .prepare("SELECT state FROM r2_mutation_paths WHERE path=?")
          .bind(path)
          .first(),
      ).toEqual({ state: "saved" });
    },
  );
  it("serializes concurrent same-ID calls and competing path writes", async () => {
    const path = "Notes/Concurrent.md";
    const operations = [{ type: "create_note", path, content: "ancestor" }];
    const op = (await preview(operations)).data;
    await Promise.all([apply(op, operations), apply(op, operations)]);
    expect(
      (await internal("status", { id: op.operation_id })).data.results[0]
        .status,
    ).toBe("applied");
    const expected_version = (await latest(path)).version;
    const a = [
        { type: "replace_note", path, expected_version, content: "first" },
      ],
      b = [{ type: "replace_note", path, expected_version, content: "second" }];
    const pa = (await preview(a)).data,
      pb = (await preview(b)).data;
    const results = await Promise.all([apply(pa, a), apply(pb, b)]);
    expect(results.map((r) => r.data.results[0].status).sort()).toEqual([
      "applied",
      "failed",
    ]);
  });
  it("detects an observed same-byte rewrite by generation before conditional publication", async () => {
    const path = "Notes/Same-byte.md";
    await mutate([{ type: "create_note", path, content: "ancestor" }]);
    const expected_version = (await latest(path)).version;
    const before = (await bucket.head(prefix + path))!;
    const result = await mutate(
      [{ type: "replace_note", path, expected_version, content: "desired" }],
      { generation_race: path, generation_content: "ancestor" },
    );
    expect(result.results[0]).toMatchObject({
      status: "failed",
      code: "SOURCE_REVISION_MISMATCH",
    });
    const after = (await bucket.head(prefix + path))!;
    expect(after.etag).toBe(before.etag);
    expect(after.version).not.toBe(before.version);
    expect((await latest(path)).content).toBe("ancestor");
  });
  it("blocks guidance reads and catalogs as soon as source deletion is acknowledged", async () => {
    const source = await latest("AGENTS.md");
    await mutate([
      {
        type: "delete_file",
        path: "AGENTS.md",
        expected_version: source.version,
      },
    ]);
    expect(
      (await req("/agent-guidance/AGENTS.md", undefined, read)).status,
    ).toBe(404);
    expect(
      JSON.stringify((await req("/agent-guidance", undefined, read)).data),
    ).not.toContain("AGENTS.md");
  });
  it("does not leak old guidance while a replacement awaits indexing", async () => {
    const path = "Notes/AGENTS.md";
    await mutate([
      { type: "create_note", path, content: "# Guidance\nOldGuidanceMarker" },
    ]);
    await publish();
    const source = await latest(path);
    await mutate([
      {
        type: "replace_note",
        path,
        expected_version: source.version,
        content: "# Guidance\nLatest guidance",
      },
    ]);
    const response = await req(
      "/agent-guidance/Notes%2FAGENTS.md",
      undefined,
      read,
    );
    expect(response.status).toBe(409);
    expect(JSON.stringify(response)).not.toContain("OldGuidanceMarker");
  });
  it("keeps an ambiguous saved source blocked until its durable receipt can be acknowledged", async () => {
    const path = "Notes/D1-ack.md";
    await db
      .prepare(
        "CREATE TRIGGER synthetic_mutation_ack BEFORE UPDATE ON r2_mutation_paths WHEN NEW.path='Notes/D1-ack.md' AND NEW.state='saved' BEGIN SELECT RAISE(ABORT,'synthetic'); END",
      )
      .run();
    const result = await mutate([
      { type: "create_note", path, content: "saved body" },
    ]);
    expect(result.results[0].status).toBe("reconciling");
    expect((await note(path)).status).toBe(503);
    const before = (await bucket.head(prefix + path))!.version;
    await db.prepare("DROP TRIGGER synthetic_mutation_ack").run();
    await internal("recover", { now: now + 120001 });
    expect((await note(path)).data.content).toBe("saved body");
    expect((await bucket.head(prefix + path))!.version).toBe(before);
  });
  it("recovers an acknowledged conditional deletion receipt without rewriting its marker", async () => {
    const path = "Notes/Delete-receipt.md";
    await mutate([
      { type: "create_note", path, content: "delete this synthetic body" },
    ]);
    await publish();
    const expected_version = (await latest(path)).version;
    const operations = [{ type: "delete_file", path, expected_version }];
    const op = (await preview(operations)).data;
    await apply(op, operations, { interrupt: "published" });
    expect((await note(path)).status).toBe(503);
    const before = (await bucket.head(prefix + path))!;
    expect(before.size).toBe(0);
    await internal("recover", { now: now + 120001 });
    expect(
      (await internal("status", { id: op.operation_id, now: now + 120001 }))
        .data.results[0].status,
    ).toBe("applied");
    expect((await note(path)).status).toBe(404);
    expect((await bucket.head(prefix + path))!.version).toBe(before.version);
  });
  it.each(["claimed", "staged", "committing", "published", "applied"])(
    "recovers interruption at %s without replaying source publication",
    async (phase) => {
      const path = `Notes/Interrupted-${phase}.md`;
      const operations = [
        { type: "create_note", path, content: `# Synthetic\n${phase}` },
      ];
      const op = (await preview(operations)).data;
      expect(await apply(op, operations, { interrupt: phase })).toMatchObject({
        error: { code: "INTERRUPTED" },
      });
      const before = await bucket.head(prefix + path);
      await internal("recover", { now: now + 120001 });
      const status = (
        await internal("status", { id: op.operation_id, now: now + 120001 })
      ).data;
      expect(status.results[0].status).toBe(
        phase === "committing"
          ? "reconciling"
          : ["published", "applied"].includes(phase)
            ? "applied"
            : "failed",
      );
      expect((await bucket.head(prefix + path))?.version).toBe(before?.version);
      if (phase === "committing") expect((await note(path)).status).toBe(503);
    },
  );
  it("never replays an uncertain write when its receipt is missing, including after source reversion", async () => {
    const path = "Notes/Uncertain.md";
    await mutate([{ type: "create_note", path, content: "ancestor" }]);
    const version = (await latest(path)).version;
    const operations = [
      {
        type: "replace_note",
        path,
        expected_version: version,
        content: "desired",
      },
    ];
    const op = (await preview(operations)).data;
    await apply(op, operations, { interrupt: "published" });
    await bucket.put(prefix + path, "ancestor");
    await internal("recover", { now: now + 120001 });
    expect(
      (await internal("status", { id: op.operation_id, now: now + 120001 }))
        .data.results[0].status,
    ).toBe("reconciling");
    expect((await note(path)).status).toBe(503);
    expect(await (await bucket.get(prefix + path))!.text()).toBe("ancestor");
    const pointer = await db
      .prepare(
        "SELECT coalesce(p.snapshot,d.revision) AS snapshot FROM deployment d LEFT JOIN publications p ON p.store=d.revision WHERE d.id=1",
      )
      .first<{ snapshot: string }>();
    const response = await mf.dispatchFetch(
      "https://vault.example.invalid/uploads",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${admin}`,
          "Content-Type": "application/json",
          "Idempotency-Key": randomUUID(),
        },
        body: JSON.stringify({
          vaultId: VAULT_ID,
          parentRevision: pointer!.snapshot,
          includes: ["Notes"],
          entries: [
            {
              path,
              kind: "note",
              size: 8,
              digest: await core.contentRevision("ancestor"),
              updated: "2026-01-01T00:00:00.000Z",
            },
          ],
          deletes: [],
        }),
      },
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: { code: "UPLOAD_CONFLICT" },
    });
  });
  it("rejects regex work beyond the shared budget in workerd without changing source bytes", async () => {
    const path = "Notes/Regex-budget.md",
      content = "a".repeat(100000);
    await mutate([{ type: "create_note", path, content }]);
    const expected_version = (await latest(path)).version;
    const result = await mutate([
      {
        type: "patch_note",
        path,
        expected_version,
        replacements: [
          { match_type: "regex", pattern: "a?".repeat(300), replacement: "x" },
        ],
      },
    ]);
    expect(result.results[0]).toMatchObject({
      status: "failed",
      code: "REGEX_BUDGET_EXCEEDED",
    });
    expect((await latest(path)).content).toBe(content);
  });
  it("keeps source-save limits separate from default note retrieval limits", async () => {
    const path = "Notes/Read-limit.md",
      content = "x".repeat(210000);
    await mutate([{ type: "create_note", path, content }]);
    expect(await note(path)).toMatchObject({
      status: 413,
      error: { code: "NOTE_TOO_LARGE" },
    });
    const id = await core.noteIdFromPath(path);
    expect(
      (await req(`/notes/${id}?allowLarge=true`, undefined, read)).data.content,
    ).toBe(content);
  });
  it("expires IDs without resurrecting them and retains revocations after terminal audit cleanup", async () => {
    const operations = [
      { type: "create_note", path: "Notes/Expired.md", content: "never" },
    ];
    const op = (
      await preview(operations, { settings: { history_retention_days: 1 } })
    ).data;
    const later = now + 2 * 86400000;
    expect(
      await apply(op, operations, {
        now: later,
        settings: { history_retention_days: 1 },
      }),
    ).toMatchObject({ error: { code: "OPERATION_EXPIRED" } });
    for (let n = 0; n < 20; n++) {
      const step = await internal("cleanup", { now: now + 20 * 86400000 });
      if (!step.data.inspected) break;
    }
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM r2_mutation_operations WHERE state='completed'",
        )
        .first())!.n,
    ).toBe(0);
    expect((await note("Notes/Target.md")).status).toBe(404);
    expect((await note("Notes/Uncertain.md")).status).toBe(503);
    expect(
      await db
        .prepare(
          "SELECT state FROM r2_mutation_paths WHERE path='Notes/Target.md'",
        )
        .first(),
    ).toEqual({ state: "deleted" });
  });
});

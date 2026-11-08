import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readdir, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import * as core from "../../core/src/portable/index.js";
import { VAULT_ID } from "../scripts/fixture.js";
const readwrite = randomBytes(32).toString("hex");
const admin = randomBytes(32).toString("hex"),
  read = randomBytes(32).toString("hex");
let script: string, mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let bucket: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
let originalVersion: string, oldChunkVersion: string;
const prefix = `${VAULT_ID}/source/`;
function runtime(overrides: Record<string, string> = {}) {
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-10-28",
      d1Databases: { DB: "workers-mutations" },
      r2Buckets: { SOURCE: "workers-mutations" },
      ratelimits: {
        REQUEST_LIMITER: {
          namespace_id: "1057",
          simple: { limit: 100000, period: 60 },
        },
      },
      bindings: {
        VAULT_ID,
        READ_TOKEN: read,
        READWRITE_TOKEN: readwrite,
        ADMIN_TOKEN: admin,
        INCLUDE_PATHS: '["."]',
        EXCLUDE_PATHS: '["**/secret.md"]',
        ALLOWED_ORIGINS: "[]",
        PROFILE_VALUE_ALLOWLIST: "[]",
        INGESTION_ENABLED: "true",
        EXTERNAL_EMBEDDING_CONSENT: "false",
        EMBEDDING_MODEL_REVISION: "operator-v1",
        WRITE_ENABLED: "true",
        ...overrides,
      },
    }),
  );
}
async function request(
  path: string,
  input?: unknown,
  token = admin,
  target = mf,
  extra: Record<string, string> = {},
) {
  const response = await target.dispatchFetch(
    `https://vault.example.invalid${path}`,
    {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...extra,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    },
  );
  return { status: response.status, ...((await response.json()) as any) };
}
const rpc = (name: string, args: Record<string, unknown> = {}, id = 1) => ({
  jsonrpc: "2.0",
  id,
  method: "tools/call",
  params: { name, arguments: args },
});
async function tool(
  name: string,
  args: Record<string, unknown> = {},
  token = admin,
  target = mf,
  extra: Record<string, string> = {},
) {
  const result = await request("/mcp", rpc(name, args), token, target, extra);
  return {
    ...result,
    ...(result.result?.content?.[0]?.text
      ? { data: JSON.parse(result.result.content[0].text) }
      : {}),
  };
}
async function note(path: string) {
  return tool("get_note", { noteId: await core.noteIdFromPath(path) }, read);
}
async function mutate(operations: unknown[]) {
  const op = await tool("preview_changes", { operations });
  expect(op.status, JSON.stringify(op)).toBe(200);
  expect(op.error).toBeUndefined();
  const result = await tool("apply_changes", {
    operation_id: op.data.operation_id,
    preview_binding: op.data.preview_binding,
    operations,
  });
  expect(result.error, JSON.stringify(result)).toBeUndefined();
  return result.data;
}
async function publish() {
  let job = (await request("/index", { newScan: true })).data;
  for (let n = 0; n < 400 && !["complete", "failed"].includes(job.state); n++)
    job = (
      await request(`/jobs/${job.jobId}/advance`, {
        checkpoint: job.checkpoint,
      })
    ).data;
  expect(job.state, JSON.stringify(job)).toBe("complete");
}
beforeAll(async () => {
  script = (
    await build({
      entryPoints: ["src/index.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      tsconfig: "tsconfig.json",
    })
  ).outputFiles[0]!.text;
  mf = runtime();
  db = await mf.getD1Database("DB");
  bucket = await mf.getR2Bucket("SOURCE");
  for (const file of (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    for (const sql of (await readFile(`migrations/${file}`, "utf8"))
      .replace(/--[^\n]*/g, "")
      .split(";")
      .filter((s) => s.trim()))
      await db.prepare(sql).run();
  await bucket.put(
    prefix + "Notes/Original.md",
    "# Original\nSynthetic orchard before update.",
  );
  await bucket.put(
    prefix + "Notes/Referrer.md",
    "# Referrer\n[[Original]] ![[images/original.svg]]",
  );
  await bucket.put(prefix + "images/original.svg", "<svg>original</svg>");
  await publish();
});
afterAll(async () => mf?.dispose());
it("keeps default-off Workers read-only and rejects disabled mutation calls before side effects", async () => {
  const disabled = runtime({ WRITE_ENABLED: "false" });
  try {
    const list = await request(
      "/mcp",
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      admin,
      disabled,
    );
    expect(list.result.tools).toHaveLength(18);
    expect(
      await tool(
        "apply_changes",
        { operation_id: "not-issued", operations: [] },
        admin,
        disabled,
      ),
    ).toMatchObject({ status: 403, error: { code: "WRITE_DISABLED" } });
    await expect(
      (await disabled.getR2Bucket("SOURCE")).list({ prefix }),
    ).resolves.toMatchObject({ objects: [] });
  } finally {
    await disabled.dispose();
  }
});
it("lists mutations only for admin and refuses read-key preview/apply/status, including mixed batches", async () => {
  const list = async (token: string) =>
    request("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" }, token);
  expect((await list(read)).result.tools).toHaveLength(18);
  const tools = (await list(admin)).result.tools;
  expect(tools).toHaveLength(21);
  expect(
    tools.find((t: any) => t.name === "apply_changes").annotations,
  ).toMatchObject({
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
  });
  for (const name of ["preview_changes", "apply_changes", "get_change_status"])
    expect(await tool(name, { operation_id: "unknown" }, read)).toMatchObject({
      status: 403,
      error: { code: "READWRITE_REQUIRED" },
    });
  const batch = await request(
    "/mcp",
    [
      rpc("search", { query: "orchard", mode: "lexical" }),
      rpc(
        "preview_changes",
        {
          operations: [
            {
              type: "create_note",
              path: "Notes/Forbidden.md",
              content: "never",
            },
          ],
        },
        2,
      ),
    ],
    read,
  );
  expect(batch).toMatchObject({
    status: 403,
    error: { code: "READWRITE_REQUIRED" },
  });
  expect(await bucket.head(prefix + "Notes/Forbidden.md")).toBeNull();
  expect(
    (await db
      .prepare("SELECT count(*) AS n FROM r2_mutation_operations")
      .first())!.n,
  ).toBe(0);
});
it("issues current versions for existing never-mutated notes and attachments, and pins indexed chunks", async () => {
  const value = (await note("Notes/Original.md")).data;
  expect(value.version).toMatch(/^r2v1\./);
  originalVersion = value.version;
  expect(
    (
      await tool(
        "get_attachment",
        { vaultRelativePath: "images/original.svg" },
        read,
      )
    ).data.version,
  ).toMatch(/^r2v1\./);
  const result = (
    await tool("search", { query: "orchard", mode: "lexical" }, read)
  ).data;
  oldChunkVersion = result.results.find(
    (r: any) => r.path === "Notes/Original.md",
  ).version;
  expect(oldChunkVersion).toMatch(/^chunk1:/);
  expect(
    (
      await tool(
        "get_chunk",
        {
          noteId: await core.noteIdFromPath("Notes/Original.md"),
          chunkIndex: 0,
        },
        read,
      )
    ).error,
  ).toBeDefined();
  expect(
    (
      await tool(
        "get_chunk",
        {
          noteId: await core.noteIdFromPath("Notes/Original.md"),
          chunkIndex: 0,
          expected_version: oldChunkVersion,
        },
        read,
      )
    ).data.content,
  ).toContain("orchard");
});
it("enforces strict preview/apply binding and idempotent source saves through actual public tools", async () => {
  const operations = [
    {
      type: "replace_note",
      path: "Notes/Original.md",
      expected_version: originalVersion,
      content: "# Revised\nChanged orchard marker.",
    },
  ];
  const before = (await bucket.head(prefix + "Notes/Original.md"))!.version;
  const op = (await tool("preview_changes", { operations })).data;
  expect(op.preview.results[0].diff).toBeDefined();
  expect((await bucket.head(prefix + "Notes/Original.md"))!.version).toBe(
    before,
  );
  expect(
    (await tool("apply_changes", { operation_id: op.operation_id, operations }))
      .error.data.errorCode,
  ).toBe("PREVIEW_REQUIRED");
  expect(
    (
      await tool("apply_changes", {
        operation_id: op.operation_id,
        preview_binding: op.preview_binding,
        operations: [{ ...operations[0], content: "different" }],
      })
    ).error.data.errorCode,
  ).toBe("IDEMPOTENCY_CONFLICT");
  const lost = await mf.dispatchFetch("https://vault.example.invalid/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${admin}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(
      rpc("apply_changes", {
        operation_id: op.operation_id,
        preview_binding: op.preview_binding,
        operations,
      }),
    ),
  });
  // Discard the apply response, then resolve the outcome through a new request.
  await lost.body?.cancel();
  const first = (
    await tool("get_change_status", {
      operation_id: op.operation_id,
    })
  ).data;
  expect(first.results[0]).toMatchObject({
    status: "applied",
    index_state: "pending",
  });
  const saved = (await bucket.head(prefix + "Notes/Original.md"))!.version;
  expect(
    (
      await tool("apply_changes", {
        operation_id: op.operation_id,
        preview_binding: op.preview_binding,
        operations,
      })
    ).data,
  ).toEqual(first);
  expect((await bucket.head(prefix + "Notes/Original.md"))!.version).toBe(
    saved,
  );
  expect((await note("Notes/Original.md")).data).toMatchObject({
    content: operations[0].content,
    version: first.results[0].version,
    index_state: "pending",
  });
  expect(
    JSON.stringify(
      (await tool("get_change_status", { operation_id: op.operation_id })).data,
    ),
  ).not.toContain("Changed orchard marker.");
  expect(
    (await tool("preview_changes", { operations, ignored: true })).error.data
      .errorCode,
  ).toBe("INVALID_REQUEST");
  expect(
    (await tool("preview_changes", { operations, preview: false })).error.data
      .errorCode,
  ).toBe("PREVIEW_REQUIRED");
});
it("rejects stale chunk references after fresh publication, not only while indexing is pending", async () => {
  await publish();
  const result = await tool(
    "get_chunk",
    {
      noteId: await core.noteIdFromPath("Notes/Original.md"),
      chunkIndex: 0,
      expected_version: oldChunkVersion,
    },
    read,
  );
  expect(result.error.data.errorCode).toBe("REVISION_CHANGED");
  expect((await note("Notes/Original.md")).data.index_state).toBe("fresh");
});
it("supports note creation, sequential patching and deletion with bounded incoming-reference warnings", async () => {
  const created = await mutate([
    {
      type: "create_note",
      path: "Notes/New.md",
      content: "\ufeff# New\r\nalpha beta\r\n",
    },
  ]);
  expect((await note("Notes/New.md")).data.content).toBe(
    "\ufeff# New\r\nalpha beta\r\n",
  );
  const patched = await mutate([
    {
      type: "patch_note",
      path: "Notes/New.md",
      expected_version: created.results[0].version,
      replacements: [
        { match_type: "literal", pattern: "alpha", replacement: "gamma" },
        {
          match_type: "regex",
          pattern: "(gamma) (beta)",
          replacement: "$2 $1",
        },
      ],
    },
  ]);
  expect((await note("Notes/New.md")).data.content).toBe(
    "\ufeff# New\r\nbeta gamma\r\n",
  );
  await mutate([
    {
      type: "delete_file",
      path: "Notes/New.md",
      expected_version: patched.results[0].version,
    },
  ]);
  expect((await note("Notes/New.md")).error.data.errorCode).toBe(
    "NOTE_NOT_FOUND",
  );
  const target = (await note("Notes/Original.md")).data;
  const indexedObject = async (path: string) =>
    (await db
      .prepare(
        "SELECT coalesce(o.object_key, ? || '/' || s.revision || '/' || s.path) AS key FROM sources s LEFT JOIN source_objects o ON o.revision=s.revision AND o.path=s.path WHERE s.revision=(SELECT revision FROM deployment WHERE id=1) AND s.path=?",
      )
      .bind(VAULT_ID, path)
      .first<{ key: string }>())!.key;
  const retiredKey = await indexedObject("Notes/Original.md");
  const retainedKey = await indexedObject("Notes/Referrer.md");
  expect(await bucket.head(retiredKey)).not.toBeNull();
  const deletion = await mutate([
    {
      type: "delete_file",
      path: "Notes/Original.md",
      expected_version: target.version,
    },
  ]);
  expect(deletion.results[0].warnings).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ code: "BACKLINKS_MAY_BE_STALE" }),
      expect.objectContaining({
        code: "INCOMING_LINKS",
        references: [
          {
            note_id: await core.noteIdFromPath("Notes/Referrer.md"),
            path: "Notes/Referrer.md",
          },
        ],
      }),
    ]),
  );
  expect(
    (await tool("search", { query: "orchard", mode: "lexical" }, read)).data
      .results,
  ).toEqual([]);
  await publish();
  const noteId = await core.noteIdFromPath("Notes/Original.md");
  expect(
    await db
      .prepare(
        "SELECT chunk_id FROM chunks WHERE revision=(SELECT revision FROM deployment WHERE id=1) AND note_id=?",
      )
      .bind(noteId)
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT object_key FROM retired_objects WHERE object_key=?")
      .bind(retiredKey)
      .first(),
  ).not.toBeNull();
  const worker = await mf.getWorker();
  await worker.scheduled({ cron: "* * * * *" });
  expect(await bucket.head(retiredKey)).not.toBeNull();
  // Age the actual retirement record to exercise Cron without a wall-clock wait.
  await db
    .prepare("UPDATE retired_objects SET retired=0 WHERE object_key=?")
    .bind(retiredKey)
    .run();
  await worker.scheduled({ cron: "* * * * *" });
  expect(await bucket.head(retiredKey)).toBeNull();
  expect(await bucket.head(retainedKey)).not.toBeNull();
});
it("supports explicit attachment replacement/download/deletion and reports detected references", async () => {
  const current = (
    await tool(
      "get_attachment",
      { vaultRelativePath: "images/original.svg" },
      read,
    )
  ).data;
  const updated = await mutate([
    {
      type: "upload_attachment",
      path: "images/original.svg",
      replace: true,
      expected_version: current.version,
      content_base64: btoa("<svg>changed</svg>"),
    },
  ]);
  const download = (
    await tool(
      "get_attachment",
      { vaultRelativePath: "images/original.svg", download: true },
      read,
    )
  ).data;
  expect(atob(download.content)).toBe("<svg>changed</svg>");
  expect(download.version).toBe(updated.results[0].version);
  const deletion = await mutate([
    {
      type: "delete_file",
      path: "images/original.svg",
      expected_version: updated.results[0].version,
    },
  ]);
  expect(
    deletion.results[0].warnings.some((w: any) => w.code === "INCOMING_LINKS"),
  ).toBe(true);
  expect(
    (
      await tool(
        "get_attachment",
        { vaultRelativePath: "images/original.svg" },
        read,
      )
    ).error.data.errorCode,
  ).toBe("ATTACHMENT_NOT_FOUND");
});
it("uses current request credentials rather than a supplied session or client auth metadata", async () => {
  expect(
    await tool("preview_changes", { operations: [] }, read, mf, {
      "Mcp-Session-Id": "synthetic-admin-session",
    }),
  ).toMatchObject({ status: 403, error: { code: "READWRITE_REQUIRED" } });
  const result = await request(
    "/mcp",
    {
      ...rpc("preview_changes", { operations: [] }),
      authInfo: { scopes: ["admin"] },
    },
    read,
  );
  expect(result).toMatchObject({
    status: 403,
    error: { code: "READWRITE_REQUIRED" },
  });
  const rotated = runtime({ ADMIN_TOKEN: randomBytes(32).toString("hex") });
  try {
    expect(
      await tool("preview_changes", { operations: [] }, admin, rotated),
    ).toMatchObject({ status: 403, error: { code: "AUTH_FAILED" } });
  } finally {
    await rotated.dispose();
  }
  const overlap = runtime({
    ADMIN_TOKEN: randomBytes(32).toString("hex"),
    READ_TOKEN: randomBytes(32).toString("hex"),
    PREVIOUS_ADMIN_TOKEN: admin,
    PREVIOUS_READ_TOKEN: read,
  });
  try {
    for (const [token, count] of [
      [admin, 21],
      [read, 18],
    ] as const) {
      const list = await request(
        "/mcp",
        {
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
        },
        token,
        overlap,
      );
      expect(list.result.tools).toHaveLength(count);
    }
    expect(
      await tool("preview_changes", { operations: [] }, read, overlap),
    ).toMatchObject({ status: 403, error: { code: "READWRITE_REQUIRED" } });
  } finally {
    await overlap.dispose();
  }
});
it("applies distinct streaming envelope limits before schema/Base64 processing", async () => {
  const operations = [
    {
      type: "create_note",
      path: "Notes/Envelope.md",
      content: "x".repeat(70000),
    },
  ];
  expect((await tool("preview_changes", { operations }, read)).status).toBe(
    413,
  );
  expect(
    (await tool("preview_changes", { operations })).data.operation_id,
  ).toBeDefined();
  const response = await mf.dispatchFetch("https://vault.example.invalid/mcp", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${admin}`,
      "Content-Type": "application/json",
    },
    body: new ReadableStream({
      start(c) {
        c.enqueue(new Uint8Array(32 * 1024 * 1024 + 1));
        c.close();
      },
    }),
    duplex: "half",
  });
  expect(response.status).toBe(413);
  expect(await bucket.head(prefix + "Notes/Envelope.md")).toBeNull();
});
it.each([
  { WRITE_ENABLED: "yes" },
  { WRITE_MAX_FILE_BYTES: "5junk" },
  { WRITE_MAX_BATCH_BYTES: "999999999" },
  { WRITE_MODE: "unsafe" },
  { INGESTION_ENABLED: "false" },
])("rejects invalid/unsupported enabled settings: %j", async (overrides) => {
  const target = runtime(overrides);
  try {
    expect(
      (
        await request(
          "/mcp",
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          admin,
          target,
        )
      ).status,
    ).toBe(503);
  } finally {
    await target.dispose();
  }
});
it("supports direct mode and an actual SDK client across stateless HTTP invocations", async () => {
  const direct = runtime({ WRITE_MODE: "direct" });
  const store = await direct.getD1Database("DB");
  try {
    for (const file of (await readdir("migrations"))
      .filter((n) => n.endsWith(".sql"))
      .sort())
      for (const sql of (await readFile(`migrations/${file}`, "utf8"))
        .replace(/--[^\n]*/g, "")
        .split(";")
        .filter((s) => s.trim()))
        await store.prepare(sql).run();
    const client = new Client({
      name: "synthetic-write-client",
      version: "1.0",
    });
    await client.connect(
      new StreamableHTTPClientTransport(
        new URL("https://vault.example.invalid/mcp"),
        {
          requestInit: { headers: { Authorization: `Bearer ${admin}` } },
          fetch: async (input, init) => {
            const req = new Request(input, init);
            return direct.dispatchFetch(req.url, {
              method: req.method,
              headers: req.headers,
              body: req.body,
              duplex: "half",
            } as RequestInit);
          },
        },
      ),
    );
    try {
      expect((await client.listTools()).tools).toHaveLength(21);
      const operations = [
        {
          type: "create_note",
          path: "Notes/Direct.md",
          content: "# Direct\nSynthetic SDK write",
        },
      ];
      const allocated = await client.callTool({
        name: "preview_changes",
        arguments: { operations, preview: false },
      });
      const op = JSON.parse((allocated.content as { text: string }[])[0].text);
      const applied = await client.callTool({
        name: "apply_changes",
        arguments: { operations, operation_id: op.operation_id },
      });
      expect(
        JSON.parse((applied.content as { text: string }[])[0].text).results[0]
          .status,
      ).toBe("applied");
      await expect(
        (await direct.getR2Bucket("SOURCE")).get(prefix + "Notes/Direct.md"),
      ).resolves.toBeTruthy();
      const retrieved = await client.callTool({
        name: "get_note",
        arguments: { noteId: await core.noteIdFromPath("Notes/Direct.md") },
      });
      expect(
        JSON.parse((retrieved.content as { text: string }[])[0].text),
      ).toMatchObject({
        content: operations[0].content,
        index_state: "pending",
        revision: { snapshot: null },
      });
    } finally {
      await client.close();
    }
  } finally {
    await direct.dispose();
  }
});

it("lets READWRITE read/save/replay/status but denies every management family", async () => {
  const list = await request(
    "/mcp",
    { jsonrpc: "2.0", id: 1, method: "tools/list" },
    readwrite,
  );
  expect(list.result.tools).toHaveLength(21);
  const operations = [
    {
      type: "create_note",
      path: "Notes/Editing.md",
      content: "# Synthetic editing",
    },
  ];
  const plan = (await tool("preview_changes", { operations }, readwrite)).data;
  const args = {
    operations,
    operation_id: plan.operation_id,
    preview_binding: plan.preview_binding,
  };
  const saved = await tool("apply_changes", args, readwrite);
  expect(saved.data.results[0].status).toBe("applied");
  expect((await tool("apply_changes", args, readwrite)).data).toEqual(
    saved.data,
  );
  expect(
    (
      await tool(
        "get_change_status",
        { operation_id: plan.operation_id },
        readwrite,
      )
    ).data.operation_id,
  ).toBe(plan.operation_id);
  expect(
    (
      await tool(
        "get_note",
        { noteId: await core.noteIdFromPath("Notes/Editing.md") },
        readwrite,
      )
    ).data.content,
  ).toContain("Synthetic editing");
  for (const path of [
    "/index",
    "/reindex",
    "/uploads",
    "/sync/pull",
    "/watch",
    "/jobs/synthetic/advance",
  ])
    expect(await request(path, {}, readwrite)).toMatchObject({
      status: 403,
      error: { code: "ADMIN_REQUIRED" },
    });
  const batch = await request(
    "/mcp",
    [
      rpc("preview_changes", {
        operations: [
          {
            type: "create_note",
            path: "Notes/BatchEditing.md",
            content: "# Synthetic batch",
          },
        ],
      }),
      rpc(
        "get_note",
        { noteId: await core.noteIdFromPath("Notes/Editing.md") },
        2,
      ),
    ],
    readwrite,
  );
  expect(batch.status).toBe(200);
  expect(batch.error).toBeUndefined();
});
it("rotates/revokes READWRITE and rejects cross-role and partial configuration", async () => {
  for (const [overrides, status, count] of [
    [
      {
        READWRITE_TOKEN: randomBytes(32).toString("hex"),
        PREVIOUS_READWRITE_TOKEN: readwrite,
      },
      200,
      21,
    ],
    [{ READWRITE_TOKEN: randomBytes(32).toString("hex") }, 403, 0],
    [{ READWRITE_TOKEN: read }, 503, 0],
    [{ PREVIOUS_READWRITE_TOKEN: admin }, 503, 0],
    [{ READWRITE_TOKEN: "short" }, 503, 0],
    [{ WRITE_ENABLED: "false" }, 200, 18],
  ] as const) {
    const target = runtime(overrides);
    try {
      const result = await request(
        "/mcp",
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        readwrite,
        target,
      );
      expect(result.status).toBe(status);
      if (status === 200) expect(result.result.tools).toHaveLength(count);
      if (overrides.WRITE_ENABLED === "false")
        expect(
          (await tool("preview_changes", { operations: [] }, readwrite, target))
            .error,
        ).toBeDefined();
    } finally {
      await target.dispose();
    }
  }
});

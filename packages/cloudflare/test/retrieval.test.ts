import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { fixture, VAULT_ID } from "../scripts/fixture.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const read = randomBytes(32).toString("hex");
const admin = randomBytes(32).toString("hex");
let mf: Miniflare;
let script: string;
let seed: Awaited<ReturnType<typeof fixture>>;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let bucket: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
const base = "https://vault.example.invalid";
async function request(
  path: string,
  init: RequestInit = {},
  token: string | undefined = read,
) {
  const headers = new Headers(init.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return mf.dispatchFetch(base + path, { ...init, headers });
}
async function json(
  path: string,
  body: unknown,
  token: string | undefined = read,
) {
  return request(
    path,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(body),
    },
    token,
  );
}
const rpc = (method: string, params?: unknown, id: number | undefined = 1) => ({
  jsonrpc: "2.0",
  ...(id === undefined ? {} : { id }),
  method,
  ...(params ? { params } : {}),
});
async function mcp(message: unknown, token = read) {
  return json("/mcp", message, token).then((r) => r.json());
}
function toolPayload(result: any) {
  return JSON.parse(result.result.content[0].text);
}

beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    tsconfig: "tsconfig.json",
  });
  script = bundle.outputFiles[0]!.text;
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-10-28",
      d1Databases: { DB: "synthetic" },
      r2Buckets: { SOURCE: "synthetic" },
      ratelimits: {
        REQUEST_LIMITER: {
          namespace_id: "1001",
          simple: { limit: 1000, period: 60 },
        },
      },
      bindings: {
        VAULT_ID,
        INCLUDE_PATHS: '["."]',
        EXCLUDE_PATHS: "[]",
        PROFILE_VALUE_ALLOWLIST: '["type","status"]',
        ALLOWED_ORIGINS: "[]",
        READ_TOKEN: read,
        ADMIN_TOKEN: admin,
      },
    }),
  );
  db = await mf.getD1Database("DB");
  bucket = await mf.getR2Bucket("SOURCE");
  const migration = await readFile("migrations/0001_retrieval.sql", "utf8");
  // D1 exec accepts individual statements; migration deliberately contains no triggers.
  for (const sql of migration
    .replace(/--[^\n]*/g, "")
    .split(";")
    .filter((s) => s.trim()))
    await db.prepare(sql).run();
  seed = await fixture();
  for (const sql of seed.statements) await db.prepare(sql).run();
  for (const o of seed.objects) await bucket.put(o.key, o.content);
});
afterAll(async () => {
  await mf?.dispose();
});

describe("authenticated workerd D1/R2 retrieval", () => {
  it("exposes only liveness publicly and authenticates before body parsing", async () => {
    expect(
      await request("/health", {}, undefined).then((r) => r.json()),
    ).toEqual({ status: "ok" });
    for (const path of [
      "/search",
      "/notes/anything",
      "/status",
      "/mcp",
      "/index",
      "/sync/pull",
      "/upload",
    ]) {
      const response = await mf.dispatchFetch(base + path, {
        method: "POST",
        body: "invalid secret body",
      });
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain("secret body");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
    }
    expect((await request("/status", {}, "invalid")).status).toBe(403);
    expect((await json("/index", {}, read)).status).toBe(403);
    expect((await json("/index", {}, admin)).status).toBe(501);
    expect((await json("/sync/pull", {}, admin)).status).toBe(501);
    expect(
      (
        await request("/status", {
          headers: { Origin: "https://untrusted.invalid" },
        })
      ).status,
    ).toBe(403);
  });
  it("uses FTS5/BM25 and shared RRF for compact deterministic lexical results", async () => {
    const first = (await json("/search", {
      query: "apple",
      mode: "lexical",
    }).then((r) => r.json())) as any;
    expect(first.data.usedMode).toBe("lexical");
    expect(first.data.results.length).toBeGreaterThan(1);
    expect(first.revision.snapshot).toBe(seed.revision);
    expect(
      first.data.results.every(
        (r: any) => r.snippet.length <= 240 && !("content" in r),
      ),
    ).toBe(true);
    expect(
      await json("/search", { query: "apple", mode: "lexical" }).then((r) =>
        r.json(),
      ),
    ).toEqual(first);
    const japanese = (await json("/search", {
      query: "果樹園",
      mode: "lexical",
    }).then((r) => r.json())) as any;
    expect(japanese.data.results[0].path).toBe("Guide/Seasons.md");
    const bigram = (await json("/search", {
      query: "果樹",
      mode: "lexical",
    }).then((r) => r.json())) as any;
    expect(bigram.data.results).toEqual([]); // Existing unicode61/trigram behavior.
    const empty = (await json("/search", {
      query: "Empty",
      mode: "lexical",
    }).then((r) => r.json())) as any;
    expect(
      empty.data.results.some(
        (r: any) => r.path === "Guide/Empty.md" && r.type === "note",
      ),
    ).toBe(true);
    expect(
      (await json("/search", { query: "apple", mode: "embedding" })).status,
    ).toBe(503);
    const hybrid = (await json("/search", {
      query: "apple",
      mode: "hybrid",
    }).then((r) => r.json())) as any;
    expect(hybrid.data.usedMode).toBe("lexical");
    expect(hybrid.warnings[0].code).toBe("EMBEDDING_UNAVAILABLE");
  });
  it("applies all existing structured filters before candidate limits", async () => {
    const result = (await json("/search", {
      query: "apple",
      mode: "lexical",
      limit: 1,
      filters: {
        pathPrefix: ["Guide"],
        excludePathPrefix: ["Archive"],
        tags: ["garden"],
        excludeTags: ["archive"],
        frontmatter: { type: ["guide"], status: ["active"] },
      },
    }).then((r) => r.json())) as any;
    expect(result.data.results).toHaveLength(1);
    expect(result.data.results[0].path).toBe("Guide/Orchard.md");
    const none = (await json("/search", {
      query: "apple",
      filters: { tags: ["absent"] },
    }).then((r) => r.json())) as any;
    expect(none.data.results).toEqual([]);
  });
  it("retrieves only explicit notes/chunks and validates snapshot pins", async () => {
    const note = seed.notes.find((n) => n.path === "Guide/Orchard.md")!;
    const result = (await request(
      `/notes/${note.note_id}?snapshot=${seed.revision}`,
    ).then((r) => r.json())) as any;
    expect(result.data.content).toContain("Plant apple trees");
    expect(result.data.path).toBe(note.path);
    const chunk = (await request(`/chunks/${note.note_id}/0`).then((r) =>
      r.json(),
    )) as any;
    expect(chunk.data.id).toBe(`${note.note_id}:0`);
    expect((await request(`/notes/${note.note_id}?snapshot=old`)).status).toBe(
      409,
    );
    expect((await request("/notes/not-an-id")).status).toBe(400);
    expect((await request(`/chunks/${note.note_id}/0junk`)).status).toBe(404);
    const related = (await json("/related", {
      type: "note",
      id: note.note_id,
      mode: "lexical",
    }).then((r) => r.json())) as any;
    expect(
      related.data.results.every(
        (r: any) => r.noteId !== note.note_id && !("content" in r),
      ),
    ).toBe(true);
  });
  it("returns bounded orientation, graph, profiles and explicit guidance", async () => {
    for (const path of [
      "/overview",
      "/tree?depth=2&limit=10",
      "/tags",
      "/facets",
      "/links/broken",
      "/links/orphans",
      "/links/summary",
      "/profiles/metadata",
      "/profiles/style",
      "/agent-guidance",
    ]) {
      const response = await request(path);
      expect(response.status, `${path}: ${await response.clone().text()}`).toBe(
        200,
      );
      expect(((await response.json()) as any).revision.snapshot).toBe(
        seed.revision,
      );
    }
    const guidance = (await request("/agent-guidance/AGENTS.md").then((r) =>
      r.json(),
    )) as any;
    expect(guidance.data.content).toContain("Vault context");
    const note = seed.notes.find((n) => n.path === "Guide/Orchard.md")!;
    for (const path of [
      `/links/notes/${note.note_id}`,
      `/links/backlinks/${note.note_id}`,
    ])
      expect((await request(path)).status).toBe(200);
    const filtered = (await request(
      "/profiles/metadata?tag=garden&frontmatterType=guide",
    ).then((r) => r.json())) as any;
    expect(filtered.data).toBeDefined();
  });
  it("keeps attachment metadata separate from authenticated downloads", async () => {
    const metadata = (await request("/attachments/images/chart.png").then((r) =>
      r.json(),
    )) as any;
    expect(metadata.data.path).toBe("images/chart.png");
    expect(metadata.data.downloadAvailable).toBe(true);
    expect(metadata.data.content).toBeUndefined();
    const response = await request(
      "/attachments/images/chart.png?download=true",
    );
    expect(response.headers.get("Content-Disposition")).toContain(
      "attachment;",
    );
    expect(await response.text()).toBe("synthetic-image-placeholder");
    const result = await mcp(
      rpc("tools/call", {
        name: "get_attachment",
        arguments: { vaultRelativePath: "images/chart.png", download: true },
      }),
    );
    const output = toolPayload(result);
    expect(atob(output.content)).toBe("synthetic-image-placeholder");
    expect(output.revision.snapshot).toBe(seed.revision);
  });
  it("rejects excluded paths, traversal, malformed and oversized requests without leaks", async () => {
    for (const path of [
      ".git/config",
      "node_modules/package.json",
      ".private/file.md",
      "Guide/%2e%2e%2fsecret.md",
      "C%3A/private.md",
      "Guide%5Cfile.md",
      "%00",
    ]) {
      const response = await request("/attachments/" + path);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain(path);
    }
    expect((await json("/search", { query: "x".repeat(1001) })).status).toBe(
      400,
    );
    expect((await json("/search", { query: "x".repeat(70000) })).status).toBe(
      413,
    );
    expect((await json("/search", { query: "apple", limit: 51 })).status).toBe(
      400,
    );
    expect(
      (
        await json("/search", {
          query: "apple",
          filters: { frontmatter: { private: ["value"] } },
        })
      ).status,
    ).toBe(400);
  });
  it("negotiates stateless MCP, all tools, notifications, batches and sanitized errors", async () => {
    const init = (await mcp(
      rpc("initialize", {
        protocolVersion: "unknown",
        capabilities: {},
        clientInfo: { name: "synthetic", version: "1" },
      }),
    )) as any;
    expect(init.result.protocolVersion).toBe("2025-03-26");
    const list = (await mcp(rpc("tools/list"))) as any;
    expect(list.result.tools).toHaveLength(18);
    const result = toolPayload(
      await mcp(
        rpc("tools/call", {
          name: "search",
          arguments: { query: "apple", mode: "lexical" },
        }),
      ),
    );
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.freshness).toBe("fresh");
    const note = seed.notes[0]!;
    const error = (await mcp(
      rpc("tools/call", {
        name: "get_note",
        arguments: { noteId: note.note_id, snapshot: "old" },
      }),
    )) as any;
    expect(error.error.data.errorCode).toBe("REVISION_CHANGED");
    const batch = (await mcp([
      rpc("tools/list", undefined, 1),
      rpc(
        "tools/call",
        { name: "search", arguments: { query: "apple", limit: -1 } },
        2,
      ),
    ])) as any;
    expect(batch).toHaveLength(2);
    expect(batch[1].error).toBeDefined();
    const notification = await json("/mcp", {
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");
    expect(
      (
        await json(
          "/mcp",
          Array.from({ length: 11 }, () => rpc("tools/list")),
        )
      ).status,
    ).toBe(400);
    for (const method of ["GET", "DELETE"]) {
      const r = await request("/mcp", { method });
      expect(r.status).toBe(405);
      expect(r.headers.get("Allow")).toBe("POST");
    }
  });
  it("supports an authenticated real SDK client across fresh Worker request handlers", async () => {
    const transport = new StreamableHTTPClientTransport(
      new URL(base + "/mcp"),
      {
        requestInit: { headers: { Authorization: `Bearer ${read}` } },
        fetch: async (input, init) => {
          const req = new Request(input, init);
          return mf.dispatchFetch(req.url, {
            method: req.method,
            headers: req.headers,
            body: req.body,
            duplex: "half",
          } as RequestInit);
        },
      },
    );
    const client = new Client({ name: "synthetic-client", version: "1.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.length).toBe(18);
      const result = await client.callTool({
        name: "search",
        arguments: { query: "apple", mode: "lexical" },
      });
      expect(JSON.stringify(result)).toContain("Orchard");
    } finally {
      await client.close();
    }
  });
  it("isolates staged corpora and fails closed on changed source or missing objects", async () => {
    const original = await json("/search", {
      query: "apple",
      mode: "lexical",
    }).then((r) => r.json());
    const staged = await fixture({ "Staged.md": "# apple\napple ".repeat(20) });
    for (const sql of staged.statements.slice(0, -1))
      await db.prepare(sql).run();
    expect(
      await json("/search", { query: "apple", mode: "lexical" }).then((r) =>
        r.json(),
      ),
    ).toEqual(original);
    const note = seed.notes.find((n) => n.path === "Guide/Orchard.md")!;
    const obj = seed.objects.find((o) => o.key.endsWith("/Guide/Orchard.md"))!;
    await bucket.put(obj.key, "tampered");
    const response = await request(`/notes/${note.note_id}`);
    expect(response.status).toBe(409);
    expect(await response.text()).not.toContain("tampered");
    await bucket.delete(obj.key);
    expect((await request(`/notes/${note.note_id}`)).status).toBe(404);
    await bucket.put(obj.key, obj.content);
  });
  it("reports cloud freshness and explicit capability gaps", async () => {
    const result = (await request("/status").then((r) => r.json())) as any;
    expect(result.data.index.freshness.state).toBe("fresh");
    expect(result.data.deployment.capabilities).toMatchObject({
      lexical: true,
      mcpHttp: true,
      upload: false,
      indexJobs: false,
      semantic: false,
      gitSync: false,
      watch: false,
    });
    expect(result.data.watch.state).toBe("disabled");
    expect(JSON.stringify(result)).not.toContain(read);
  });
});

it("matches actual local SQLite reference ranking and filters", async () => {
  const { mkdtemp, mkdir, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join, dirname } = await import("node:path");
  const { DEFAULT_CONFIG } = await import("../../core/src/config.js");
  const { indexVault } = await import("../../core/src/indexer.js");
  const { IndexStore, getIndexPath } =
    await import("../../core/src/index-store.js");
  const { SqliteMetadataStore, SqliteVectorStore } =
    await import("../../core/src/local/sqlite.js");
  const { search } = await import("../../core/src/portable/search.js");
  const { files } = await import("../scripts/fixture.js");
  const root = await mkdtemp(join(tmpdir(), "cloud-reference-"));
  let store: InstanceType<typeof IndexStore> | undefined;
  try {
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(root, "vault", path)), { recursive: true });
      await writeFile(join(root, "vault", path), content);
    }
    const config = structuredClone(DEFAULT_CONFIG);
    config.vault.root = join(root, "vault");
    config.index.dir = join(root, "index");
    config.vault.exclude = ["AGENTS.md"];
    await indexVault(config);
    store = await IndexStore.open(getIndexPath(config));
    const metadata = new SqliteMetadataStore(store, VAULT_ID);
    const context = {
      metadata,
      vectors: new SqliteVectorStore(metadata),
      embeddingEnabled: false,
      compatibility: { stale: false, incompatible: false, details: "" },
    };
    for (const query of [
      "apple",
      "Orchard",
      "果樹園",
      "果樹",
      "Empty",
      "apple orchard",
      '" OR *',
    ]) {
      const local = await search(context, query, "lexical", 10);
      const remote = (await json("/search", { query, mode: "lexical" }).then(
        (r) => r.json(),
      )) as any;
      expect(
        remote.data.results.map((r: any) => [r.id, r.score]),
        query,
      ).toEqual(local.results.map((r) => [r.id, r.score]));
    }
    const filters = { tags: ["garden"], frontmatter: { status: ["active"] } };
    const local = await search(context, "apple", "lexical", 1, filters);
    const remote = (await json("/search", {
      query: "apple",
      mode: "lexical",
      limit: 1,
      filters,
    }).then((r) => r.json())) as any;
    expect(remote.data.results.map((r: any) => r.id)).toEqual(
      local.results.map((r) => r.id),
    );
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("exercises every MCP read tool with existing argument names and payloads", async () => {
  const id = seed.notes.find((n) => n.path === "Guide/Orchard.md")!.note_id;
  const calls: Record<string, unknown> = {
    search: {
      query: "apple",
      mode: "lexical",
      filters: { path_prefix: ["Guide"], tags: ["garden"] },
    },
    related: { type: "note", id, mode: "lexical" },
    get_note: { noteId: id, snapshot: seed.revision },
    get_chunk: { noteId: id, chunkIndex: 0 },
    get_attachment: { vaultRelativePath: "images/chart.png" },
    vault_overview: {},
    vault_tree: { depth: 2, direct_only: true },
    vault_tags: { limit: 10 },
    vault_facets: { limit: 10 },
    vault_guidance_list: {},
    vault_guidance_get: { path: "AGENTS.md" },
    vault_links: { noteId: id },
    vault_backlinks: { noteId: id },
    vault_broken_links: { limit: 10 },
    vault_orphans: { limit: 10 },
    vault_link_summary: { path_prefix: "Guide", limit: 5 },
    vault_metadata_profile: {
      path_prefix: "Guide",
      filters: { tags: ["garden"], frontmatter: { status: ["active"] } },
      example_selection: "representative",
    },
    vault_style_profile: { path_prefix: "Guide", filters: { note_ids: [id] } },
  };
  for (const [name, args] of Object.entries(calls)) {
    const response = (await mcp(
      rpc("tools/call", { name, arguments: args }),
    )) as any;
    expect(
      response.error,
      `${name}: ${JSON.stringify(response)}`,
    ).toBeUndefined();
    const payload = toolPayload(response);
    expect(payload.revision.snapshot).toBe(seed.revision);
    expect(payload.warnings).toBeDefined();
    expect(payload.data).toBeUndefined();
  }
});

it("rolls back D1 batches and never publishes a failed transaction", async () => {
  const before = await db
    .prepare("SELECT revision FROM deployment WHERE id=1")
    .first();
  await expect(
    db.batch([
      db
        .prepare("UPDATE deployment SET revision=? WHERE id=1")
        .bind(seed.revision),
      db
        .prepare(
          "INSERT INTO sources VALUES(?, 'rollback.txt','attachment',1,'digest','date')",
        )
        .bind(seed.revision),
      db
        .prepare(
          "INSERT INTO sources VALUES(?, 'rollback.txt','attachment',1,'digest','date')",
        )
        .bind(seed.revision),
    ]),
  ).rejects.toThrow();
  expect(
    await db
      .prepare("SELECT path FROM sources WHERE path='rollback.txt'")
      .first(),
  ).toBeNull();
  expect(
    await db.prepare("SELECT revision FROM deployment WHERE id=1").first(),
  ).toEqual(before);
});

it("rejects oversized note/guidance/attachment retrieval and same-length corruption", async () => {
  const note = seed.notes.find((n) => n.path === "Guide/Orchard.md")!;
  const key = seed.objects.find((o) => o.key.endsWith("/Guide/Orchard.md"))!;
  await bucket.put(key.key, key.content.replace("apple", "pears"));
  expect((await request(`/notes/${note.note_id}`)).status).toBe(409);
  await bucket.put(key.key, key.content);
  const entries = [
    ["Guide/Orchard.md", 201 * 1024, `/notes/${note.note_id}`],
    ["AGENTS.md", 201 * 1024, "/agent-guidance/AGENTS.md"],
    [
      "images/chart.png",
      11 * 1024 * 1024,
      "/attachments/images/chart.png?download=true",
    ],
  ] as const;
  for (const [path, size, url] of entries) {
    const original = seed.entries.find((e) => e.path === path)!;
    try {
      await db
        .prepare("UPDATE sources SET size=? WHERE revision=? AND path=?")
        .bind(size, seed.revision, path)
        .run();
      expect((await request(url)).status, url).toBe(413);
    } finally {
      await db
        .prepare("UPDATE sources SET size=? WHERE revision=? AND path=?")
        .bind(original.size, seed.revision, path)
        .run();
    }
  }
});

it("allows an empty committed snapshot and rejects historical pins after publication", async () => {
  const revision = "e".repeat(64);
  await db
    .prepare("INSERT INTO snapshots VALUES(?,?,?,?,?,?,?)")
    .bind(
      revision,
      VAULT_ID,
      JSON.stringify({ ...seed.manifest, noteCount: 0, chunkCount: 0 }),
      0,
      0,
      0,
      0,
    )
    .run();
  await db
    .prepare(
      `CREATE VIRTUAL TABLE fts_${revision} USING fts5(chunk_id UNINDEXED,lexical_text,tokenize='unicode61')`,
    )
    .run();
  try {
    await db
      .prepare("UPDATE deployment SET revision=? WHERE id=1")
      .bind(revision)
      .run();
    const result = (await json("/search", {
      query: "apple",
      mode: "lexical",
    }).then((r) => r.json())) as any;
    expect(result.data.results).toEqual([]);
    expect(result.revision.snapshot).toBe(revision);
    expect(
      (
        await request(
          `/notes/${seed.notes[0]!.note_id}?snapshot=${seed.revision}`,
        )
      ).status,
    ).toBe(409);
  } finally {
    await db
      .prepare("UPDATE deployment SET revision=? WHERE id=1")
      .bind(seed.revision)
      .run();
  }
});

it("fails closed on missing secrets and enforces HTTPS, exact Origins and rate limits", async () => {
  const instance = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-10-28",
      d1Databases: { DB: "security" },
      r2Buckets: { SOURCE: "security" },
      ratelimits: {
        REQUEST_LIMITER: {
          namespace_id: "1002",
          simple: { limit: 2, period: 60 },
        },
      },
      bindings: {
        VAULT_ID,
        INCLUDE_PATHS: '["."]',
        EXCLUDE_PATHS: "[]",
        PROFILE_VALUE_ALLOWLIST: '["type","status"]',
        ALLOWED_ORIGINS: '["https://allowed.invalid"]',
        READ_TOKEN: read,
        ADMIN_TOKEN: admin,
      },
    }),
  );
  try {
    const send = (url: string, headers: Record<string, string> = {}) =>
      instance.dispatchFetch(url, {
        method: "POST",
        headers: { Authorization: `Bearer ${admin}`, ...headers },
      });
    expect((await send("http://vault.example.invalid/index")).status).toBe(403);
    expect(
      (
        await send(base + "/index", {
          Origin: "https://allowed.invalid.attacker.invalid",
        })
      ).status,
    ).toBe(403);
    expect(
      (await send(base + "/index", { Origin: "https://allowed.invalid" }))
        .status,
    ).toBe(501);
    expect((await send(base + "/index")).status).toBe(501);
    const limited = await send(base + "/index");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
  } finally {
    await instance.dispose();
  }
  const missing = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script,
      compatibilityDate: "2026-10-28",
      bindings: {},
    }),
  );
  try {
    expect(
      (
        await missing.dispatchFetch(base + "/status", {
          headers: { Authorization: `Bearer ${read}` },
        })
      ).status,
    ).toBe(503);
    expect(
      await missing.dispatchFetch(base + "/health").then((r) => r.json()),
    ).toEqual({ status: "ok" });
  } finally {
    await missing.dispose();
  }
});

it("rejects invalid UTF-8 and maps malformed MCP input to sanitized protocol errors", async () => {
  const { contentRevision } =
    await import("../../core/src/portable/identifiers.js");
  const entry = seed.entries.find((e) => e.path === "AGENTS.md")!;
  const object = seed.objects.find((o) => o.key.endsWith("/AGENTS.md"))!;
  const invalid = new Uint8Array([0xff, 0xfe]);
  try {
    await bucket.put(object.key, invalid);
    await db
      .prepare("UPDATE sources SET size=?,digest=? WHERE revision=? AND path=?")
      .bind(
        invalid.length,
        await contentRevision(invalid),
        seed.revision,
        entry.path,
      )
      .run();
    const response = await request("/agent-guidance/AGENTS.md");
    expect(response.status).toBe(409);
    expect(((await response.json()) as any).error.code).toBe("SOURCE_NOT_UTF8");
  } finally {
    await bucket.put(object.key, object.content);
    await db
      .prepare("UPDATE sources SET size=?,digest=? WHERE revision=? AND path=?")
      .bind(entry.size, entry.revision, seed.revision, entry.path)
      .run();
  }
  const response = await request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: "invalid-json-sensitive-marker",
  });
  const result = (await response.json()) as any;
  expect(result.error.code).toBe(-32700);
  expect(JSON.stringify(result)).not.toContain("sensitive-marker");
  const invalidBatch = (await mcp([
    {},
    rpc("unknown-sensitive-method"),
  ])) as any;
  expect(invalidBatch).toHaveLength(2);
  expect(JSON.stringify(invalidBatch)).not.toContain(
    "unknown-sensitive-method",
  );
});

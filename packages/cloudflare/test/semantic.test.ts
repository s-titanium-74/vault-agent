import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { build } from "esbuild";
import * as core from "@vault-agent/core/portable";
import { fixture, VAULT_ID } from "../scripts/fixture.js";
import { D1MetadataStore } from "../src/d1.js";
import { VectorizeStore } from "../src/vectorize.js";
import {
  descriptor,
  MODEL,
  DIMENSION,
  WorkersAIEmbeddingProvider,
  ProviderOperations,
} from "../src/provider.js";
import { RetrievalService } from "../src/service.js";
import { config, type Env } from "../src/config.js";

let mf: Miniflare;
let db: D1Database;
let source: R2Bucket;
let seed: Awaited<ReturnType<typeof fixture>>;
let store: D1MetadataStore;
let vectors: VectorizeStore;
let records: VectorizeVector[];
const unit = () =>
  Float32Array.from({ length: DIMENSION }, (_, i) => (i === 0 ? 1 : 0));
const ai = {
  run: vi.fn(async (_model: string, input: { text: string[] }) => ({
    data: input.text.map(() => Array.from(unit())),
    shape: [input.text.length, DIMENSION],
  })),
};
const binding = {
  describe: vi.fn(async () => ({ dimensions: DIMENSION })),
  query: vi.fn(async (_vector: unknown, options: VectorizeQueryOptions) => ({
    matches: records
      .filter(
        (r) =>
          r.namespace === options.namespace &&
          (!options.filter || r.metadata?.chunkId === options.filter.chunkId),
      )
      .slice(0, options.topK)
      .map((r) => ({ ...r, score: 0.9 })),
  })),
  getByIds: vi.fn(async (ids: string[]) =>
    records.filter((r) => ids.includes(r.id)),
  ),
  upsert: vi.fn(async (values: VectorizeVector[]) => {
    records = values;
    return { mutationId: "synthetic-receipt" };
  }),
  deleteByIds: vi.fn(async () => ({ mutationId: "synthetic-delete" })),
};
let env: Env;
const readToken = randomBytes(32).toString("hex");
const adminToken = randomBytes(32).toString("hex");
const provider = () =>
  new WorkersAIEmbeddingProvider(ai as never, "operator-v1");
const context = () => ({
  metadata: store,
  vectors,
  embeddingProvider: provider(),
  embeddingEnabled: true,
  compatibility: { stale: false, incompatible: false, details: "" },
});

beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["test/semantic-worker.ts"],
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
      d1Databases: { DB: "semantic" },
      r2Buckets: { SOURCE: "semantic" },
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
        PROFILE_VALUE_ALLOWLIST: "[]",
        ALLOWED_ORIGINS: "[]",
        READ_TOKEN: readToken,
        ADMIN_TOKEN: adminToken,
        EXTERNAL_EMBEDDING_CONSENT: "true",
        EMBEDDING_MODEL: MODEL,
        EMBEDDING_MODEL_REVISION: "operator-v1",
      },
    }),
  );
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  source = (await mf.getR2Bucket("SOURCE")) as unknown as R2Bucket;
  for (const name of ["0001_retrieval.sql", "0002_semantic.sql"]) {
    const sql = await readFile(`migrations/${name}`, "utf8");
    for (const statement of sql
      .replace(/--[^\n]*/g, "")
      .split(";")
      .filter((s) => s.trim()))
      await db.prepare(statement).run();
  }
  seed = await fixture({
    "Guide/Huerto.md":
      "---\ntitle: Huerto\ntags: [garden]\ntype: guide\nstatus: active\n---\n# Huerto\nCultivar árboles frutales en primavera.\n",
  });
  for (const sql of seed.statements) await db.prepare(sql).run();
  for (const object of seed.objects)
    await source.put(object.key, object.content);
  seed.manifest.embeddingModel = MODEL;
  seed.manifest.embeddingDimension = DIMENSION;
  await db
    .prepare("UPDATE snapshots SET manifest=? WHERE revision=?")
    .bind(JSON.stringify(seed.manifest), seed.revision)
    .run();
  await db
    .prepare("INSERT INTO embedding_generations VALUES(?,?,?,'ready')")
    .bind(
      seed.revision,
      await core.contentRevision(JSON.stringify(descriptor("operator-v1"))),
      JSON.stringify(descriptor("operator-v1")),
    )
    .run();
});
afterAll(async () => {
  await mf?.dispose();
});
beforeEach(async () => {
  vi.clearAllMocks();
  store = new D1MetadataStore(
    db,
    VAULT_ID,
    seed.revision,
    seed.manifest,
    core.sourcePolicy(["."]),
  );
  vectors = new VectorizeStore(binding as never, store, "operator-v1");
  const { namespace, generation } = await vectors.identity();
  records = await Promise.all(
    seed.chunks.map(async (c) => ({
      id: await vectors.id(String(c.chunk_id)),
      namespace,
      values: unit(),
      metadata: {
        chunkId: String(c.chunk_id),
        contentHash: String(c.content_hash),
        generation,
      },
    })),
  );
  env = {
    DB: db,
    SOURCE: source,
    VECTORS: binding,
    AI: ai,
    VAULT_ID,
    INCLUDE_PATHS: '["."]',
    EXCLUDE_PATHS: "[]",
    PROFILE_VALUE_ALLOWLIST: "[]",
    ALLOWED_ORIGINS: "[]",
    REQUEST_LIMITER: {},
    READ_TOKEN: randomBytes(32).toString("hex"),
    ADMIN_TOKEN: randomBytes(32).toString("hex"),
    EXTERNAL_EMBEDDING_CONSENT: "true",
    EMBEDDING_MODEL: MODEL,
    EMBEDDING_MODEL_REVISION: "operator-v1",
  } as unknown as Env;
  await db
    .prepare("UPDATE embedding_generations SET state='ready' WHERE revision=?")
    .bind(seed.revision)
    .run();
});

it("shares multilingual embedding, hybrid fusion and structured filters with core", async () => {
  for (const query of ["fruit trees", "果樹園の季節", "árboles frutales"]) {
    const result = await core.search(context(), query, "embedding", 10, {
      tags: ["garden"],
      pathPrefix: ["Guide"],
      frontmatter: { type: ["guide"], status: ["active"] },
    });
    expect(result.usedMode).toBe("embedding");
    expect(result.results.length).toBe(2);
    expect(result.results.map((r) => r.path).sort()).toEqual([
      "Guide/Huerto.md",
      "Guide/Orchard.md",
    ]);
    expect(result.results.every((r) => r.reason === "embedding_match")).toBe(
      true,
    );
  }
  const result = await core.search(context(), "apple", "hybrid", 2);
  expect(result.usedMode).toBe("hybrid");
  expect(result.results).toHaveLength(2);
  expect(result.results.every((r) => r.reason === "hybrid_match")).toBe(true);
  expect(ai.run).toHaveBeenCalledWith(
    MODEL,
    expect.objectContaining({ truncate_inputs: false }),
  );
});

it("requires consent independently of bindings and performs no provider work for lexical", async () => {
  const disabled = { ...env, EXTERNAL_EMBEDDING_CONSENT: "false" } as Env;
  expect(config(disabled).semantic).toBe(false);
  expect(() =>
    config({ ...env, EMBEDDING_MODEL_REVISION: undefined } as unknown as Env),
  ).toThrow();
  expect(() => config({ ...env, AI: undefined })).toThrow();
  const service = await RetrievalService.open(disabled);
  expect(
    (await service.invoke("search", { query: "apple", mode: "hybrid" }))
      .warnings[0]?.code,
  ).toBe("EMBEDDING_UNAVAILABLE");
  await core.search(context(), "apple", "lexical", 5);
  expect(ai.run).not.toHaveBeenCalled();
  expect(binding.describe).not.toHaveBeenCalled();
  expect(binding.query).not.toHaveBeenCalled();
});

it("reports generation readiness and rejects dimension, model and descriptor mismatch", async () => {
  expect(
    (await (await RetrievalService.open(env)).status("vault.example.invalid"))
      .deployment.capabilities.semantic,
  ).toBe(true);
  for (const state of ["pending", "unavailable"]) {
    await db
      .prepare("UPDATE embedding_generations SET state=? WHERE revision=?")
      .bind(state, seed.revision)
      .run();
    const service = await RetrievalService.open(env);
    expect(
      (await service.status("vault.example.invalid")).index.embeddingState,
    ).toBe("unavailable");
    expect((await core.search(context(), "apple", "hybrid", 2)).usedMode).toBe(
      "lexical",
    );
    await expect(
      core.search(context(), "apple", "embedding", 2),
    ).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
  }
  await db
    .prepare("UPDATE embedding_generations SET state='ready' WHERE revision=?")
    .bind(seed.revision)
    .run();
  expect(
    await new VectorizeStore(
      binding as never,
      store,
      "new-model-revision",
    ).available(),
  ).toBe(false);
  const original = store.manifest.embeddingDimension;
  store.manifest.embeddingDimension = 768;
  expect(await vectors.available()).toBe(false);
  store.manifest.embeddingDimension = original;
  binding.describe.mockResolvedValueOnce({ dimensions: 768 });
  expect(await vectors.available()).toBe(false);
});

it("discards old, deleted, foreign and excluded matches and fails closed on source mismatch", async () => {
  records[0]!.metadata!.contentHash = "outdated";
  records[1]!.metadata!.generation = "other-generation";
  records[2]!.metadata!.chunkId = "00000000000000000000000000000000:0";
  records[2]!.id = await vectors.id(String(records[2]!.metadata!.chunkId));
  const result = await core.search(context(), "orchard", "embedding", 10);
  expect(result.results).toHaveLength(records.length - 3);
  const restricted = new D1MetadataStore(
    db,
    VAULT_ID,
    seed.revision,
    seed.manifest,
    core.sourcePolicy(["Guide"]),
  );
  const filtered = await core.search(
    {
      ...context(),
      metadata: restricted,
      vectors: new VectorizeStore(binding as never, restricted, "operator-v1"),
    },
    "apple",
    "embedding",
    10,
  );
  expect(filtered.results.every((r) => r.path.startsWith("Guide/"))).toBe(true);
  const remaining = seed.notes.find(
    (n) => n.note_id === result.results[0]!.noteId,
  )!;
  await db
    .prepare("UPDATE sources SET digest='changed' WHERE revision=? AND path=?")
    .bind(seed.revision, remaining.path)
    .run();
  try {
    await expect(
      core.search(context(), "apple", "embedding", 10),
    ).rejects.toMatchObject({ code: "SOURCE_REVISION_MISMATCH" });
  } finally {
    await db
      .prepare("UPDATE sources SET digest=? WHERE revision=? AND path=?")
      .bind(remaining.content_hash, seed.revision, remaining.path)
      .run();
  }
});

it("sanitizes AI and Vectorize failures and falls back only where permitted", async () => {
  for (const failure of [ai.run, binding.query, binding.getByIds]) {
    failure.mockRejectedValueOnce(new Error("sensitive-provider-message"));
    const result = await core.search(context(), "apple", "hybrid", 2);
    expect(result.usedMode).toBe("lexical");
    expect(result.warnings[0]?.code).toBe("EMBEDDING_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toContain("sensitive-provider-message");
    failure.mockRejectedValueOnce(new Error("sensitive-provider-message"));
    await expect(
      core.search(context(), "apple", "embedding", 2),
    ).rejects.toMatchObject({ code: "EMBEDDING_UNAVAILABLE" });
  }
});

it("bounds embedding batches, validates output dimensions and tracks usage without content", async () => {
  const p = provider();
  const texts = ["Fruit trees", "日本語の果樹園", "árboles frutales"];
  const response = await p.embed(texts);
  expect(response.embeddings).toHaveLength(3);
  expect(response.embeddings[0]!.length).toBe(DIMENSION);
  expect(p.operations.counts.embeddingInputs).toBe(3);
  expect(JSON.stringify(p.operations.counts)).not.toContain("Fruit");
  for (const invalid of [
    [],
    Array(17).fill("text"),
    ["x".repeat(8001)],
    Array(5).fill("x".repeat(8000)),
  ])
    await expect(p.embed(invalid)).rejects.toBeInstanceOf(
      core.EmbeddingProviderError,
    );
  for (const invalid of [[0], Array(1024).fill(0), Array(1024).fill(NaN)]) {
    ai.run.mockResolvedValueOnce({
      data: [invalid],
      shape: [1, invalid.length],
    });
    await expect(p.embed(["text"])).rejects.toBeInstanceOf(
      core.EmbeddingProviderError,
    );
  }
});

it("bounds retries, honors Retry-After and does not retry permanent errors", async () => {
  const operations = new ProviderOperations();
  const transient = vi
    .fn()
    .mockRejectedValueOnce({ status: 429, retryAfter: 0 })
    .mockResolvedValue("ok");
  expect(await operations.run(transient)).toBe("ok");
  expect(operations.counts).toMatchObject({ attempts: 2, retries: 1 });
  const exhausted = vi.fn().mockRejectedValue({ status: 503, retryAfter: 0 });
  await expect(operations.run(exhausted)).rejects.toBeInstanceOf(
    core.EmbeddingProviderError,
  );
  expect(exhausted).toHaveBeenCalledTimes(3);
  const delayed = vi.fn().mockRejectedValue({
    status: 429,
    headers: new Headers({ "Retry-After": "60" }),
  });
  await expect(operations.run(delayed)).rejects.toBeInstanceOf(
    core.EmbeddingProviderError,
  );
  expect(delayed).toHaveBeenCalledTimes(1);
});

it("keeps writes pending, checks query visibility and forbids mutating active generations", async () => {
  const entries = seed.chunks.map((c) => ({
    chunkId: String(c.chunk_id),
    contentHash: String(c.content_hash),
    values: unit(),
  }));
  await expect(vectors.upsert(entries)).rejects.toBeInstanceOf(
    core.EmbeddingProviderError,
  );
  await expect(
    vectors.delete(entries.map((e) => e.chunkId)),
  ).rejects.toBeInstanceOf(core.EmbeddingProviderError);
  await db.prepare("DELETE FROM deployment").run();
  await db
    .prepare(
      "UPDATE embedding_generations SET state='pending' WHERE revision=?",
    )
    .bind(seed.revision)
    .run();
  try {
    const receipt = await vectors.upsert(entries);
    expect(await vectors.mutationStatus(receipt)).toBe("pending");
    expect(await vectors.visible(entries)).toBe(true);
    expect(
      binding.upsert.mock.calls[0]![0].every(
        (r) =>
          Object.keys(r.metadata!).sort().join() ===
          "chunkId,contentHash,generation",
      ),
    ).toBe(true);
    records = [];
    expect(await vectors.visible(entries)).toBe(false);
    await expect(
      vectors.upsert(Array(101).fill(entries[0])),
    ).rejects.toBeInstanceOf(core.EmbeddingProviderError);
    expect((await vectors.delete(entries.map((e) => e.chunkId))).state).toBe(
      "pending",
    );
  } finally {
    await db
      .prepare("INSERT INTO deployment VALUES(1,?)")
      .bind(seed.revision)
      .run();
  }
});

it("serves authenticated semantic HTTP and MCP with per-operation usage in workerd", async () => {
  const search = {
    query: "果樹園",
    mode: "embedding",
    limit: 2,
    filters: { tags: ["garden"] },
  };
  const request = async (
    path: string,
    body: unknown,
    extra: Record<string, string> = {},
  ) =>
    mf.dispatchFetch(`https://vault.example.invalid${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${readToken}`,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        ...extra,
      },
      body: JSON.stringify(body),
    });
  const response = await request("/search", search);
  expect(response.status).toBe(200);
  const http = (await response.json()) as any;
  expect(http.data.usedMode).toBe("embedding");
  expect(http.data.results).toHaveLength(2);
  expect(http.usage).toMatchObject({
    embeddingInputs: 1,
    vectorQueries: 1,
    retries: 0,
  });
  expect(http.revision.snapshot).toBe(seed.revision);
  expect(response.headers.get("Cache-Control")).toBe("no-store");
  const rpc = await request("/mcp", {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: "search", arguments: search },
  });
  const mcp = JSON.parse(((await rpc.json()) as any).result.content[0].text);
  expect(mcp.usedMode).toBe("embedding");
  expect(mcp.usage.embeddingInputs).toBe(1);
  const lexical = await request("/search", { ...search, mode: "lexical" });
  expect(((await lexical.json()) as any).usage.attempts).toBe(0);
  const fallback = await request(
    "/search",
    { ...search, mode: "hybrid" },
    { "X-Synthetic-Failure": "true" },
  );
  const fallbackBody = (await fallback.json()) as any;
  expect(fallbackBody.data.usedMode).toBe("lexical");
  expect(fallbackBody.warnings[0].code).toBe("EMBEDDING_UNAVAILABLE");
  const failed = await request("/search", search, {
    "X-Synthetic-Failure": "true",
  });
  expect(failed.status).toBe(503);
  expect(JSON.stringify(await failed.json())).not.toContain(
    "synthetic-private-provider-error",
  );
});

it("rejects a semantic response when publication switches the active snapshot", async () => {
  const revision = "f".repeat(64);
  await db
    .prepare(
      "INSERT INTO snapshots SELECT ?,vault_id,manifest,note_count,chunk_count,entry_count,indexed_bytes FROM snapshots WHERE revision=?",
    )
    .bind(revision, seed.revision)
    .run();
  const service = await RetrievalService.open(env);
  binding.query.mockImplementationOnce(async () => {
    await db
      .prepare("UPDATE deployment SET revision=? WHERE id=1")
      .bind(revision)
      .run();
    return { matches: records.map((r) => ({ ...r, score: 0.9 })) };
  });
  try {
    await expect(
      service.invoke("search", { query: "果樹園", mode: "embedding" }),
    ).rejects.toMatchObject({ code: "REVISION_CHANGED" });
  } finally {
    await db
      .prepare("UPDATE deployment SET revision=? WHERE id=1")
      .bind(seed.revision)
      .run();
    await db
      .prepare("DELETE FROM snapshots WHERE revision=?")
      .bind(revision)
      .run();
  }
});

it("caps vector candidate requests and rejects foreign namespaces", async () => {
  const response = await vectors.query(unit(), 150);
  expect(binding.query.mock.calls[0]![1]).toMatchObject({
    topK: 100,
    returnMetadata: "none",
    returnValues: false,
  });
  expect(response.length).toBeLessThanOrEqual(100);
  records[0]!.namespace = "foreign-snapshot";
  binding.query.mockResolvedValueOnce({
    matches: records.map((r) => ({ ...r, score: 0.9 })),
  });
  expect(await vectors.query(unit(), 10)).toHaveLength(records.length - 1);
  expect(vectors.score(0)).toBe(1);
  expect(vectors.score(1)).toBe(0.5);
  expect(vectors.score(2)).toBe(0);
});

it("enforces operation deadlines without retrying an unresponsive provider", async () => {
  vi.useFakeTimers();
  try {
    const operations = new ProviderOperations();
    const call = vi.fn(() => new Promise(() => {}));
    const rejected = expect(operations.run(call)).rejects.toBeInstanceOf(
      core.EmbeddingProviderError,
    );
    await vi.advanceTimersByTimeAsync(10001);
    await rejected;
    expect(call).toHaveBeenCalledTimes(1);
    const cancelled = vi.fn();
    await expect(
      operations.run(cancelled, AbortSignal.abort()),
    ).rejects.toBeDefined();
    expect(cancelled).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});

import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { FilesystemSource } from "../src/local/filesystem.js";
import { SqliteMetadataStore, SqliteVectorStore } from "../src/local/sqlite.js";
import { IndexStore } from "../src/index-store.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { indexVault } from "../src/indexer.js";
import { getIndexPath } from "../src/index-store.js";
import { noteIdFromPath as localId } from "../src/identifiers.js";
import { chunkNote as localChunk } from "../src/chunking.js";
import {
  canonicalSourcePath,
  contentRevision,
  noteIdFromPath,
  createVaultId,
  chunkNote,
  getNote,
  getChunk,
  search,
  getRelated,
  sourcePolicy,
  type MetadataLexicalStore,
  type RetrievalContext,
  type VectorStore,
} from "../src/portable/index.js";

const temp: string[] = [];
const stores: IndexStore[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  for (const dir of temp.splice(0))
    await fs.rm(dir, { recursive: true, force: true });
});
async function directory() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "portable-contract-"));
  temp.push(dir);
  return dir;
}
async function fixture() {
  const root = await directory();
  const data = await directory();
  await fs.mkdir(path.join(root, "Notes"));
  await fs.mkdir(path.join(root, "attachments"));
  await fs.writeFile(
    path.join(root, "Notes/Alpha.md"),
    "---\ntags: [topic]\nstatus: active\n---\n# Alpha\n\n" +
      "Synthetic lexical context. ".repeat(30),
  );
  await fs.writeFile(
    path.join(root, "Notes/Beta.md"),
    "# Beta\n\n" + "Synthetic lexical context. ".repeat(30),
  );
  await fs.writeFile(
    path.join(root, "attachments/sample.pdf"),
    new Uint8Array([0, 1, 2]),
  );
  const config = structuredClone(DEFAULT_CONFIG);
  config.vault.root = root;
  config.index.dir = data;
  await indexVault(config);
  const store = await IndexStore.open(getIndexPath(config));
  stores.push(store);
  const vaultId = createVaultId();
  const metadata = new SqliteMetadataStore(store, vaultId);
  const source = new FilesystemSource(root, vaultId, ["Notes", "attachments"]);
  const context: RetrievalContext = {
    metadata,
    vectors: new SqliteVectorStore(metadata),
    embeddingEnabled: false,
    compatibility: { stale: false, incompatible: false, details: "" },
  };
  return { root, store, metadata, source, context };
}

describe("portable identities and source contracts", () => {
  it.each(["Folder/Note.md", "日本語/例.md", "Café.md", "a%20b.md"])(
    "preserves local ID and chunk hash bytes: %s",
    async (relative) => {
      expect(await noteIdFromPath(relative)).toBe(localId(relative));
      const input = {
        noteId: localId(relative),
        vaultRelativePath: relative,
        title: "Synthetic",
        headingPath: [],
        body: "# Topic\n\n" + "文書 content. ".repeat(500),
        fileSize: 1000,
      };
      expect(await chunkNote(input)).toEqual(localChunk(input));
    },
  );
  it.each([
    "../secret.md",
    "/Note.md",
    "C:/Note.md",
    "\\\\host\\Note.md",
    "a//b.md",
    "a/./b.md",
    "a/../b.md",
    "a\u0000b.md",
    "https:note.md",
    "\ud800.md",
  ])("rejects noncanonical paths: %s", (relative) => {
    expect(() => canonicalSourcePath(relative)).toThrow();
  });
  it("preserves literal percent names without decoding a source path twice", () => {
    expect(canonicalSourcePath("Notes/%2e%2e.md")).toBe("Notes/%2e%2e.md");
  });
  it("enforces include/exclude and hidden guidance exceptions", () => {
    const allowed = sourcePolicy(["."], ["Private/**"]);
    for (const relative of [
      ".env",
      "Private/Note.md",
      ".git/config",
      "node_modules/pkg/a.md",
      ".hidden/AGENTS.md",
      ".cursor/other/AGENTS.md",
    ])
      expect(allowed(relative)).toBe(false);
    for (const relative of [
      "Notes/Note.md",
      ".cursorrules",
      ".cursor/rules/style.mdc",
    ])
      expect(allowed(relative)).toBe(true);
    expect(sourcePolicy(["Notes"])("attachments/a.pdf")).toBe(false);
  });
  it("paginates allowed files and verifies text/byte revisions and budgets", async () => {
    const { source } = await fixture();
    const first = await source.list({ limit: 1 });
    const second = await source.list({ limit: 1, cursor: first.cursor });
    const third = await source.list({ limit: 1, cursor: second.cursor });
    expect(
      [...first.items, ...second.items, ...third.items].map((e) => e.path),
    ).toEqual(["Notes/Alpha.md", "Notes/Beta.md", "attachments/sample.pdf"]);
    expect(third.cursor).toBeUndefined();
    const entry = first.items[0]!;
    const text = await source.readText(entry.path, {
      expectedRevision: entry.revision,
      maxBytes: 5000,
    });
    expect(await contentRevision(text)).toBe(entry.revision);
    await expect(
      source.readText(entry.path, {
        expectedRevision: entry.revision,
        maxBytes: 1,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
    const attachment = third.items[0]!;
    const bytes = await source.readBytes(attachment.path, {
      expectedRevision: attachment.revision,
      maxBytes: 3,
    });
    expect(new Uint8Array(await new Response(bytes).arrayBuffer())).toEqual(
      new Uint8Array([0, 1, 2]),
    );
    await expect(source.list({ limit: 0 })).rejects.toMatchObject({
      code: "INVALID_CURSOR",
    });
    await expect(source.stat("../outside.md")).rejects.toMatchObject({
      code: "INVALID_PATH",
    });
  });
  it("distinguishes missing/excluded files, rejects symlinks and sanitizes failures", async () => {
    const { root, source } = await fixture();
    expect(await source.stat("Notes/Missing.md")).toBeNull();
    await expect(source.stat("Private/Note.md")).rejects.toMatchObject({
      code: "SOURCE_EXCLUDED",
    });
    const outside = await directory();
    await fs.writeFile(
      path.join(outside, "Secret.md"),
      "synthetic excluded content",
    );
    await fs.symlink(
      path.join(outside, "Secret.md"),
      path.join(root, "Notes/Link.md"),
    );
    await expect(source.stat("Notes/Link.md")).rejects.toMatchObject({
      code: "SOURCE_EXCLUDED",
    });
    const listed = await source.list({ limit: 100 });
    expect(listed.items.some((e) => e.path.endsWith("Link.md"))).toBe(false);
    try {
      await source.stat("Notes/Link.md");
    } catch (error) {
      expect(String(error)).not.toContain(root);
      expect(String(error)).not.toContain("excluded content");
    }
  });
  it("rejects changed content and honors cancellation before file reads", async () => {
    const { root, source } = await fixture();
    const entry = (await source.stat("Notes/Alpha.md"))!;
    await fs.writeFile(
      path.join(root, entry.path),
      "replacement synthetic content",
    );
    await expect(
      source.readText(entry.path, {
        expectedRevision: entry.revision,
        maxBytes: 5000,
      }),
    ).rejects.toMatchObject({ code: "SOURCE_REVISION_MISMATCH" });
    const controller = new AbortController();
    controller.abort();
    await expect(
      source.stat(entry.path, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    await expect(
      source.list({ limit: 10, signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
  it("retrieves only the selected note/chunk and refuses mixed vaults or stale sources", async () => {
    const { root, metadata, source } = await fixture();
    const id = await noteIdFromPath("Notes/Alpha.md");
    const note = await getNote(metadata, source, id);
    expect(note?.content).toContain("# Alpha");
    expect((await getChunk(metadata, id, 0))?.content).not.toContain("tags:");
    expect(await getNote(metadata, source, "a".repeat(32))).toBeNull();
    await expect(
      getNote(metadata, new FilesystemSource(root, "other-vault", ["."]), id),
    ).rejects.toMatchObject({ code: "SOURCE_EXCLUDED" });
    await fs.writeFile(path.join(root, "Notes/Alpha.md"), "changed content");
    await expect(getNote(metadata, source, id)).rejects.toMatchObject({
      code: "SOURCE_REVISION_MISMATCH",
    });
  });
});

// Asynchronous proxy makes every storage result cross a real event-loop turn.
function delayed<T extends object>(adapter: T): T {
  return new Proxy(adapter, {
    get(target, key) {
      const member = Reflect.get(target, key);
      return typeof member === "function"
        ? async (...args: unknown[]) => {
            await new Promise((resolve) => setTimeout(resolve, 0));
            return member.apply(target, args);
          }
        : member;
    },
  });
}

describe("asynchronous retrieval adapters", () => {
  it("uses async metadata reads, filters and compact results through local adapters", async () => {
    const { context, metadata } = await fixture();
    const asyncMetadata: MetadataLexicalStore = delayed(metadata);
    const result = await search(
      { ...context, metadata: asyncMetadata },
      "lexical",
      "lexical",
      10,
      { tags: ["topic"], frontmatter: { status: ["active"] } },
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.path).toBe("Notes/Alpha.md");
    expect(result.results[0]).not.toHaveProperty("content");
    expect(result.results[0]!.snippet.length).toBeLessThan(250);
    const notes = await metadata.listNotes({ limit: 1 });
    expect(
      (await metadata.listNotes({ limit: 1, cursor: notes.cursor })).items[0]!
        .path,
    ).toBe("Notes/Beta.md");
    const chunks = await metadata.getChunks(result.results[0]!.noteId, {
      limit: 1,
    });
    expect(chunks.items).toHaveLength(1);
    const related = await getRelated(
      { ...context, metadata: asyncMetadata },
      "note",
      result.results[0]!.noteId,
      "lexical",
      10,
    );
    expect(related.results.some((r) => r.path === "Notes/Beta.md")).toBe(true);
    expect(
      related.results.every((r) => r.noteId !== result.results[0]!.noteId),
    ).toBe(true);
  });
  it("keeps provider I/O opt-in and preserves fallback through the portable error class", async () => {
    const { context } = await fixture();
    const embed = vi.fn();
    const provider = {
      describe: () => ({
        provider: "synthetic",
        model: "synthetic",
        modelRevision: null,
        metric: null,
        normalization: null,
        maxInputTokens: null,
        dimension: 2,
        inputFormat: "v1",
        maxBatchSize: 1,
        maxInputCharacters: 1000,
      }),
      embed,
    };
    await search(
      { ...context, embeddingProvider: provider },
      "lexical",
      undefined,
      10,
    );
    expect(embed).not.toHaveBeenCalled();
    const result = await search(
      { ...context, embeddingEnabled: true, embeddingProvider: provider },
      "lexical",
      "hybrid",
      10,
    );
    expect(result.usedMode).toBe("lexical");
    expect(
      result.warnings.some((w) => w.code === "EMBEDDING_UNAVAILABLE"),
    ).toBe(true);
    expect(embed).not.toHaveBeenCalled();
  });
});

describe("independent in-memory backend", () => {
  it("shares ranking and final filters without SQLite or backend-specific distance assumptions", async () => {
    const { context, store } = await fixture();
    const manifest = {
      ...store.getManifest()!,
      embeddingModel: "synthetic",
      embeddingDimension: 2,
    };
    const notes = store.getAllNotes();
    const rows = store.getAllChunkIds().map((id) => store.getChunkById(id)!);
    const lookup = new Map(rows.map((row) => [row.chunk_id as string, row]));
    const metadata: MetadataLexicalStore = {
      vaultId: context.metadata.vaultId,
      getManifest: async () => manifest,
      getNote: async (id) => notes.find((row) => row.note_id === id) ?? null,
      getChunk: async (id, index) => lookup.get(`${id}:${index}`) ?? null,
      getChunkById: async (id) => lookup.get(id) ?? null,
      getChunks: async (id, request) => ({
        items: rows.filter((r) => r.note_id === id).slice(0, request.limit),
      }),
      listNotes: async (request) => ({ items: notes.slice(0, request.limit) }),
      hasMatchingNotes: async () => true,
      searchLexical: async () =>
        rows.map((row, index) => ({ chunk_id: row.chunk_id, rank: index + 1 })),
      searchTrigrams: async () => [],
      searchNotes: async () => [],
    };
    const vectors: VectorStore = {
      vaultId: metadata.vaultId,
      minimumScore: 0.8,
      available: async () => true,
      // A different backend metric; interpreting 7 as local L2 would drop it.
      score: (distance) => (distance === 7 ? 1 : 0),
      query: async () => [
        ...rows.map((row) => ({
          chunk_id: row.chunk_id as string,
          distance: 7,
        })),
        { chunk_id: "removed:0", distance: 7 },
      ],
      upsert: async () => ({ id: null, state: "complete" }),
      delete: async () => ({ id: null, state: "complete" }),
      mutationStatus: async () => "complete",
    };
    const provider = {
      describe: () => ({
        provider: "synthetic",
        model: "synthetic",
        dimension: 2,
        modelRevision: null,
        metric: null,
        normalization: null,
        maxInputTokens: null,
        inputFormat: "v1",
        maxBatchSize: 1,
        maxInputCharacters: 1000,
      }),
      embed: async () => ({
        model: "synthetic",
        dimension: 2,
        embeddings: [new Float32Array([1, 0])],
      }),
    };
    const memory = {
      ...context,
      metadata: delayed(metadata),
      vectors,
      embeddingEnabled: true,
      embeddingProvider: provider,
    };
    // Close the real store: any accidental dependence on SQLite now fails.
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const result = await search(memory, "synthetic", "embedding", 10, {
      tags: ["topic"],
    });
    expect(result.results.map((r) => r.path)).toEqual(["Notes/Alpha.md"]);
    expect(result.results[0]!.score).toBe(1);
    expect(
      (await getChunk(metadata, result.results[0]!.noteId, 0))!.content,
    ).toContain("Synthetic");
    await expect(
      search(
        { ...memory, vectors: { ...vectors, vaultId: "another-vault" } },
        "synthetic",
        "lexical",
        10,
      ),
    ).rejects.toMatchObject({ code: "INDEX_VAULT_IDENTITY_CHANGED" });
  });
});

it("retains decoded-text compatibility for BOM notes while pinning source bytes", async () => {
  const { root, store, metadata, source } = await fixture();
  const content = "\ufeff# Alpha\n\nSynthetic BOM content.";
  await fs.writeFile(path.join(root, "Notes/Alpha.md"), content);
  const id = await noteIdFromPath("Notes/Alpha.md");
  const decoded = new TextDecoder().decode(new TextEncoder().encode(content));
  // Simulate the existing indexer's decoded-text hash without changing schema.
  store
    .getDb()
    .prepare("UPDATE notes SET content_hash = ? WHERE note_id = ?")
    .run((await contentRevision(decoded)).slice(0, 32), id);
  expect((await getNote(metadata, source, id))!.content).toBe(decoded);
});

it("reports vector mutation completion and unavailable storage explicitly", async () => {
  const { context, store } = await fixture();
  if (await context.vectors.available()) {
    store.initVecTable(2);
    const row = store.getChunkById(store.getAllChunkIds()[0]!)!;
    const receipt = await context.vectors.upsert([
      {
        chunkId: row.chunk_id as string,
        values: new Float32Array([1, 0]),
        contentHash: row.content_hash as string,
      },
    ]);
    expect(await context.vectors.mutationStatus(receipt)).toBe("complete");
    expect(
      (await context.vectors.query(new Float32Array([1, 0]), 1))[0]!.chunk_id,
    ).toBe(row.chunk_id);
    expect((await context.vectors.delete([row.chunk_id as string])).state).toBe(
      "complete",
    );
  }
  const spy = vi.spyOn(store, "isVecAvailable").mockReturnValue(false);
  expect(
    (
      await context.vectors.upsert([
        {
          chunkId: "synthetic:0",
          values: new Float32Array([1, 0]),
          contentHash: "synthetic",
        },
      ])
    ).state,
  ).toBe("failed");
  spy.mockRestore();
});

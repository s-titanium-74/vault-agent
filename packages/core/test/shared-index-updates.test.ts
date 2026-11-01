import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  planSourceChanges,
  prepareEmbeddingBatch,
  embeddingInputKey,
  prepareIndexDelta,
  indexRowsEqual,
} from "../src/portable/index-updates.js";
import { createIndexLinkResolver } from "../src/portable/index-data.js";
import type {
  EmbeddingDescriptor,
  EmbeddingProviderContract,
} from "../src/portable/contracts.js";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { indexVault, reindexVault } from "../src/indexer.js";
import { incrementalIndexUpdate } from "../src/incremental-indexer.js";
import { IndexStore, getIndexPath } from "../src/index-store.js";
import { EmbeddingProvider } from "../src/embedding.js";
import { noteIdFromPath } from "../src/identifiers.js";
import { search } from "../src/search.js";

const descriptor: EmbeddingDescriptor = {
  provider: "synthetic",
  model: "synthetic-model",
  modelRevision: "v1",
  metric: "cosine",
  normalization: "unit",
  maxInputTokens: null,
  dimension: 2,
  inputFormat: "fixture-v1",
  maxBatchSize: 16,
  maxInputCharacters: 8000,
};
describe("portable update decisions", () => {
  it("compares prepared rows by content, preserving unchanged identities", () => {
    const before = [
      { note_id: "a", content: { x: 1, y: [2] } },
      { note_id: "b", title: "old" },
      { note_id: "c" },
    ];
    const target = [
      { content: { y: [2], x: 1 }, note_id: "a" },
      { note_id: "b", title: "new" },
      { note_id: "d" },
    ];
    const delta = prepareIndexDelta(before, target, "note_id");
    expect(delta.upserts.map((r) => r.note_id)).toEqual(["b", "d"]);
    expect(delta.removals.map((r) => r.note_id)).toEqual(["c"]);
    expect(indexRowsEqual([1, 2], [2, 1])).toBe(false);
    expect(() =>
      prepareIndexDelta([], [{ chunk_id: "a" }, { chunk_id: "a" }], "chunk_id"),
    ).toThrow("Duplicate");
  });
  it("distinguishes complete scan deletion, partial events and unavailable sources", () => {
    const old = [
      { path: "a.md", kind: "note" as const, revision: "old" },
      { path: "b.md", kind: "note" as const, revision: "same" },
    ];
    const observed = [
      { path: "a.md", source: { ...old[0]!, revision: "new" } },
    ];
    expect(
      planSourceChanges(old, observed).map((c) => [c.path, c.action]),
    ).toEqual([["a.md", "upsert"]]);
    expect(
      planSourceChanges(old, observed, { complete: true }).map((c) => [
        c.path,
        c.action,
      ]),
    ).toEqual([
      ["a.md", "upsert"],
      ["b.md", "remove"],
    ]);
    expect(
      planSourceChanges(
        old,
        [{ path: "a.md", source: null, unavailable: true }],
        { complete: true, force: true },
      ).map((c) => c.action),
    ).toEqual(["preserve", "remove"]);
    expect(
      planSourceChanges(old, [{ path: "a.md", source: null }])[0]!.action,
    ).toBe("remove");
    expect(
      planSourceChanges(old, [{ path: "b.md", source: old[1]! }])[0]!.action,
    ).toBe("reuse");
  });
  it("resolves legacy normalized Markdown links without adding the source directory twice", () => {
    const rows = [
      {
        path: "Folder/Source.md",
        note_id: "source",
        title: "Source",
        aliases_json: "[]",
        links_json: JSON.stringify([
          {
            kind: "markdown",
            target: "Target",
            targetPath: "Folder/Target.md",
            heading: null,
            display: null,
            resolved: "target",
          },
        ]),
      },
      {
        path: "Folder/Target.md",
        note_id: "target",
        title: "Target",
        aliases_json: "[]",
        links_json: "[]",
      },
    ];
    const result = createIndexLinkResolver(rows)(rows[0]!);
    expect(JSON.parse(String(result.links_json))[0].resolved).toBe("target");
    expect(
      JSON.parse(
        String(createIndexLinkResolver([rows[0]!])(result).links_json),
      )[0].resolved,
    ).toBeNull();
  });
  it("reuses exact inputs, embeds title changes and invalidates changed model generations", async () => {
    const cache = new Map<string, Float32Array>();
    const embed = vi.fn(async (texts: string[]) => ({
      model: descriptor.model,
      dimension: 2,
      embeddings: texts.map(() => new Float32Array([1, 0])),
    }));
    const provider: EmbeddingProviderContract = {
      describe: () => descriptor,
      embed,
    };
    const options = {
      enabled: true,
      provider,
      cache: { get: async (key: string) => cache.get(key) ?? null },
    };
    const input = {
      chunkId: "source:0",
      contentHash: "same-body",
      text: "Title: First\nBody",
    };
    const initial = await prepareEmbeddingBatch(
      [input, { ...input, chunkId: "other:0" }],
      options,
    );
    expect(embed).toHaveBeenCalledWith([input.text]);
    for (const entry of initial) cache.set(entry.cacheKey, entry.values);
    const reused = await prepareEmbeddingBatch(
      [{ ...input, vectorKey: initial[0]!.cacheKey }],
      options,
    );
    expect(reused[0]!.generated).toBe(false);
    expect(reused[0]!.needsWrite).toBe(false);
    expect(embed).toHaveBeenCalledTimes(1);
    await prepareEmbeddingBatch(
      [{ ...input, text: "Title: Second\nBody" }],
      options,
    );
    await prepareEmbeddingBatch([input], {
      ...options,
      descriptor: { ...descriptor, modelRevision: "v2" },
    });
    expect(embed).toHaveBeenCalledTimes(3);
    expect(
      await prepareEmbeddingBatch([input], { ...options, enabled: false }),
    ).toEqual([]);
    expect(embed).toHaveBeenCalledTimes(3);
  });
  it("persists discovered dimensions in cache identity and rejects incompatible cached vectors", async () => {
    const cache = new Map<string, Float32Array>();
    const embed = vi.fn(async () => ({
      model: descriptor.model,
      dimension: 2,
      embeddings: [new Float32Array([1, 0])],
    }));
    const input = { chunkId: "a:0", contentHash: "a", text: "Synthetic body" };
    const provider = {
      describe: () => ({ ...descriptor, dimension: null }),
      embed,
    };
    const options = {
      enabled: true,
      provider,
      cache: { get: async (key: string) => cache.get(key) ?? null },
    };
    const [generated] = await prepareEmbeddingBatch([input], options);
    expect(generated!.cacheKey).toBe(
      await embeddingInputKey(descriptor, input.text),
    );
    cache.set(generated!.cacheKey, generated!.values);
    expect(
      (await prepareEmbeddingBatch([input], { ...options, descriptor }))[0]!
        .generated,
    ).toBe(false);
    cache.set(generated!.cacheKey, new Float32Array([1, 0, 0]));
    await prepareEmbeddingBatch([input], { ...options, descriptor });
    expect(embed).toHaveBeenCalledTimes(2);
  });
});

describe("local adapter uses shared updates for manual indexing and watcher events", () => {
  let root: string, dir: string, config: Config, store: IndexStore | undefined;
  let inputs: string[];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "shared-updates-vault-"));
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "shared-updates-db-"));
    config = structuredClone(DEFAULT_CONFIG);
    config.vault.root = root;
    config.index.dir = dir;
    config.embedding.enabled = true;
    config.embedding.model = "synthetic-model";
    inputs = [];
    vi.spyOn(EmbeddingProvider.prototype, "embed").mockImplementation(
      async (texts) => {
        inputs.push(...texts);
        return {
          model: "synthetic-model",
          dimension: 2,
          embeddings: texts.map(() => new Float32Array([1, 0])),
        };
      },
    );
  });
  afterEach(() => {
    store?.close();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  });
  async function open() {
    await indexVault(config);
    store = await IndexStore.open(getIndexPath(config));
    return store;
  }
  it("reads legacy SQLite indexes and adds update metadata without changing identifiers", async () => {
    config.embedding.enabled = false;
    fs.writeFileSync(path.join(root, "source.md"), "# Source\n[[Future]]\n");
    await open();
    const id = store!.getNoteByPath("source.md")!.note_id;
    store!.getDb().exec(`
      ALTER TABLE notes DROP COLUMN wikilinks_json;
      ALTER TABLE chunks DROP COLUMN embedding_key;
      DROP TABLE embedding_cache;
    `);
    store!.close();
    store = await IndexStore.openReadOnly(getIndexPath(config));
    expect(store.getNoteByPath("source.md")!.note_id).toBe(id);
    expect(store.getEmbeddingCache("absent")).toBeNull();
    store.close();
    store = await IndexStore.open(getIndexPath(config));
    await incrementalIndexUpdate(store, config, { paths: ["source.md"] });
    expect(store.getNoteByPath("source.md")!.note_id).toBe(id);
    expect(store.getNoteByPath("source.md")!.wikilinks_json).toContain(
      "Future",
    );
    expect(store.getChunkById(`${id}:0`)!.embedding_key).toBeNull();
  });
  it("rejects a prepared update if another writer published during asynchronous preparation", async () => {
    fs.writeFileSync(path.join(root, "source.md"), "# Source\nOriginal.\n");
    await open();
    const previous = store!.getNoteByPath("source.md")!;
    const replacementManifest = { ...store!.getManifest()!, indexedAt: 1 };
    fs.writeFileSync(path.join(root, "source.md"), "# Source\nChanged.\n");
    vi.mocked(EmbeddingProvider.prototype.embed).mockImplementation(
      async () => {
        store!.setManifest(replacementManifest);
        return {
          model: "synthetic-model",
          dimension: 2,
          embeddings: [new Float32Array([1, 0])],
        };
      },
    );
    await expect(
      incrementalIndexUpdate(store!, config, { paths: ["source.md"] }),
    ).rejects.toMatchObject({ code: "INDEX_BUSY" });
    expect(store!.getManifest()).toEqual(replacementManifest);
    expect(store!.getNoteByPath("source.md")!.content_hash).toBe(
      previous.content_hash,
    );
  });
  it("reuses vectors on manual reindex and metadata-only edits, but embeds a changed title", async () => {
    fs.writeFileSync(
      path.join(root, "source.md"),
      "---\ntitle: Orchard\ntags: [old]\n---\n# Trees\nSynthetic fruit.\n",
    );
    await open();
    expect(inputs).toHaveLength(1);
    await indexVault(config);
    expect(inputs).toHaveLength(1);
    store!.close();
    store = undefined;
    await reindexVault(config);
    expect(inputs).toHaveLength(1);
    store = await IndexStore.open(getIndexPath(config));
    fs.writeFileSync(
      path.join(root, "source.md"),
      "---\ntitle: Orchard\ntags: [new]\n---\n# Trees\nSynthetic fruit.\n",
    );
    await incrementalIndexUpdate(store, config, { paths: ["source.md"] });
    expect(inputs).toHaveLength(1);
    fs.writeFileSync(
      path.join(root, "source.md"),
      "---\ntitle: Seasons\ntags: [new]\n---\n# Trees\nSynthetic fruit.\n",
    );
    await incrementalIndexUpdate(store, config, { paths: ["source.md"] });
    expect(inputs).toHaveLength(2);
    expect(store.isEmbeddingReady()).toBe(true);
    store.getDb().exec("UPDATE embedding_cache SET values_json='[1]'");
    await incrementalIndexUpdate(store, config, { paths: ["source.md"] });
    expect(inputs).toHaveLength(3);
    await incrementalIndexUpdate(store, config, { paths: ["source.md"] });
    expect(inputs).toHaveLength(3);
    fs.unlinkSync(path.join(root, "source.md"));
    await incrementalIndexUpdate(store, config, { paths: ["source.md"] });
    expect(
      store.getDb().prepare("SELECT count(*) AS n FROM vec_chunks").get(),
    ).toEqual({ n: 0 });
  });
  it("detects equal-size/equal-mtime edits and refreshes links from unchanged sources", async () => {
    config.embedding.enabled = false;
    fs.writeFileSync(
      path.join(root, "source.md"),
      "# Source\n[[Future]] [relative](Future.md)\n",
    );
    fs.writeFileSync(path.join(root, "other.md"), "# Other\nold\n");
    await open();
    const previous = fs.statSync(path.join(root, "other.md"));
    fs.writeFileSync(path.join(root, "other.md"), "# Other\nnew\n");
    fs.utimesSync(path.join(root, "other.md"), previous.atime, previous.mtime);
    await incrementalIndexUpdate(store!, config, { paths: ["other.md"] });
    expect(store!.getNoteByPath("other.md")!.body_text).toContain("new");
    fs.writeFileSync(
      path.join(root, "Future.md"),
      "# Future\nSynthetic note.\n",
    );
    await incrementalIndexUpdate(store!, config, { paths: ["Future.md"] });
    const links = () =>
      JSON.parse(String(store!.getNoteByPath("source.md")!.links_json));
    expect(
      links().every(
        (l: { resolved: string | null }) =>
          l.resolved === noteIdFromPath("Future.md"),
      ),
    ).toBe(true);
    fs.unlinkSync(path.join(root, "Future.md"));
    await incrementalIndexUpdate(store!, config, { paths: ["Future.md"] });
    expect(
      links().every((l: { resolved: string | null }) => l.resolved === null),
    ).toBe(true);
  });
  it("prepares embeddings outside the write transaction and preserves the prior index on mandatory failure", async () => {
    fs.writeFileSync(
      path.join(root, "source.md"),
      "# Source\nOriginal body.\n",
    );
    await open();
    const previous = store!.getNoteByPath("source.md")!;
    const manifest = store!.getManifest();
    fs.writeFileSync(
      path.join(root, "source.md"),
      "# Source\nReplacement body.\n",
    );
    vi.mocked(EmbeddingProvider.prototype.embed).mockImplementation(
      async () => {
        expect(store!.getDb().inTransaction).toBe(false);
        expect(store!.getNoteByPath("source.md")!.content_hash).toBe(
          previous.content_hash,
        );
        throw new Error("synthetic provider failure");
      },
    );
    await expect(
      incrementalIndexUpdate(store!, config, {
        paths: ["source.md"],
        requireEmbeddings: true,
      }),
    ).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
    expect(store!.getManifest()).toEqual(manifest);
    expect(store!.getNoteByPath("source.md")!.content_hash).toBe(
      previous.content_hash,
    );
    await incrementalIndexUpdate(store!, config, { paths: ["source.md"] });
    expect(store!.isEmbeddingReady()).toBe(false);
    expect(
      (await search(store!, "Replacement", "lexical", 10, config)).results,
    ).toHaveLength(1);
    expect(
      store!.getDb().prepare("SELECT count(*) AS n FROM vec_chunks").get(),
    ).toEqual({ n: 0 });
  });
});

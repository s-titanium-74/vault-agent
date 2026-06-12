import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { IndexStore } from "../src/index-store.js";
import { search } from "../src/search.js";
import { getRelated } from "../src/related.js";
import { SearchError } from "../src/errors.js";
import { Config, DEFAULT_CONFIG } from "../src/config.js";
import { noteIdFromPath, vaultIdentity } from "../src/identifiers.js";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-search-"));

  fs.writeFileSync(path.join(vaultDir, "Alpha.md"), `---
title: "Alpha Note"
tags:
  - alpha
  - search
---

# Alpha Note

Alpha content about lexical search and indexing systems.`);

  fs.writeFileSync(path.join(vaultDir, "Beta.md"), `---
title: "Beta Note"
tags:
  - beta
  - retrieval
---

# Beta Note

Beta content about embedding retrieval and vector similarity.`);

  return vaultDir;
}

function createTestConfig(vaultRoot: string, indexDir: string): Config {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    vault: { root: vaultRoot, exclude: [] },
    server: { ...DEFAULT_CONFIG.server },
    index: { dir: indexDir },
    embedding: { ...DEFAULT_CONFIG.embedding },
    cors: { ...DEFAULT_CONFIG.cors },
  };
}

describe("search", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;

  beforeEach(() => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-idx-"));
    config = createTestConfig(vaultDir, indexDir);
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("throws INDEX_NOT_FOUND when no manifest exists", async () => {
    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(indexDir, vaultIdentity(resolvedVault), "index.sqlite");
    const store = await IndexStore.open(dbPath);

    try {
      await expect(search(store, "test query", "lexical", 10, config)).rejects
        .toMatchObject({
          code: "INDEX_NOT_FOUND",
        });
    } finally {
      store.close();
    }
  });

  it("returns empty results for whitespace-only query after indexing", async () => {
    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(indexDir, vaultIdentity(resolvedVault), "index.sqlite");
    const store = await IndexStore.open(dbPath);

    const manifest = {
      schemaVersion: 1,
      vaultIdentity: vaultIdentity(resolvedVault),
      indexedFileExtensions: [".md", ".markdown"],
      effectiveExcludePatterns: [".obsidian/", ".git/"],
      targetChunkSize: 2000,
      maxChunkSize: 4000,
      embeddingModel: null,
      embeddingDimension: null,
      noteCount: 2,
      chunkCount: 2,
      indexedAt: Date.now(),
    };
    store.setManifest(manifest);

    const { indexVault } = await import("../src/indexer.js");
    await indexVault(config);

    try {
      const result = await search(store, "   ", "lexical", 10, config);
      expect(result.results).toEqual([]);
    } finally {
      store.close();
    }
  });
});

describe("getRelated", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;

  beforeEach(() => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-idx-"));
    config = createTestConfig(vaultDir, indexDir);
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("throws INDEX_NOT_FOUND when no manifest exists", async () => {
    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(indexDir, vaultIdentity(resolvedVault), "index.sqlite");
    const store = await IndexStore.open(dbPath);

    try {
      await expect(getRelated(store, "note", "abcd1234abcd1234abcd1234abcd1234", "lexical", 10, config)).rejects
        .toMatchObject({
          code: "INDEX_NOT_FOUND",
        });
    } finally {
      store.close();
    }
  });

  it("throws INVALID_ID for invalid note ID", async () => {
    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(indexDir, vaultIdentity(resolvedVault), "index.sqlite");
    const store = await IndexStore.open(dbPath);

    const manifest = {
      schemaVersion: 1,
      vaultIdentity: vaultIdentity(resolvedVault),
      indexedFileExtensions: [".md", ".markdown"],
      effectiveExcludePatterns: [".obsidian/", ".git/"],
      targetChunkSize: 2000,
      maxChunkSize: 4000,
      embeddingModel: null,
      embeddingDimension: null,
      noteCount: 2,
      chunkCount: 2,
      indexedAt: Date.now(),
    };
    store.setManifest(manifest);

    try {
      await expect(getRelated(store, "note", "invalid-id", "lexical", 10, config)).rejects
        .toMatchObject({
          code: "INVALID_ID",
        });
    } finally {
      store.close();
    }
  });

  it("throws INVALID_ID for invalid chunk ID format", async () => {
    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(indexDir, vaultIdentity(resolvedVault), "index.sqlite");
    const store = await IndexStore.open(dbPath);

    const manifest = {
      schemaVersion: 1,
      vaultIdentity: vaultIdentity(resolvedVault),
      indexedFileExtensions: [".md", ".markdown"],
      effectiveExcludePatterns: [".obsidian/", ".git/"],
      targetChunkSize: 2000,
      maxChunkSize: 4000,
      embeddingModel: null,
      embeddingDimension: null,
      noteCount: 2,
      chunkCount: 2,
      indexedAt: Date.now(),
    };
    store.setManifest(manifest);

    try {
      await expect(getRelated(store, "chunk", "not-a-valid-chunk-id", "lexical", 10, config)).rejects
        .toMatchObject({
          code: "INVALID_ID",
        });
    } finally {
      store.close();
    }
  });

  it("handles chunk-type input for related notes", async () => {
    const { indexVault } = await import("../src/indexer.js");
    await indexVault(config);

    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(indexDir, vaultIdentity(resolvedVault), "index.sqlite");
    const store = await IndexStore.open(dbPath);

    try {
      const notes = store.getAllNotes();
      const noteId = notes[0]!.note_id as string;
      const chunkId = `${noteId}:0`;

      const result = await getRelated(store, "chunk", chunkId, "lexical", 10, config);
      expect(result.input.type).toBe("chunk");
      expect(result.input.id).toBe(chunkId);
    } finally {
      store.close();
    }
  });

  it("returns NOTE_NOT_FOUND for non-existent note ID", async () => {
    const { indexVault } = await import("../src/indexer.js");
    await indexVault(config);

    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(indexDir, vaultIdentity(resolvedVault), "index.sqlite");
    const store = await IndexStore.open(dbPath);

    try {
      await expect(getRelated(store, "note", "00000000000000000000000000000000", "lexical", 10, config)).rejects.toThrow(SearchError);
    } finally {
      store.close();
    }
  });
});

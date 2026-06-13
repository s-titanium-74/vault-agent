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
import { INDEX_SCHEMA_VERSION, MAX_SNIPPET_LENGTH } from "../src/schemas.js";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-search-"),
  );

  fs.writeFileSync(
    path.join(vaultDir, "Alpha.md"),
    `---
title: "Alpha Note"
tags:
  - alpha
  - search
---

# Alpha Note

Alpha content about lexical search and indexing systems.`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Beta.md"),
    `---
title: "Beta Note"
tags:
  - beta
  - retrieval
---

# Beta Note

Beta content about embedding retrieval and vector similarity.`,
  );

  return vaultDir;
}

function createSpecVault(): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-spec-"));

  fs.writeFileSync(
    path.join(vaultDir, "AliasTagged.md"),
    `---
title: "Alias Tagged Note"
aliases:
  - "RareAliasTerm"
tags:
  - "rare-tag"
---

# Alias Tagged Note

The body intentionally omits the searchable alias and tag values.`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Source.md"),
    `# Source

See [[Destination]] for linked context.`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Destination.md"),
    `---
title: "Remote Candidate"
---

# Remote Candidate

An orbiting subject with separate vocabulary.`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "ShortSecret.md"),
    `---
title: "Compact Result Target"
---

# Compact Result Target

DO_NOT_LEAK_FULL_BODY_IN_SEARCH.`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "LongSnippet.md"),
    `# Long Snippet Note

${"lexical ".repeat(80)}This body is long enough to produce a compact snippet without returning the full chunk.`,
  );

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
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    try {
      await expect(
        search(store, "test query", "lexical", 10, config),
      ).rejects.toMatchObject({
        code: "INDEX_NOT_FOUND",
      });
    } finally {
      store.close();
    }
  });

  it("returns empty results for whitespace-only query after indexing", async () => {
    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    const manifest = {
      schemaVersion: INDEX_SCHEMA_VERSION,
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

  it("indexes allowlisted frontmatter aliases and tags for lexical search", async () => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    vaultDir = createSpecVault();
    config = createTestConfig(vaultDir, indexDir);

    const { indexVault } = await import("../src/indexer.js");
    await indexVault(config);

    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    try {
      const aliasResult = await search(
        store,
        "RareAliasTerm",
        "lexical",
        10,
        config,
      );
      expect(aliasResult.results.some((r) => r.path === "AliasTagged.md")).toBe(
        true,
      );

      const tagResult = await search(store, "rare-tag", "lexical", 10, config);
      expect(tagResult.results.some((r) => r.path === "AliasTagged.md")).toBe(
        true,
      );
    } finally {
      store.close();
    }
  });

  it("keeps search results compact and omits full retrievable content", async () => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    vaultDir = createSpecVault();
    config = createTestConfig(vaultDir, indexDir);

    const { indexVault } = await import("../src/indexer.js");
    await indexVault(config);

    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    try {
      const shortResult = await search(
        store,
        "Compact Result Target",
        "lexical",
        10,
        config,
      );
      const shortItem = shortResult.results.find(
        (r) => r.path === "ShortSecret.md",
      );
      expect(shortItem).toBeDefined();
      expect(shortItem).not.toHaveProperty("content");
      expect(shortItem!.snippet).toBe("");
      expect(JSON.stringify(shortItem)).not.toContain(
        "DO_NOT_LEAK_FULL_BODY_IN_SEARCH",
      );

      const longResult = await search(store, "lexical", "lexical", 10, config);
      const longItem = longResult.results.find(
        (r) => r.path === "LongSnippet.md",
      );
      expect(longItem).toBeDefined();
      expect(longItem).not.toHaveProperty("content");
      expect(longItem!.snippet.length).toBeLessThanOrEqual(
        MAX_SNIPPET_LENGTH + 3,
      );

      const chunk = store.getChunkById(longItem!.id);
      expect(longItem!.snippet).not.toBe(chunk?.content);
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
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    try {
      await expect(
        getRelated(
          store,
          "note",
          "abcd1234abcd1234abcd1234abcd1234",
          "lexical",
          10,
          config,
        ),
      ).rejects.toMatchObject({
        code: "INDEX_NOT_FOUND",
      });
    } finally {
      store.close();
    }
  });

  it("throws INVALID_ID for invalid note ID", async () => {
    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    const manifest = {
      schemaVersion: INDEX_SCHEMA_VERSION,
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
      await expect(
        getRelated(store, "note", "invalid-id", "lexical", 10, config),
      ).rejects.toMatchObject({
        code: "INVALID_ID",
      });
    } finally {
      store.close();
    }
  });

  it("throws INVALID_ID for invalid chunk ID format", async () => {
    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    const manifest = {
      schemaVersion: INDEX_SCHEMA_VERSION,
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
      await expect(
        getRelated(
          store,
          "chunk",
          "not-a-valid-chunk-id",
          "lexical",
          10,
          config,
        ),
      ).rejects.toMatchObject({
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
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    try {
      const notes = store.getAllNotes();
      const noteId = notes[0]!.note_id as string;
      const chunkId = `${noteId}:0`;

      const result = await getRelated(
        store,
        "chunk",
        chunkId,
        "lexical",
        10,
        config,
      );
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
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    try {
      await expect(
        getRelated(
          store,
          "note",
          "00000000000000000000000000000000",
          "lexical",
          10,
          config,
        ),
      ).rejects.toThrow(SearchError);
    } finally {
      store.close();
    }
  });

  it("excludes the input note and can return resolved wikilink candidates", async () => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    vaultDir = createSpecVault();
    config = createTestConfig(vaultDir, indexDir);

    const { indexVault } = await import("../src/indexer.js");
    await indexVault(config);

    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    try {
      const sourceId = noteIdFromPath("Source.md");
      const destinationId = noteIdFromPath("Destination.md");

      const result = await getRelated(
        store,
        "note",
        sourceId,
        "lexical",
        10,
        config,
      );

      expect(result.results.every((r) => r.noteId !== sourceId)).toBe(true);
      expect(result.results.some((r) => r.noteId === destinationId)).toBe(true);
      expect(
        result.results.find((r) => r.noteId === destinationId)?.reason,
      ).toBe("related_link");
      expect(JSON.stringify(result.results)).not.toContain(
        "See [[Destination]]",
      );
      expect(JSON.stringify(result.results)).not.toContain(
        "An orbiting subject with separate vocabulary.",
      );
    } finally {
      store.close();
    }
  });

  it("keeps duplicate filename-stem wikilinks unresolved", async () => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    vaultDir = createSpecVault();
    fs.mkdirSync(path.join(vaultDir, "First"), { recursive: true });
    fs.mkdirSync(path.join(vaultDir, "Second"), { recursive: true });
    fs.writeFileSync(
      path.join(vaultDir, "First", "Duplicate.md"),
      "# First Candidate\n\nAlpha-only content.",
    );
    fs.writeFileSync(
      path.join(vaultDir, "Second", "Duplicate.md"),
      "# Second Candidate\n\nBeta-only content.",
    );
    fs.writeFileSync(
      path.join(vaultDir, "Ambiguous.md"),
      "# Ambiguous\n\nSee [[Duplicate]] for context.",
    );
    config = createTestConfig(vaultDir, indexDir);

    const { indexVault } = await import("../src/indexer.js");
    await indexVault(config);

    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    try {
      const ambiguousId = noteIdFromPath("Ambiguous.md");
      const ambiguous = store.getNote(ambiguousId);
      expect(ambiguous).not.toBeNull();

      const links = JSON.parse(ambiguous!.links_json as string) as Array<{
        target: string;
        resolved: string | null;
      }>;
      expect(links).toContainEqual(
        expect.objectContaining({ target: "Duplicate", resolved: null }),
      );

      const result = await getRelated(
        store,
        "note",
        ambiguousId,
        "lexical",
        10,
        config,
      );
      expect(
        result.results.some(
          (r) =>
            r.noteId === noteIdFromPath("First/Duplicate.md") ||
            r.noteId === noteIdFromPath("Second/Duplicate.md"),
        ),
      ).toBe(false);
    } finally {
      store.close();
    }
  });

  it("resolves incremental wikilinks against unchanged indexed notes", async () => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    vaultDir = createSpecVault();
    fs.writeFileSync(
      path.join(vaultDir, "IncrementalSource.md"),
      "# Incremental Source\n\nInitial content without a link.",
    );
    config = createTestConfig(vaultDir, indexDir);

    const { indexVault } = await import("../src/indexer.js");
    await indexVault(config);

    fs.writeFileSync(
      path.join(vaultDir, "IncrementalSource.md"),
      "# Incremental Source\n\nNow see [[Destination]] for linked context.",
    );
    const incremental = await indexVault(config);
    expect(incremental.notesSkipped).toBeGreaterThan(0);

    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    try {
      const sourceId = noteIdFromPath("IncrementalSource.md");
      const destinationId = noteIdFromPath("Destination.md");
      const source = store.getNote(sourceId);
      expect(source).not.toBeNull();

      const links = JSON.parse(source!.links_json as string) as Array<{
        target: string;
        resolved: string | null;
      }>;
      expect(links).toContainEqual(
        expect.objectContaining({
          target: "Destination",
          resolved: destinationId,
        }),
      );

      const result = await getRelated(
        store,
        "note",
        sourceId,
        "lexical",
        10,
        config,
      );
      expect(result.results.some((r) => r.noteId === destinationId)).toBe(true);
    } finally {
      store.close();
    }
  });

  it("resolves incremental wikilinks against unchanged H1-derived titles", async () => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    vaultDir = createSpecVault();
    fs.writeFileSync(
      path.join(vaultDir, "H1Target.md"),
      "# Project Roadmap\n\nTarget content with a heading-derived title.",
    );
    fs.writeFileSync(
      path.join(vaultDir, "H1Source.md"),
      "# H1 Source\n\nInitial content without a link.",
    );
    config = createTestConfig(vaultDir, indexDir);

    const { indexVault } = await import("../src/indexer.js");
    await indexVault(config);

    fs.writeFileSync(
      path.join(vaultDir, "H1Source.md"),
      "# H1 Source\n\nNow see [[Project Roadmap]] for linked context.",
    );
    const incremental = await indexVault(config);
    expect(incremental.notesSkipped).toBeGreaterThan(0);

    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    try {
      const sourceId = noteIdFromPath("H1Source.md");
      const targetId = noteIdFromPath("H1Target.md");
      const source = store.getNote(sourceId);
      expect(source).not.toBeNull();

      const links = JSON.parse(source!.links_json as string) as Array<{
        target: string;
        resolved: string | null;
      }>;
      expect(links).toContainEqual(
        expect.objectContaining({
          target: "Project Roadmap",
          resolved: targetId,
        }),
      );
    } finally {
      store.close();
    }
  });

  it("keeps wikilinks unresolved when stem and title matches disagree", async () => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    vaultDir = createSpecVault();
    fs.writeFileSync(
      path.join(vaultDir, "Roadmap.md"),
      "# File Stem Candidate\n\nStem-only candidate.",
    );
    fs.writeFileSync(
      path.join(vaultDir, "Titled.md"),
      `---
title: "Roadmap"
---

# Different Title Candidate

Title-only candidate.`,
    );
    fs.writeFileSync(
      path.join(vaultDir, "CrossSource.md"),
      "# Cross Source\n\nSee [[Roadmap]] for context.",
    );
    config = createTestConfig(vaultDir, indexDir);

    const { indexVault } = await import("../src/indexer.js");
    await indexVault(config);

    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(
      indexDir,
      vaultIdentity(resolvedVault),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    try {
      const sourceId = noteIdFromPath("CrossSource.md");
      const source = store.getNote(sourceId);
      expect(source).not.toBeNull();

      const links = JSON.parse(source!.links_json as string) as Array<{
        target: string;
        resolved: string | null;
      }>;
      expect(links).toContainEqual(
        expect.objectContaining({ target: "Roadmap", resolved: null }),
      );

      const result = await getRelated(
        store,
        "note",
        sourceId,
        "lexical",
        10,
        config,
      );
      expect(
        result.results.some(
          (r) =>
            r.noteId === noteIdFromPath("Roadmap.md") ||
            r.noteId === noteIdFromPath("Titled.md"),
        ),
      ).toBe(false);
    } finally {
      store.close();
    }
  });
});

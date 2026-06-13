import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { IndexStore } from "../src/index-store.js";
import { indexVault, reindexVault } from "../src/indexer.js";
import { Config } from "../src/config.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { noteIdFromPath, vaultIdentity } from "../src/identifiers.js";
import { parseMarkdown } from "../src/markdown.js";
import { chunkNote } from "../src/chunking.js";
import { VaultDiscovery } from "../src/discovery.js";
import { search } from "../src/search.js";
import { getRelated } from "../src/related.js";
import { getNote, getChunk, getAttachmentMetadata } from "../src/retrieval.js";
import { INDEX_SCHEMA_VERSION } from "../src/schemas.js";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-vault-"));

  fs.writeFileSync(path.join(vaultDir, "Welcome.md"), `---
title: "Welcome Note"
aliases:
  - "Home"
tags:
  - demo
  - welcome
date: "2025-01-01"
---

# Welcome Note

This is a demonstration vault for vault-agent search and retrieval testing.

## Overview

Vault-agent provides lexical search, embedding search, hybrid search, and related note discovery for Markdown vaults.

## Getting Started

Configure your vault root and start the server. Then use search and get commands.`);

  fs.mkdirSync(path.join(vaultDir, "Architecture"), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, "Architecture", "Search.md"), `---
title: "Search Architecture"
aliases:
  - "Search System"
tags:
  - architecture
  - search
created: "2025-02-01"
updated: "2025-03-10"
---

# Search Architecture

The search system uses a layered approach combining lexical and semantic signals.

## Lexical Search

Lexical search uses SQLite FTS5 with the unicode61 tokenizer. A supplemental trigram index improves matching for non-whitespace languages.

## Hybrid Search

Hybrid search combines lexical and embedding results using Reciprocal Rank Fusion.`);

  fs.writeFileSync(path.join(vaultDir, "Configuration.md"), `# Configuration Guide

Vault-agent uses TOML configuration files stored in user-local directories.

## Server Settings

Default server endpoint is http://127.0.0.1:8787. The server binds to localhost by default.

## Embedding Settings

Embeddings are disabled by default. Enable by setting embedding.enabled to true and configuring a local endpoint.`);

  fs.writeFileSync(path.join(vaultDir, "Privacy.md"), `# Privacy and Security

Vault-agent is designed with local-first and private-by-default principles.

## Localhost Default

The server binds to 127.0.0.1 by default. Remote access requires explicit configuration and API key authentication.

## Data Minimization

Search results return only metadata and short snippets. Full note retrieval requires explicit requests.`);

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

describe("IndexStore", () => {
  let storeDir: string;
  let store: IndexStore;

  beforeEach(() => {
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-index-"));
  });

  afterEach(() => {
    try { store?.close(); } catch {}
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  it("opens and creates a new index database", async () => {
    const dbPath = path.join(storeDir, "index.sqlite");
    store = await IndexStore.open(dbPath);
    expect(store).toBeDefined();

    const manifest = store.getManifest();
    expect(manifest).toBeNull();
  });

  it("sets and reads manifest", async () => {
    const dbPath = path.join(storeDir, "index.sqlite");
    store = await IndexStore.open(dbPath);

    const manifest = {
      schemaVersion: INDEX_SCHEMA_VERSION,
      vaultIdentity: vaultIdentity("/test/vault"),
      indexedFileExtensions: [".md", ".markdown"],
      effectiveExcludePatterns: [".git/", ".obsidian/"],
      targetChunkSize: 2000,
      maxChunkSize: 4000,
      embeddingModel: null,
      embeddingDimension: null,
      noteCount: 10,
      chunkCount: 20,
      indexedAt: Date.now(),
    };

    store.setManifest(manifest);
    const read = store.getManifest();
    expect(read).not.toBeNull();
    expect(read!.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(read!.vaultIdentity).toBe(manifest.vaultIdentity);
    expect(read!.noteCount).toBe(10);
    expect(read!.chunkCount).toBe(20);
  });
});

describe("Indexing and Search Integration", () => {
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

  it("indexes a vault and creates manifest", async () => {
    const result = await indexVault(config);
    expect(result.mode).toBe("incremental");
    expect(result.notesIndexed).toBeGreaterThan(0);
    expect(result.chunksIndexed).toBeGreaterThan(0);
  });

  it("reindexes a vault", async () => {
    await indexVault(config);
    const result = await reindexVault(config);
    expect(result.mode).toBe("full");
    expect(result.notesIndexed).toBeGreaterThan(0);
  });

  it("keeps manifest counts for unchanged notes after incremental indexing", async () => {
    await indexVault(config);
    const second = await indexVault(config);
    expect(second.notesSkipped).toBeGreaterThan(0);

    const dbPath = path.join(
      indexDir,
      vaultIdentity(path.resolve(vaultDir)),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    try {
      const manifest = store.getManifest();
      expect(manifest?.noteCount).toBe(store.getAllNotes().length);
      expect(manifest?.chunkCount).toBe(store.getAllChunkIds().length);
    } finally {
      store.close();
    }
  });

  it("rewrites unchanged chunks when an older schema index is explicitly indexed", async () => {
    fs.writeFileSync(
      path.join(vaultDir, "LegacySource.md"),
      "# Legacy Source\n\nSee [[Welcome Note]] for linked context.",
    );
    await indexVault(config);

    const dbPath = path.join(
      indexDir,
      vaultIdentity(path.resolve(vaultDir)),
      "index.sqlite",
    );
    let store = await IndexStore.open(dbPath);

    try {
      const note = store.getNoteByPath("Welcome.md");
      expect(note).not.toBeNull();
      const noteId = note!.note_id as string;
      const chunk = store.getChunk(noteId, 0);
      expect(chunk).not.toBeNull();

      store
        .getDb()
        .prepare("UPDATE chunks SET lexical_text = ? WHERE chunk_id = ?")
        .run("This text simulates an older lexical source.", chunk!.chunk_id);

      const oldManifest = store.getManifest()!;
      store.setManifest({ ...oldManifest, schemaVersion: 1 });
    } finally {
      store.close();
    }

    const result = await indexVault(config);
    expect(result.notesSkipped).toBe(0);

    store = await IndexStore.open(dbPath);
    try {
      const manifest = store.getManifest();
      expect(manifest?.schemaVersion).toBe(INDEX_SCHEMA_VERSION);

      const legacySource = store.getNote(noteIdFromPath("LegacySource.md"));
      expect(legacySource).not.toBeNull();
      const links = JSON.parse(legacySource!.links_json as string) as Array<{
        target: string;
        resolved: string | null;
      }>;
      expect(links).toContainEqual(
        expect.objectContaining({
          target: "Welcome Note",
          resolved: noteIdFromPath("Welcome.md"),
        }),
      );

      const searchResult = await search(store, "Home", "lexical", 10, config);
      expect(searchResult.results.some((r) => r.path === "Welcome.md")).toBe(
        true,
      );
    } finally {
      store.close();
    }
  });

  it("skips invalid UTF-8 Markdown files with a FILE_NOT_UTF8 warning", async () => {
    fs.writeFileSync(
      path.join(vaultDir, "InvalidUtf8.md"),
      Buffer.from([0xff, 0xfe, 0xfd]),
    );

    const result = await indexVault(config);
    expect(result.warnings.some((w) => w.code === "FILE_NOT_UTF8")).toBe(true);

    const dbPath = path.join(
      indexDir,
      vaultIdentity(path.resolve(vaultDir)),
      "index.sqlite",
    );
    const store = await IndexStore.open(dbPath);

    try {
      expect(store.getNoteByPath("InvalidUtf8.md")).toBeNull();
    } finally {
      store.close();
    }
  });

  it("performs lexical search", async () => {
    await indexVault(config);

    const dbPath = path.join(indexDir, vaultIdentity(path.resolve(vaultDir)), "index.sqlite");
    const store = await IndexStore.open(dbPath);

    try {
      const result = await search(store, "search architecture", "lexical", 10, config);
      expect(result.requestedMode).toBe("lexical");
      expect(result.usedMode).toBe("lexical");
      expect(result.results.length).toBeGreaterThan(0);
    } finally {
      store.close();
    }
  });

  it("performs default search", async () => {
    await indexVault(config);

    const dbPath = path.join(indexDir, vaultIdentity(path.resolve(vaultDir)), "index.sqlite");
    const store = await IndexStore.open(dbPath);

    try {
      const result = await search(store, "configuration", undefined, 10, config);
      expect(result.usedMode).toBe("lexical");
      expect(result.results.length).toBeGreaterThan(0);

      const hasConfigResult = result.results.some((r) => r.path.includes("Configuration"));
      expect(hasConfigResult).toBe(true);
    } finally {
      store.close();
    }
  });

  it("returns snippet in search results", async () => {
    await indexVault(config);

    const dbPath = path.join(indexDir, vaultIdentity(path.resolve(vaultDir)), "index.sqlite");
    const store = await IndexStore.open(dbPath);

    try {
      const result = await search(store, "lexical", "lexical", 10, config);
      for (const r of result.results) {
        expect(r).toHaveProperty("id");
        expect(r).toHaveProperty("noteId");
        expect(r).toHaveProperty("path");
        expect(r).toHaveProperty("score");
        expect(r).toHaveProperty("reason");
        expect(r).toHaveProperty("metadata");
        expect(r.metadata).toHaveProperty("aliases");
        expect(r.metadata).toHaveProperty("tags");
      }
    } finally {
      store.close();
    }
  });

  it("finds related notes", async () => {
    await indexVault(config);

    const dbPath = path.join(indexDir, vaultIdentity(path.resolve(vaultDir)), "index.sqlite");
    const store = await IndexStore.open(dbPath);

    try {
      const notes = store.getAllNotes();
      expect(notes.length).toBeGreaterThan(0);

      const noteId = notes[0]!.note_id as string;
      const result = await getRelated(store, "note", noteId, "lexical", 5, config);
      expect(result.input.type).toBe("note");
      expect(result.input.id).toBe(noteId);
      expect(result.usedMode).toBe("lexical");
    } finally {
      store.close();
    }
  });

  it("retrieves a note by ID", async () => {
    await indexVault(config);

    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(indexDir, vaultIdentity(resolvedVault), "index.sqlite");
    const store = await IndexStore.open(dbPath);

    try {
      const notes = store.getAllNotes();
      const noteId = notes[0]!.note_id as string;

      const result = getNote(store, noteId, vaultDir);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(noteId);
      expect(result!.path).toBeTruthy();
      expect(result!.content.length).toBeGreaterThan(0);
      expect(result!.contentType).toBe("text/markdown; charset=utf-8");
    } finally {
      store.close();
    }
  });

  it("retrieves a chunk by note ID and index", async () => {
    await indexVault(config);

    const resolvedVault = path.resolve(vaultDir);
    const dbPath = path.join(indexDir, vaultIdentity(resolvedVault), "index.sqlite");
    const store = await IndexStore.open(dbPath);

    try {
      const notes = store.getAllNotes();
      const noteId = notes[0]!.note_id as string;

      const result = getChunk(store, noteId, 0);
      if (result) {
        expect(result.noteId).toBe(noteId);
        expect(result.chunkIndex).toBe(0);
        expect(result.contentType).toBe("text/markdown; charset=utf-8");
      }
    } finally {
      store.close();
    }
  });
});

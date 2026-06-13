import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { IndexStore } from "../src/index-store.js";
import { getNote, getChunk, getAttachmentMetadata, getAttachmentBytes } from "../src/retrieval.js";
import { RetrievalSizeError } from "../src/errors.js";
import { InvalidPathError } from "../src/retrieval.js";
import { PathSafetyError } from "../src/pathsafety.js";
import { DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT, DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT, INDEX_SCHEMA_VERSION } from "../src/schemas.js";
import { Config, DEFAULT_CONFIG } from "../src/config.js";
import { noteIdFromPath, vaultIdentity } from "../src/identifiers.js";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-retrieval-"));

  fs.writeFileSync(path.join(vaultDir, "SmallNote.md"), `---
title: "Small Note"
aliases:
  - "Tiny"
tags:
  - test
date: "2025-01-15"
created: "2025-01-15T10:00:00Z"
updated: "2025-01-16T12:00:00Z"
---

# Small Note

This is a small test note for retrieval testing.`);

  fs.mkdirSync(path.join(vaultDir, "attachments"), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, "attachments", "data.csv"), "id,name\n1,alice\n2,bob");

  return vaultDir;
}

function createLargeNote(vaultDir: string): string {
  const largeContent = "---\ntitle: \"Large Note\"\n---\n\n" + "x".repeat(DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT + 1000);
  fs.writeFileSync(path.join(vaultDir, "LargeNote.md"), largeContent);
  return "LargeNote.md";
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

async function setupStore(vaultDir: string, indexDir: string): Promise<IndexStore> {
  const resolvedVault = path.resolve(vaultDir);
  const dbPath = path.join(indexDir, vaultIdentity(resolvedVault), "index.sqlite");
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
    noteCount: 1,
    chunkCount: 1,
    indexedAt: Date.now(),
  };
  store.setManifest(manifest);

  const smallId = noteIdFromPath("SmallNote.md");
  store.upsertNote({
    noteId: smallId,
    vaultRelativePath: "SmallNote.md",
    title: "Small Note",
    filePath: path.join(vaultDir, "SmallNote.md"),
    frontmatter: { title: "Small Note", aliases: ["Tiny"], tags: ["test"], date: "2025-01-15", created: "2025-01-15T10:00:00Z", updated: "2025-01-16T12:00:00Z" },
    frontmatterDegraded: false,
    size: 100,
    contentHash: "abc123",
    mtimeMs: Date.now(),
    chunks: [{
      noteId: smallId,
      chunkIndex: 0,
      vaultRelativePath: "SmallNote.md",
      title: "Small Note",
      heading: null,
      headingPath: [],
      content: "This is a small test note for retrieval testing.",
      contentHash: "def456",
      charStart: 0,
      charEnd: 50,
    }],
    links: [],
    attachmentReferences: ["attachments/data.csv"],
  });

  return store;
}

describe("getNote", () => {
  let vaultDir: string;
  let indexDir: string;
  let store: IndexStore;
  let config: Config;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-idx-"));
    config = createTestConfig(vaultDir, indexDir);
    store = await setupStore(vaultDir, indexDir);
  });

  afterEach(() => {
    try { store?.close(); } catch {}
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("returns null for invalid noteId", () => {
    const result = getNote(store, "invalid-id", vaultDir);
    expect(result).toBeNull();
  });

  it("returns null for non-existent noteId", () => {
    const result = getNote(store, "aaaa0000bbbb1111cccc2222dddd3333", vaultDir);
    expect(result).toBeNull();
  });

  it("retrieves a note by valid ID", () => {
    const smallId = noteIdFromPath("SmallNote.md");
    const result = getNote(store, smallId, vaultDir);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(smallId);
    expect(result!.path).toBe("SmallNote.md");
    expect(result!.title).toBe("Small Note");
    expect(result!.contentType).toBe("text/markdown; charset=utf-8");
    expect(result!.content).toContain("small test note");
  });

  it("throws RetrievalSizeError for oversized note", () => {
    createLargeNote(vaultDir);
    const largeId = noteIdFromPath("LargeNote.md");
    store.upsertNote({
      noteId: largeId,
      vaultRelativePath: "LargeNote.md",
      title: "Large Note",
      filePath: path.join(vaultDir, "LargeNote.md"),
      frontmatter: { title: "Large Note" },
      frontmatterDegraded: false,
      size: DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT + 1000,
      contentHash: "largehash",
      mtimeMs: Date.now(),
      chunks: [],
      links: [],
      attachmentReferences: [],
    });

    expect(() => getNote(store, largeId, vaultDir)).toThrow(RetrievalSizeError);
  });

  it("returns oversized note content when allowLarge is true", () => {
    createLargeNote(vaultDir);
    const largeId = noteIdFromPath("LargeNote.md");
    store.upsertNote({
      noteId: largeId,
      vaultRelativePath: "LargeNote.md",
      title: "Large Note",
      filePath: path.join(vaultDir, "LargeNote.md"),
      frontmatter: { title: "Large Note" },
      frontmatterDegraded: false,
      size: DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT + 1000,
      contentHash: "largehash",
      mtimeMs: Date.now(),
      chunks: [],
      links: [],
      attachmentReferences: [],
    });

    const result = getNote(store, largeId, vaultDir, true);
    expect(result).not.toBeNull();
    expect(result!.size).toBeGreaterThan(DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT);
  });

  it("includes metadata fields in retrieved note", () => {
    const smallId = noteIdFromPath("SmallNote.md");
    const result = getNote(store, smallId, vaultDir);
    expect(result!.metadata.aliases).toEqual(["Tiny"]);
    expect(result!.metadata.tags).toEqual(["test"]);
    expect(result!.metadata.date).toBe("2025-01-15");
    expect(result!.metadata.created).toBe("2025-01-15T10:00:00Z");
    expect(result!.metadata.updated).toBe("2025-01-16T12:00:00Z");
    expect(result!.metadata.attachmentCount).toBe(1);
  });

  it("includes links and attachment references", () => {
    const smallId = noteIdFromPath("SmallNote.md");
    const result = getNote(store, smallId, vaultDir);
    expect(result!.attachments).toEqual(["attachments/data.csv"]);
  });
});

describe("getChunk", () => {
  let vaultDir: string;
  let indexDir: string;
  let store: IndexStore;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-idx-"));
    store = await setupStore(vaultDir, indexDir);
  });

  afterEach(() => {
    try { store?.close(); } catch {}
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("returns null for invalid noteId", () => {
    const result = getChunk(store, "invalid-id", 0);
    expect(result).toBeNull();
  });

  it("returns null for non-existent noteId", () => {
    const result = getChunk(store, "aaaa0000bbbb1111cccc2222dddd3333", 0);
    expect(result).toBeNull();
  });

  it("returns null for non-existent chunk index", () => {
    const smallId = noteIdFromPath("SmallNote.md");
    const result = getChunk(store, smallId, 99);
    expect(result).toBeNull();
  });

  it("retrieves a chunk by valid note ID and index", () => {
    const smallId = noteIdFromPath("SmallNote.md");
    const result = getChunk(store, smallId, 0);
    expect(result).not.toBeNull();
    expect(result!.noteId).toBe(smallId);
    expect(result!.chunkIndex).toBe(0);
    expect(result!.contentType).toBe("text/markdown; charset=utf-8");
    expect(result!.id).toBe(`${smallId}:0`);
  });
});

describe("getAttachmentMetadata", () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = createTestVault();
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it("returns metadata for a valid CSV attachment", () => {
    const result = getAttachmentMetadata(vaultDir, "attachments/data.csv");
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe("data.csv");
    expect(result!.contentType).toBe("text/csv");
    expect(result!.downloadAvailable).toBe(true);
  });

  it("returns null for Markdown file path", () => {
    const result = getAttachmentMetadata(vaultDir, "SmallNote.md");
    expect(result).toBeNull();
  });

  it("returns null for .markdown extension", () => {
    fs.writeFileSync(path.join(vaultDir, "Test.markdown"), "# Test");
    const result = getAttachmentMetadata(vaultDir, "Test.markdown");
    expect(result).toBeNull();
  });

  it("throws PathSafetyError for path traversal with ../", () => {
    expect(() => getAttachmentMetadata(vaultDir, "../etc/passwd")).toThrow(PathSafetyError);
  });

  it("returns null for non-existent path", () => {
    const result = getAttachmentMetadata(vaultDir, "attachments/nonexistent.pdf");
    expect(result).toBeNull();
  });

  it("throws InvalidPathError for directory path", () => {
    expect(() => getAttachmentMetadata(vaultDir, "attachments")).toThrow(InvalidPathError);
  });

  it("returns metadata for PNG image", () => {
    fs.writeFileSync(path.join(vaultDir, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const result = getAttachmentMetadata(vaultDir, "photo.png");
    expect(result).not.toBeNull();
    expect(result!.contentType).toBe("image/png");
    expect(result!.fileName).toBe("photo.png");
  });

  it("returns null for hidden file (dot-prefixed)", () => {
    fs.writeFileSync(path.join(vaultDir, ".hidden.dat"), "secret");
    const result = getAttachmentMetadata(vaultDir, ".hidden.dat");
    expect(result).toBeNull();
  });

  it("returns null for file inside hidden directory", () => {
    fs.mkdirSync(path.join(vaultDir, ".obsidian"), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, ".obsidian", "config.json"), "{}");
    const result = getAttachmentMetadata(vaultDir, ".obsidian/config.json");
    expect(result).toBeNull();
  });
});

describe("getAttachmentBytes", () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = createTestVault();
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it("returns bytes for a valid CSV attachment", () => {
    const result = getAttachmentBytes(vaultDir, "attachments/data.csv");
    expect(result).not.toBeNull();
    expect(result!.fileName).toBe("data.csv");
    expect(result!.contentType).toBe("text/csv");
    expect(result!.bytes.length).toBeGreaterThan(0);
  });

  it("throws PathSafetyError for path traversal with ../", () => {
    expect(() => getAttachmentBytes(vaultDir, "../etc/passwd")).toThrow(PathSafetyError);
  });

  it("returns null for Markdown file path", () => {
    const result = getAttachmentBytes(vaultDir, "SmallNote.md");
    expect(result).toBeNull();
  });

  it("throws RetrievalSizeError for oversized attachment (size limit exceeded)", () => {
    const largeBuffer = Buffer.alloc(DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT + 1000, "A");
    fs.writeFileSync(path.join(vaultDir, "huge.zip"), largeBuffer);

    expect(() => getAttachmentBytes(vaultDir, "huge.zip")).toThrow(RetrievalSizeError);
  });

  it("returns oversized attachment when allowLarge is true", () => {
    const largeBuffer = Buffer.alloc(DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT + 1000, "A");
    fs.writeFileSync(path.join(vaultDir, "huge.zip"), largeBuffer);

    const result = getAttachmentBytes(vaultDir, "huge.zip", true);
    expect(result).not.toBeNull();
    expect(result!.bytes.length).toBeGreaterThan(DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT);
  });

  it("returns null for hidden file", () => {
    fs.writeFileSync(path.join(vaultDir, ".secret.txt"), "secret data");
    const result = getAttachmentBytes(vaultDir, ".secret.txt");
    expect(result).toBeNull();
  });

  it("returns null for non-existent file", () => {
    const result = getAttachmentBytes(vaultDir, "attachments/missing.pdf");
    expect(result).toBeNull();
  });
});

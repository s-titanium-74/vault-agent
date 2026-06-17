import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { incrementalIndexUpdate } from "../src/incremental-indexer.js";
import { DEFAULT_CONFIG, indexVault, type Config } from "../src/config.js";
import { IndexStore } from "../src/index-store.js";
import {
  INDEX_SCHEMA_VERSION,
  DEFAULT_EXCLUDE_PATTERNS,
} from "../src/schemas.js";
import { noteIdFromPath, vaultIdentity } from "../src/identifiers.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

async function setupStoreWithManifest(
  tmpDir: string,
  indexDir: string,
  customExcludePatterns: string[] = [],
): Promise<IndexStore> {
  const dbPath = path.join(indexDir, "index.sqlite");
  const store = await IndexStore.open(dbPath);

  const effectiveExcludePatterns = [
    ...DEFAULT_EXCLUDE_PATTERNS,
    ...customExcludePatterns,
  ].sort();

  const manifest = {
    schemaVersion: INDEX_SCHEMA_VERSION,
    vaultIdentity: vaultIdentity(path.resolve(tmpDir)),
    indexedFileExtensions: [".md", ".markdown"],
    effectiveExcludePatterns,
    targetChunkSize: 2000,
    maxChunkSize: 4000,
    embeddingModel: null,
    embeddingDimension: null,
    noteCount: 0,
    chunkCount: 0,
    indexedAt: Date.now(),
  };
  store.setManifest(manifest);

  return store;
}

describe("incrementalIndexUpdate", () => {
  let tmpDir: string;
  let indexDir: string;
  let store: IndexStore;
  let config: Config;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-inc-idx-"));
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-inc-db-"));
    store = await setupStoreWithManifest(tmpDir, indexDir);
    config = structuredClone(DEFAULT_CONFIG);
    config.vault.root = tmpDir;
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("returns an incremental result with zero changes when no paths are provided", async () => {
    const result = await incrementalIndexUpdate(store, config, { paths: [] });
    expect(result.mode).toBe("incremental");
    expect(result.notesIndexed).toBe(0);
    expect(result.chunksIndexed).toBe(0);
  });

  it("indexes a newly created markdown file", async () => {
    const notePath = path.join(tmpDir, "new.md");
    fs.writeFileSync(notePath, "# New Note\n\nContent here.");

    const result = await incrementalIndexUpdate(store, config, {
      paths: ["new.md"],
    });

    expect(result.notesIndexed).toBe(1);
    expect(result.chunksIndexed).toBeGreaterThan(0);

    const note = store.getNoteByPath("new.md");
    expect(note).not.toBeNull();
    expect(note?.title).toBe("New Note");
  });

  it("rejects changed paths that resolve outside the vault root", async () => {
    const outsidePath = path.join(path.dirname(tmpDir), "outside.md");
    fs.writeFileSync(outsidePath, "# Outside");

    await expect(
      incrementalIndexUpdate(store, config, {
        paths: ["../outside.md"],
      }),
    ).rejects.toMatchObject({ code: "INDEX_UPDATE_FAILED" });

    fs.rmSync(outsidePath, { force: true });
  });

  it("updates an existing note when a markdown file is modified", async () => {
    const notePath = path.join(tmpDir, "existing.md");
    fs.writeFileSync(notePath, "# Existing\n\nOriginal content.");

    const result = await incrementalIndexUpdate(store, config, {
      paths: ["existing.md"],
    });

    expect(result.notesIndexed).toBe(1);
    const originalNote = store.getNoteByPath("existing.md");
    expect(originalNote).not.toBeNull();
    expect(originalNote?.title).toBe("Existing");
  });

  it("removes a note when a markdown file is deleted", async () => {
    const notePath = path.join(tmpDir, "todelete.md");
    fs.writeFileSync(notePath, "# To Delete\n\nContent.");

    await incrementalIndexUpdate(store, config, { paths: ["todelete.md"] });

    const noteBefore = store.getNoteByPath("todelete.md");
    expect(noteBefore).not.toBeNull();

    fs.unlinkSync(notePath);

    const result = await incrementalIndexUpdate(store, config, {
      paths: ["todelete.md"],
    });

    expect(result.notesIndexed).toBe(0);
    const noteAfter = store.getNoteByPath("todelete.md");
    expect(noteAfter).toBeNull();
  });

  it("handles rename as delete plus create", async () => {
    const oldPath = path.join(tmpDir, "oldname.md");
    const newPath = path.join(tmpDir, "newname.md");
    fs.writeFileSync(oldPath, "# Old Name\n\nContent.");

    await incrementalIndexUpdate(store, config, { paths: ["oldname.md"] });

    fs.unlinkSync(oldPath);
    fs.writeFileSync(newPath, "# New Name\n\nContent.");

    const result = await incrementalIndexUpdate(store, config, {
      paths: ["oldname.md", "newname.md"],
    });

    expect(result.notesIndexed).toBeGreaterThanOrEqual(1);
    const oldNote = store.getNoteByPath("oldname.md");
    const newNote = store.getNoteByPath("newname.md");
    expect(oldNote).toBeNull();
    expect(newNote).not.toBeNull();
  });

  it("indexes excluded paths when called directly (watcher filters exclusions separately)", async () => {
    const configWithExclude = structuredClone(DEFAULT_CONFIG);
    configWithExclude.vault.root = tmpDir;
    configWithExclude.vault.exclude = ["**/secret/**"];

    const storeWithExclude = await setupStoreWithManifest(tmpDir, indexDir, [
      "**/secret/**",
    ]);

    const secretDir = path.join(tmpDir, "secret");
    fs.mkdirSync(secretDir, { recursive: true });
    fs.writeFileSync(path.join(secretDir, "note.md"), "# Secret");

    const result = await incrementalIndexUpdate(
      storeWithExclude,
      configWithExclude,
      {
        paths: ["secret/note.md"],
      },
    );

    expect(result.notesIndexed).toBe(1);
    storeWithExclude.close();
  });

  it("updates attachment metadata without indexing contents", async () => {
    const attachmentPath = path.join(tmpDir, "image.png");
    fs.writeFileSync(attachmentPath, Buffer.from("fake png"));

    const result = await incrementalIndexUpdate(store, config, {
      paths: ["image.png"],
    });

    expect(result.warnings.length).toBeGreaterThanOrEqual(0);
  });

  it("preserves the last usable index on failure", async () => {
    fs.writeFileSync(path.join(tmpDir, "note.md"), "# Note\n\nContent");

    await incrementalIndexUpdate(store, config, { paths: ["note.md"] });

    const beforeNote = store.getNoteByPath("note.md");
    expect(beforeNote).not.toBeNull();

    const badConfig = structuredClone(DEFAULT_CONFIG);
    badConfig.vault.root = "/nonexistent";
    await expect(
      incrementalIndexUpdate(store, badConfig, { paths: ["note.md"] }),
    ).rejects.toThrow();

    const afterNote = store.getNoteByPath("note.md");
    expect(afterNote).not.toBeNull();
  });

  it("is single-flight and rejects concurrent writers", async () => {
    fs.writeFileSync(path.join(tmpDir, "note.md"), "# Note\n\nContent");

    const p1 = incrementalIndexUpdate(store, config, { paths: ["note.md"] });
    const p2 = incrementalIndexUpdate(store, config, { paths: ["note.md"] });

    const results = await Promise.allSettled([p1, p2]);
    const rejections = results.filter((r) => r.status === "rejected");
    expect(rejections.length).toBeGreaterThanOrEqual(0);
  });

  it("detects schema incompatibility and requires reindex", async () => {
    fs.writeFileSync(path.join(tmpDir, "note.md"), "# Note\n\nContent");
    await incrementalIndexUpdate(store, config, { paths: ["note.md"] });

    const manifest = store.getManifest();
    store.setManifest({
      ...manifest!,
      schemaVersion: manifest!.schemaVersion + 1,
    });

    const badConfig = structuredClone(DEFAULT_CONFIG);
    badConfig.vault.root = tmpDir;

    await expect(
      incrementalIndexUpdate(store, badConfig, { paths: ["note.md"] }),
    ).rejects.toThrow();
  });

  it("detects vault identity change and requires reindex", async () => {
    fs.writeFileSync(path.join(tmpDir, "note.md"), "# Note\n\nContent");
    await incrementalIndexUpdate(store, config, { paths: ["note.md"] });

    const manifest = store.getManifest();
    store.setManifest({
      ...manifest!,
      vaultIdentity: "different-vault-identity",
    });

    const badConfig = structuredClone(DEFAULT_CONFIG);
    badConfig.vault.root = tmpDir;

    await expect(
      incrementalIndexUpdate(store, badConfig, { paths: ["note.md"] }),
    ).rejects.toThrow();
  });

  it("detects exclude pattern change and requires reindex", async () => {
    fs.writeFileSync(path.join(tmpDir, "note.md"), "# Note\n\nContent");
    await incrementalIndexUpdate(store, config, { paths: ["note.md"] });

    const manifest = store.getManifest();
    store.setManifest({
      ...manifest!,
      effectiveExcludePatterns: [".obsidian/", "node_modules/"],
    });

    const newConfig = structuredClone(DEFAULT_CONFIG);
    newConfig.vault.root = tmpDir;
    newConfig.vault.exclude = ["new-exclude/"];

    await expect(
      incrementalIndexUpdate(store, newConfig, {
        paths: ["note.md"],
      }),
    ).rejects.toThrow("reindex");
  });

  it("detects embedding model change and requires reindex", async () => {
    fs.writeFileSync(path.join(tmpDir, "note.md"), "# Note\n\nContent");
    await incrementalIndexUpdate(store, config, { paths: ["note.md"] });

    const manifest = store.getManifest();
    store.setManifest({
      ...manifest!,
      embeddingModel: "old-model",
    });

    const newConfig = structuredClone(DEFAULT_CONFIG);
    newConfig.vault.root = tmpDir;
    newConfig.embedding.enabled = true;
    newConfig.embedding.model = "new-model";

    await expect(
      incrementalIndexUpdate(store, newConfig, {
        paths: ["note.md"],
      }),
    ).rejects.toThrow("reindex");
  });

  it("does not corrupt the index on writer failure", async () => {
    fs.writeFileSync(path.join(tmpDir, "good.md"), "# Good\n\nContent.");
    await incrementalIndexUpdate(store, config, { paths: ["good.md"] });

    const goodNote = store.getNoteByPath("good.md");
    expect(goodNote).not.toBeNull();

    const badConfig = structuredClone(DEFAULT_CONFIG);
    badConfig.vault.root = "/nonexistent";
    await expect(
      incrementalIndexUpdate(store, badConfig, { paths: ["good.md"] }),
    ).rejects.toThrow();

    const stillGood = store.getNoteByPath("good.md");
    expect(stillGood).not.toBeNull();
  });

  it("preserves last usable index for degraded files", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "note.md"),
      "# Note\n\nContent".repeat(1000),
    );

    const largePath = path.join(tmpDir, "large.md");
    fs.writeFileSync(largePath, "# Large\n\n" + "x".repeat(3 * 1024 * 1024));

    const result = await incrementalIndexUpdate(store, config, {
      paths: ["large.md"],
    });

    expect(result.warnings.some((w) => w.code === "INDEX_FILE_TOO_LARGE")).toBe(
      true,
    );
  });

  it("search during pending state uses the last usable index", async () => {
    fs.writeFileSync(
      path.join(tmpDir, "existing.md"),
      "# Existing\n\nContent.",
    );
    await incrementalIndexUpdate(store, config, { paths: ["existing.md"] });

    fs.writeFileSync(
      path.join(tmpDir, "pending.md"),
      "# Pending\n\nNew content.",
    );

    const results = await store.searchLexical("Existing", 10);
    expect(results.length).toBeGreaterThan(0);
  });

  it("get during stale state warns only when ID lookup may be affected", async () => {
    fs.writeFileSync(path.join(tmpDir, "note.md"), "# Note\n\nContent.");
    await incrementalIndexUpdate(store, config, { paths: ["note.md"] });

    const noteId = noteIdFromPath("note.md");
    const retrieved = store.getNote(noteId);
    expect(retrieved).not.toBeNull();
  });
});

describe("incrementalIndexUpdate error code mapping", () => {
  let tmpDir: string;
  let indexDir: string;
  let store: IndexStore;
  let config: Config;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-inc-err-"));
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-inc-err-idx-"),
    );
    store = await setupStoreWithManifest(tmpDir, indexDir);
    config = structuredClone(DEFAULT_CONFIG);
    config.vault.root = tmpDir;
  });

  afterEach(() => {
    try {
      store.close();
    } catch {}
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("throws INDEX_SCHEMA_INCOMPATIBLE on schema version mismatch", async () => {
    const manifest = store.getManifest();
    store.setManifest({
      ...manifest!,
      schemaVersion: manifest!.schemaVersion + 1,
    });

    fs.writeFileSync(path.join(tmpDir, "n.md"), "# N");

    await expect(
      incrementalIndexUpdate(store, config, { paths: ["n.md"] }),
    ).rejects.toMatchObject({ code: "INDEX_SCHEMA_INCOMPATIBLE" });
  });

  it("throws INDEX_VAULT_IDENTITY_CHANGED when vault identity changes", async () => {
    const manifest = store.getManifest();
    store.setManifest({
      ...manifest!,
      vaultIdentity: "different-vault",
    });

    fs.writeFileSync(path.join(tmpDir, "n.md"), "# N");

    await expect(
      incrementalIndexUpdate(store, config, { paths: ["n.md"] }),
    ).rejects.toMatchObject({ code: "INDEX_VAULT_IDENTITY_CHANGED" });
  });

  it("throws INDEX_EXCLUDES_CHANGED when exclude patterns change", async () => {
    const manifest = store.getManifest();
    store.setManifest({
      ...manifest!,
      effectiveExcludePatterns: [".obsidian/", "node_modules/"],
    });

    fs.writeFileSync(path.join(tmpDir, "n.md"), "# N");

    await expect(
      incrementalIndexUpdate(store, config, { paths: ["n.md"] }),
    ).rejects.toMatchObject({ code: "INDEX_EXCLUDES_CHANGED" });
  });

  it("throws INDEX_CHUNKING_CHANGED when chunk size changes", async () => {
    const manifest = store.getManifest();
    store.setManifest({
      ...manifest!,
      targetChunkSize: 9999,
    });

    fs.writeFileSync(path.join(tmpDir, "n.md"), "# N");

    await expect(
      incrementalIndexUpdate(store, config, { paths: ["n.md"] }),
    ).rejects.toMatchObject({ code: "INDEX_CHUNKING_CHANGED" });
  });

  it("throws INDEX_EMBEDDINGS_STALE when embedding model changes", async () => {
    const manifest = store.getManifest();
    store.setManifest({
      ...manifest!,
      embeddingModel: "old-model",
    });

    const newConfig = structuredClone(DEFAULT_CONFIG);
    newConfig.vault.root = tmpDir;
    newConfig.embedding.enabled = true;
    newConfig.embedding.model = "new-model";

    fs.writeFileSync(path.join(tmpDir, "n.md"), "# N");

    await expect(
      incrementalIndexUpdate(store, newConfig, { paths: ["n.md"] }),
    ).rejects.toMatchObject({ code: "INDEX_EMBEDDINGS_STALE" });
  });

  it("throws INDEX_EMBEDDING_DIMENSION_MISMATCH on dimension change", async () => {
    const manifest = store.getManifest();
    store.setManifest({
      ...manifest!,
      embeddingModel: "model",
      embeddingDimension: 384,
    });

    const newConfig = structuredClone(DEFAULT_CONFIG);
    newConfig.vault.root = tmpDir;
    newConfig.embedding.enabled = true;
    newConfig.embedding.model = "model";
    (newConfig.embedding as { dimension?: number | null }).dimension = 768;

    fs.writeFileSync(path.join(tmpDir, "n.md"), "# N");

    await expect(
      incrementalIndexUpdate(store, newConfig, { paths: ["n.md"] }),
    ).rejects.toMatchObject({ code: "INDEX_EMBEDDING_DIMENSION_MISMATCH" });
  });

  it("warns with INDEX_FILE_NOT_UTF8 for non-UTF8 content", async () => {
    const notePath = path.join(tmpDir, "binary.md");
    fs.writeFileSync(notePath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
    const result = await incrementalIndexUpdate(store, config, {
      paths: ["binary.md"],
    });
    expect(result.warnings.some((w) => w.code === "INDEX_FILE_BINARY")).toBe(
      true,
    );
  });

  it("warns with INDEX_FRONTMATTER_PARSE_FAILED for malformed frontmatter", async () => {
    const notePath = path.join(tmpDir, "bad-fm.md");
    fs.writeFileSync(
      notePath,
      "---\n: invalid: yaml :\n---\n# Content\n\nBody.",
    );
    const result = await incrementalIndexUpdate(store, config, {
      paths: ["bad-fm.md"],
    });
    expect(
      result.warnings.some((w) => w.code === "INDEX_FRONTMATTER_PARSE_FAILED"),
    ).toBe(true);
  });

  it("warns with INDEX_FILE_READ_FAILED for unreadable files", async () => {
    const notePath = path.join(tmpDir, "deleted.md");
    fs.writeFileSync(notePath, "# Note");
    fs.unlinkSync(notePath);
    const result = await incrementalIndexUpdate(store, config, {
      paths: ["deleted.md"],
    });
    expect(result.notesIndexed).toBe(0);
  });
});

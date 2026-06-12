import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { IndexStore } from "../src/index-store.js";
import { search } from "../src/search.js";
import { getRelated } from "../src/related.js";
import { Config, DEFAULT_CONFIG } from "../src/config.js";
import { noteIdFromPath, vaultIdentity } from "../src/identifiers.js";
import { SearchError } from "../src/errors.js";
import { indexVault } from "../src/indexer.js";
import {
  MAX_MARKDOWN_SIZE_FOR_INDEXING,
  EMBEDDING_BATCH_SIZE,
} from "../src/schemas.js";
import {
  EmbeddingProvider,
  EmbeddingProviderError,
  validateEmbeddingEndpoint,
} from "../src/embedding.js";

let fakeServer: http.Server;
let fakeServerPort: number;

const EMBEDDING_DIMENSION = 8;

function deterministicVector(
  input: string,
  dimension: number,
): Float32Array {
  const vec = new Float32Array(dimension);
  let hash = 0;
  for (let i = 0; i < input.length; i++) {
    hash = ((hash << 5) - hash + input.charCodeAt(i)) | 0;
  }
  for (let i = 0; i < dimension; i++) {
    hash = ((hash << 5) - hash + i) | 0;
    vec[i] = Math.sin(hash) * 0.5 + 0.5;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  for (let i = 0; i < dimension; i++) {
    vec[i] /= norm;
  }
  return vec;
}

function startFakeServer(): Promise<void> {
  return new Promise((resolve) => {
    fakeServer = http.createServer((req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/embeddings") {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "not found" }));
        return;
      }

      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => {
        try {
          const parsed = JSON.parse(body);
          const model = parsed.model ?? "test-model";
          const inputs = parsed.input as string[];

          const data = inputs.map((input: string, index: number) => ({
            object: "embedding",
            index,
            embedding: Array.from(deterministicVector(input, EMBEDDING_DIMENSION)),
          }));

          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              object: "list",
              data,
              model,
              usage: { prompt_tokens: 0, total_tokens: 0 },
            }),
          );
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ error: "bad request" }));
        }
      });
    });

    fakeServer.listen(0, "127.0.0.1", () => {
      const addr = fakeServer.address() as { port: number };
      fakeServerPort = addr.port;
      resolve();
    });
  });
}

function stopFakeServer(): Promise<void> {
  return new Promise((resolve) => {
    if (fakeServer) {
      fakeServer.close(() => resolve());
    } else {
      resolve();
    }
  });
}

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-embedding-"),
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

  fs.writeFileSync(
    path.join(vaultDir, "Gamma.md"),
    `# Gamma Note

Gamma content about hybrid search combining lexical and embedding results.`,
  );

  return vaultDir;
}

function createOversizedVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-oversized-"),
  );

  fs.writeFileSync(
    path.join(vaultDir, "Empty.md"),
    `---
title: "Empty Note"
---

`,
  );

  const largeSize = MAX_MARKDOWN_SIZE_FOR_INDEXING + 1024;
  const content = "# Oversized Note\n\n" + "x".repeat(largeSize);
  fs.writeFileSync(path.join(vaultDir, "Oversized.md"), content);

  fs.writeFileSync(
    path.join(vaultDir, "Normal.md"),
    `# Normal Note

This is a normal note about oversized and empty note handling.`,
  );

  return vaultDir;
}

function createTestConfig(
  vaultRoot: string,
  indexDir: string,
  embeddingOverrides?: Partial<Config["embedding"]>,
): Config {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    vault: { root: vaultRoot, exclude: [] },
    server: { ...DEFAULT_CONFIG.server },
    index: { dir: indexDir },
    embedding: {
      ...DEFAULT_CONFIG.embedding,
      ...embeddingOverrides,
    },
    cors: { ...DEFAULT_CONFIG.cors },
  };
}

async function openStoreForConfig(
  config: Config,
  dimension?: number,
): Promise<IndexStore> {
  const resolvedVault = path.resolve(config.vault.root);
  const dbPath = path.join(
    config.index.dir,
    vaultIdentity(resolvedVault),
    "index.sqlite",
  );
  return IndexStore.open(dbPath, dimension);
}

describe("Embedding provider integration", () => {
  describe("search with mode=embedding when embeddings unavailable", () => {
    let vaultDir: string;
    let indexDir: string;
    let configNoEmbedding: Config;

    beforeEach(() => {
      vaultDir = createTestVault();
      indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-idx-"));
      configNoEmbedding = createTestConfig(vaultDir, indexDir, {
        enabled: false,
      });
    });

    afterEach(() => {
      fs.rmSync(vaultDir, { recursive: true, force: true });
      fs.rmSync(indexDir, { recursive: true, force: true });
    });

    it("throws SearchError with EMBEDDING_UNAVAILABLE when mode=embedding and embedding.enabled=false", async () => {
      await indexVault(configNoEmbedding);
      const store = await openStoreForConfig(configNoEmbedding);

      try {
        await expect(
          search(store, "test query", "embedding", 10, configNoEmbedding),
        ).rejects.toThrow(SearchError);

        try {
          await search(store, "test query", "embedding", 10, configNoEmbedding);
        } catch (err) {
          expect(err).toBeInstanceOf(SearchError);
          expect((err as SearchError).code).toBe("EMBEDDING_UNAVAILABLE");
        }
      } finally {
        store.close();
      }
    });
  });

  describe("search with mode=hybrid falls back to lexical when embeddings unavailable", () => {
    let vaultDir: string;
    let indexDir: string;
    let configEmbeddingNoModel: Config;

    beforeEach(() => {
      vaultDir = createTestVault();
      indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-idx-"));
      configEmbeddingNoModel = createTestConfig(vaultDir, indexDir, {
        enabled: true,
        model: "",
      });
    });

    afterEach(() => {
      fs.rmSync(vaultDir, { recursive: true, force: true });
      fs.rmSync(indexDir, { recursive: true, force: true });
    });

    it("falls back to lexical mode with EMBEDDING_UNAVAILABLE warning when mode=hybrid and embeddings are configured but unavailable", async () => {
      await indexVault(configEmbeddingNoModel);
      const store = await openStoreForConfig(configEmbeddingNoModel);

      try {
        const result = await search(
          store,
          "lexical search",
          "hybrid",
          10,
          configEmbeddingNoModel,
        );

        expect(result.requestedMode).toBe("hybrid");
        expect(result.usedMode).toBe("lexical");
        expect(result.warnings.length).toBeGreaterThan(0);

        const embeddingWarning = result.warnings.find(
          (w) => w.code === "EMBEDDING_UNAVAILABLE",
        );
        expect(embeddingWarning).toBeDefined();
        expect(embeddingWarning!.message).toContain("unavailable");
      } finally {
        store.close();
      }
    });
  });

  describe("related with mode=embedding when embeddings unavailable", () => {
    let vaultDir: string;
    let indexDir: string;
    let configNoEmbedding: Config;

    beforeEach(() => {
      vaultDir = createTestVault();
      indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-idx-"));
      configNoEmbedding = createTestConfig(vaultDir, indexDir, {
        enabled: false,
      });
    });

    afterEach(() => {
      fs.rmSync(vaultDir, { recursive: true, force: true });
      fs.rmSync(indexDir, { recursive: true, force: true });
    });

    it("throws SearchError with EMBEDDING_UNAVAILABLE when mode=embedding and embedding.enabled=false", async () => {
      await indexVault(configNoEmbedding);
      const store = await openStoreForConfig(configNoEmbedding);

      try {
        const notes = store.getAllNotes();
        const noteId = notes[0]!.note_id as string;

        await expect(
          getRelated(store, "note", noteId, "embedding", 10, configNoEmbedding),
        ).rejects.toThrow(SearchError);

        try {
          await getRelated(
            store,
            "note",
            noteId,
            "embedding",
            10,
            configNoEmbedding,
          );
        } catch (err) {
          expect(err).toBeInstanceOf(SearchError);
          expect((err as SearchError).code).toBe("EMBEDDING_UNAVAILABLE");
        }
      } finally {
        store.close();
      }
    });
  });

  describe("note-type search results for oversized and empty notes", () => {
    let vaultDir: string;
    let indexDir: string;
    let config: Config;

    beforeEach(() => {
      vaultDir = createOversizedVault();
      indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-idx-"));
      config = createTestConfig(vaultDir, indexDir);
    });

    afterEach(() => {
      fs.rmSync(vaultDir, { recursive: true, force: true });
      fs.rmSync(indexDir, { recursive: true, force: true });
    });

    it("returns note-type results for oversized and empty notes that have no chunks", async () => {
      await indexVault(config);
      const store = await openStoreForConfig(config);

      try {
        const oversizedNote = store.getNoteByPath("Oversized.md");
        const emptyNote = store.getNoteByPath("Empty.md");

        expect(oversizedNote).not.toBeNull();
        expect(oversizedNote!.oversized).toBe(1);

        expect(emptyNote).not.toBeNull();
        expect(emptyNote!.empty).toBe(1);

        const oversizedChunks = store.getChunks(
          oversizedNote!.note_id as string,
        );
        const emptyChunks = store.getChunks(emptyNote!.note_id as string);

        expect(oversizedChunks.length).toBe(0);
        expect(emptyChunks.length).toBe(0);

        const result = await search(
          store,
          "oversized note",
          "lexical",
          10,
          config,
        );

        const noteTypeResults = result.results.filter(
          (r) => r.type === "note",
        );
        expect(noteTypeResults.length).toBeGreaterThan(0);

        for (const nr of noteTypeResults) {
          expect(nr.type).toBe("note");
          expect(nr.noteId).toBeDefined();
          expect(nr.path).toBeDefined();
        }
      } finally {
        store.close();
      }
    });

    it("includes empty notes as note-type results in search", async () => {
      await indexVault(config);
      const store = await openStoreForConfig(config);

      try {
        const result = await search(
          store,
          "empty note",
          "lexical",
          10,
          config,
        );

        const emptyNoteResults = result.results.filter(
          (r) => r.noteId === store.getNoteByPath("Empty.md")!.note_id,
        );
        expect(emptyNoteResults.length).toBeGreaterThan(0);
        expect(emptyNoteResults[0]!.type).toBe("note");
      } finally {
        store.close();
      }
    });
  });

  describe("EmbeddingProvider - endpoint validation", () => {
    it("accepts localhost endpoints", () => {
      expect(validateEmbeddingEndpoint("http://127.0.0.1:11434/v1/embeddings")).toBeNull();
      expect(validateEmbeddingEndpoint("http://localhost:11434/v1/embeddings")).toBeNull();
      expect(validateEmbeddingEndpoint("http://[::1]:11434/v1/embeddings")).toBeNull();
    });

    it("rejects non-localhost endpoints", () => {
      expect(validateEmbeddingEndpoint("http://192.168.1.1:11434/v1/embeddings")).not.toBeNull();
      expect(validateEmbeddingEndpoint("http://example.com:11434/v1/embeddings")).not.toBeNull();
    });

    it("rejects invalid URLs", () => {
      expect(validateEmbeddingEndpoint("not-a-url")).not.toBeNull();
    });
  });

  describe("EmbeddingProvider - batch embedding with fake server", () => {
    beforeEach(async () => {
      await startFakeServer();
    });

    afterEach(async () => {
      await stopFakeServer();
    });

    it("generates embeddings from a fake embedding server", async () => {
      const config = createTestConfig("/tmp/fake-vault", "/tmp/fake-idx", {
        enabled: true,
        model: "test-model",
        endpoint: `http://127.0.0.1:${fakeServerPort}/v1/embeddings`,
      });

      const provider = new EmbeddingProvider(config);
      const result = await provider.embed(["hello world", "test query"]);

      expect(result.embeddings).toHaveLength(2);
      expect(result.embeddings[0]!.length).toBe(EMBEDDING_DIMENSION);
      expect(result.embeddings[1]!.length).toBe(EMBEDDING_DIMENSION);
      expect(result.model).toBe("test-model");
      expect(result.dimension).toBe(EMBEDDING_DIMENSION);
    });

    it("batches correctly when input exceeds batch size", async () => {
      const config = createTestConfig("/tmp/fake-vault", "/tmp/fake-idx", {
        enabled: true,
        model: "test-model",
        endpoint: `http://127.0.0.1:${fakeServerPort}/v1/embeddings`,
      });

      const provider = new EmbeddingProvider(config);
      const texts = Array.from({ length: EMBEDDING_BATCH_SIZE + 5 }, (_, i) => `text ${i}`);

      const result = await provider.embed(texts);
      expect(result.embeddings).toHaveLength(EMBEDDING_BATCH_SIZE + 5);
    });

    it("throws EmbeddingProviderError on server error", async () => {
      const config = createTestConfig("/tmp/fake-vault", "/tmp/fake-idx", {
        enabled: true,
        model: "test-model",
        endpoint: `http://127.0.0.1:${fakeServerPort}/nonexistent`,
      });

      const provider = new EmbeddingProvider(config);
      await expect(provider.embed(["test"])).rejects.toThrow(
        EmbeddingProviderError,
      );
    });

    it("throws EmbeddingProviderError on connection failure", async () => {
      const config = createTestConfig("/tmp/fake-vault", "/tmp/fake-idx", {
        enabled: true,
        model: "test-model",
        endpoint: "http://127.0.0.1:1/v1/embeddings",
      });

      const provider = new EmbeddingProvider(config);
      await expect(provider.embed(["test"])).rejects.toThrow(
        EmbeddingProviderError,
      );
    });
  });

  describe("IndexStore - vector storage and search", () => {
    let vaultDir: string;
    let indexDir: string;
    let store: IndexStore;

    beforeEach(async () => {
      vaultDir = createTestVault();
      indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-idx-"));
      const config = createTestConfig(vaultDir, indexDir);
      await indexVault(config);
      store = await openStoreForConfig(config, EMBEDDING_DIMENSION);
    });

    afterEach(() => {
      store.close();
      fs.rmSync(vaultDir, { recursive: true, force: true });
      fs.rmSync(indexDir, { recursive: true, force: true });
    });

    it("stores and queries embedding vectors", () => {
      if (!store.isVecAvailable()) {
        return;
      }

      const chunkIds = store.getAllChunkIds();
      if (chunkIds.length === 0) return;

      const embeddings = chunkIds.map((id) =>
        deterministicVector(id, EMBEDDING_DIMENSION),
      );
      const hashes = chunkIds.map(() => "abc123");

      store.storeEmbeddings(chunkIds, embeddings, hashes);

      const queryVec = deterministicVector(chunkIds[0]!, EMBEDDING_DIMENSION);
      const results = store.searchEmbeddingVectors(queryVec, 5);

      expect(results.length).toBeGreaterThan(0);
      expect(results[0]!.chunk_id).toBe(chunkIds[0]);
      expect(typeof results[0]!.distance).toBe("number");
    });

    it("returns empty results when vec is not available", () => {
      if (store.isVecAvailable()) {
        return;
      }
      const queryVec = new Float32Array(EMBEDDING_DIMENSION);
      const results = store.searchEmbeddingVectors(queryVec, 5);
      expect(results).toEqual([]);
    });
  });

  describe("End-to-end embedding search with fake server", () => {
    let vaultDir: string;
    let indexDir: string;
    let configWithEmbedding: Config;

    beforeEach(async () => {
      await startFakeServer();
      vaultDir = createTestVault();
      indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-idx-"));
      configWithEmbedding = createTestConfig(vaultDir, indexDir, {
        enabled: true,
        model: "test-model",
        endpoint: `http://127.0.0.1:${fakeServerPort}/v1/embeddings`,
      });
    });

    afterEach(async () => {
      await stopFakeServer();
      fs.rmSync(vaultDir, { recursive: true, force: true });
      fs.rmSync(indexDir, { recursive: true, force: true });
    });

    it("indexes vault with embedding generation", async () => {
      const result = await indexVault(configWithEmbedding);

      expect(result.notesIndexed).toBeGreaterThan(0);
      expect(result.chunksIndexed).toBeGreaterThan(0);
      expect(result.warnings).toEqual([]);

      const store = await openStoreForConfig(
        configWithEmbedding,
        EMBEDDING_DIMENSION,
      );
      try {
        const manifest = store.getManifest();
        expect(manifest).not.toBeNull();
        expect(manifest!.embeddingModel).toBe("test-model");
        expect(manifest!.embeddingDimension).toBe(EMBEDDING_DIMENSION);
      } finally {
        store.close();
      }
    });

    it("searches with embedding mode using a provider", async () => {
      await indexVault(configWithEmbedding);

      const store = await openStoreForConfig(
        configWithEmbedding,
        EMBEDDING_DIMENSION,
      );
      try {
        const provider = new EmbeddingProvider(configWithEmbedding);

        const result = await search(
          store,
          "lexical search",
          "embedding",
          10,
          configWithEmbedding,
          provider,
        );

        expect(result.requestedMode).toBe("embedding");
        expect(result.usedMode).toBe("embedding");
        expect(result.results.length).toBeGreaterThan(0);

        for (const r of result.results) {
          expect(r.reason).toBe("embedding_match");
          expect(r.score).toBeGreaterThanOrEqual(0);
          expect(r.score).toBeLessThanOrEqual(1);
        }
      } finally {
        store.close();
      }
    });

    it("searches with hybrid mode combining lexical and embedding results", async () => {
      await indexVault(configWithEmbedding);

      const store = await openStoreForConfig(
        configWithEmbedding,
        EMBEDDING_DIMENSION,
      );
      try {
        const provider = new EmbeddingProvider(configWithEmbedding);

        const result = await search(
          store,
          "search",
          "hybrid",
          10,
          configWithEmbedding,
          provider,
        );

        expect(result.requestedMode).toBe("hybrid");
        expect(result.usedMode).toBe("hybrid");
        expect(result.results.length).toBeGreaterThan(0);

        const hasHybrid = result.results.some(
          (r) => r.reason === "hybrid_match",
        );
        expect(hasHybrid).toBe(true);
      } finally {
        store.close();
      }
    });

    it("uses related with embedding mode using a provider", async () => {
      await indexVault(configWithEmbedding);

      const store = await openStoreForConfig(
        configWithEmbedding,
        EMBEDDING_DIMENSION,
      );
      try {
        const provider = new EmbeddingProvider(configWithEmbedding);
        const notes = store.getAllNotes();
        const noteId = notes[0]!.note_id as string;

        const result = await getRelated(
          store,
          "note",
          noteId,
          "embedding",
          10,
          configWithEmbedding,
          provider,
        );

        expect(result.requestedMode).toBe("embedding");
        expect(result.usedMode).toBe("embedding");
        expect(result.results.length).toBeGreaterThan(0);
        expect(result.input.id).toBe(noteId);
      } finally {
        store.close();
      }
    });
  });

  describe("Embedding failure behavior", () => {
    it("indexing succeeds with warning when embedding fails and require=false", async () => {
      const vaultDir = createTestVault();
      const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-idx-"));
      const config = createTestConfig(vaultDir, indexDir, {
        enabled: true,
        model: "test-model",
        endpoint: "http://127.0.0.1:1/v1/embeddings",
        require: false,
      });

      try {
        const result = await indexVault(config);

        expect(result.notesIndexed).toBeGreaterThan(0);
        const embeddingWarning = result.warnings.find(
          (w) => w.code === "EMBEDDING_FAILED",
        );
        expect(embeddingWarning).toBeDefined();
      } finally {
        fs.rmSync(vaultDir, { recursive: true, force: true });
        fs.rmSync(indexDir, { recursive: true, force: true });
      }
    });

    it("indexing fails when embedding fails and require=true", async () => {
      const vaultDir = createTestVault();
      const indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-idx-"));
      const config = createTestConfig(vaultDir, indexDir, {
        enabled: true,
        model: "test-model",
        endpoint: "http://127.0.0.1:1/v1/embeddings",
        require: true,
      });

      try {
        await expect(indexVault(config)).rejects.toThrow();
      } finally {
        fs.rmSync(vaultDir, { recursive: true, force: true });
        fs.rmSync(indexDir, { recursive: true, force: true });
      }
    });
  });
});
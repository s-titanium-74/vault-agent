import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer, initApp, resetApp } from "../../server/src/index.js";
import {
  Config,
  DEFAULT_CONFIG,
  IndexStore,
  indexVault,
  vaultIdentity,
} from "@vault-agent/core";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-cli-vault-"),
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

  fs.mkdirSync(path.join(vaultDir, "attachments"), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, "attachments", "data.csv"),
    "a,b,c\n1,2,3",
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

async function startServer(
  store: IndexStore,
  config: Config,
): Promise<{ app: Awaited<ReturnType<typeof createServer>>; port: number }> {
  const app = await createServer(config);
  initApp(store, config);

  const address = await app.listen({ port: 0, host: "127.0.0.1" });

  const match = address.match(/:(\d+)$/);
  const port = match ? parseInt(match[1]!, 10) : 0;

  return { app, port };
}

describe("CLI integration tests with local server", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-cli-idx-"));
    config = createTestConfig(vaultDir, indexDir);

    await indexVault(config);

    const dbPath = path.join(
      indexDir,
      vaultIdentity(path.resolve(vaultDir)),
      "index.sqlite",
    );
    store = await IndexStore.open(dbPath);

    const serverInfo = await startServer(store, config);
    app = serverInfo.app;
    port = serverInfo.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    try {
      store?.close();
    } catch {}
    try {
      await app?.close();
    } catch {}
    resetApp();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  describe("GET /health", () => {
    it("returns health status", async () => {
      const res = await fetch(`${baseUrl}/health`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.status).toBe("ok");
      expect(data.data.version).toBe("0.1.0");
      expect(data.data.index.available).toBe(true);
    });
  });

  describe("POST /search", () => {
    it("returns search results for a lexical query", async () => {
      const res = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "search", mode: "lexical", limit: 10 }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.requestedMode).toBe("lexical");
      expect(data.data.usedMode).toBe("lexical");
      expect(data.data.results.length).toBeGreaterThan(0);
      expect(data.data.results[0].path).toBeDefined();
      expect(data.data.results[0].score).toBeGreaterThanOrEqual(0);
    });

    it("returns empty results for unlikely query", async () => {
      const res = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "xyznonexistent123",
          mode: "lexical",
          limit: 10,
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.results.length).toBe(0);
    });

    it("returns 400 for empty query", async () => {
      const res = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "   ", mode: "lexical", limit: 10 }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 400 for invalid mode", async () => {
      const res = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "test",
          mode: "invalid_mode",
          limit: 10,
        }),
      });
      expect(res.status).toBe(400);
    });

    it("returns 503 for embedding mode when not available", async () => {
      const res = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "test", mode: "embedding", limit: 10 }),
      });
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error.code).toBe("EMBEDDING_UNAVAILABLE");
    });

    it("falls back to lexical for hybrid mode when embeddings unavailable", async () => {
      const res = await fetch(`${baseUrl}/search`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query: "search", mode: "hybrid", limit: 10 }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.usedMode).toBe("lexical");
      expect(data.warnings.length).toBeGreaterThan(0);
      const emb = data.warnings.find(
        (w: { code: string }) => w.code === "EMBEDDING_UNAVAILABLE",
      );
      expect(emb).toBeDefined();
    });
  });

  describe("POST /related", () => {
    it("returns related results for a valid note ID", async () => {
      const notes = store.getAllNotes();
      const noteId = notes[0]!.note_id as string;

      const res = await fetch(`${baseUrl}/related`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "note",
          id: noteId,
          mode: "lexical",
          limit: 10,
        }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.input.type).toBe("note");
      expect(data.data.input.id).toBe(noteId);
    });

    it("returns 404 for nonexistent note ID", async () => {
      const res = await fetch(`${baseUrl}/related`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "note",
          id: "00000000000000000000000000000000",
          mode: "lexical",
          limit: 10,
        }),
      });
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error.code).toBe("NOTE_NOT_FOUND");
    });
  });

  describe("GET /notes/:noteId", () => {
    it("returns note content", async () => {
      const notes = store.getAllNotes();
      const noteId = notes[0]!.note_id as string;

      const res = await fetch(`${baseUrl}/notes/${noteId}`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.id).toBe(noteId);
      expect(data.data.content).toBeDefined();
      expect(data.data.contentType).toBe("text/markdown; charset=utf-8");
    });

    it("returns 404 for nonexistent note", async () => {
      const res = await fetch(
        `${baseUrl}/notes/00000000000000000000000000000000`,
      );
      expect(res.status).toBe(404);
    });

    it("returns 400 for invalid note ID format", async () => {
      const res = await fetch(`${baseUrl}/notes/invalid-id`);
      expect(res.status).toBe(400);
    });
  });

  describe("GET /chunks/:noteId/:chunkIndex", () => {
    it("returns chunk content", async () => {
      const notes = store.getAllNotes();
      const noteId = notes[0]!.note_id as string;

      const res = await fetch(`${baseUrl}/chunks/${noteId}/0`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.noteId).toBe(noteId);
      expect(data.data.chunkIndex).toBe(0);
      expect(data.data.content).toBeDefined();
    });

    it("returns 404 for nonexistent chunk", async () => {
      const res = await fetch(
        `${baseUrl}/chunks/00000000000000000000000000000000/0`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("POST /index", () => {
    it("performs incremental indexing", async () => {
      const res = await fetch(`${baseUrl}/index`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.mode).toBe("incremental");
    });
  });

  describe("POST /reindex", () => {
    it("performs full reindexing", async () => {
      const res = await fetch(`${baseUrl}/reindex`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.mode).toBe("full");
      expect(data.data.notesIndexed).toBeGreaterThan(0);
    });
  });

  describe("GET /attachments/*", () => {
    it("returns attachment metadata", async () => {
      const res = await fetch(`${baseUrl}/attachments/attachments/data.csv`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.data.path).toBe("attachments/data.csv");
      expect(data.data.contentType).toBe("text/csv");
      expect(data.data.size).toBeGreaterThan(0);
      expect(data.data.downloadAvailable).toBe(true);
    });

    it("returns 403 for Markdown file via attachment API", async () => {
      const res = await fetch(`${baseUrl}/attachments/Alpha.md`);
      expect(res.status).toBe(403);
    });

    it("returns 404 for nonexistent attachment", async () => {
      const res = await fetch(
        `${baseUrl}/attachments/attachments/nonexistent.txt`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe("API key authentication", () => {
    it("rejects requests without valid API key when configured", async () => {
      await app.close();
      resetApp();

      const authConfig = createTestConfig(vaultDir, indexDir);
      authConfig.server.apiKey = "test-secret-key-that-is-long-enough-32ch";

      const authApp = await createServer(authConfig);
      initApp(store, authConfig);
      const authAddress = await authApp.listen({ port: 0, host: "127.0.0.1" });
      const authMatch = authAddress.match(/:(\d+)$/);
      const authPort = authMatch ? parseInt(authMatch[1]!, 10) : 0;
      const authUrl = `http://127.0.0.1:${authPort}`;

      try {
        const res = await fetch(`${authUrl}/health`);
        expect(res.status).toBe(401);

        const authed = await fetch(`${authUrl}/health`, {
          headers: {
            Authorization: "Bearer test-secret-key-that-is-long-enough-32ch",
          },
        });
        expect(authed.status).toBe(200);
      } finally {
        await authApp.close();
        resetApp();
      }
    });
  });

  describe("CORS validation", () => {
    it("rejects wildcard origins when CORS is enabled", async () => {
      await app.close();
      resetApp();

      const corsConfig = createTestConfig(vaultDir, indexDir);
      corsConfig.cors.enabled = true;
      corsConfig.cors.allowedOrigins = ["*"];

      await expect(createServer(corsConfig)).rejects.toThrow();
    });

    it("accepts specific origins when CORS is enabled", async () => {
      await app.close();
      resetApp();

      const corsConfig = createTestConfig(vaultDir, indexDir);
      corsConfig.cors.enabled = true;
      corsConfig.cors.allowedOrigins = ["http://localhost:3000"];

      const corsApp = await createServer(corsConfig);
      initApp(store, corsConfig);
      const corsAddress = await corsApp.listen({ port: 0, host: "127.0.0.1" });
      const corsMatch = corsAddress.match(/:(\d+)$/);
      const corsPort = corsMatch ? parseInt(corsMatch[1]!, 10) : 0;

      try {
        const res = await fetch(`http://127.0.0.1:${corsPort}/health`, {
          headers: { Origin: "http://localhost:3000" },
        });
        expect(res.status).toBe(200);
      } finally {
        await corsApp.close();
        resetApp();
      }
    });
  });
});

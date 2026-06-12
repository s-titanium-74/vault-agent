import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  createServer,
  initApp,
  prepareServerAccessConfig,
  resetApp,
  validateStartupIndexState,
} from "../src/index.js";
import {
  Config,
  DEFAULT_CONFIG,
  DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT,
  IndexStore,
  indexVault,
  reindexVault,
  vaultIdentity,
  noteIdFromPath,
} from "@vault-agent/core";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-server-vault-"),
  );

  fs.writeFileSync(
    path.join(vaultDir, "Welcome.md"),
    `---
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

Configure your vault root and start the server.`,
  );

  fs.mkdirSync(path.join(vaultDir, "Architecture"), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, "Architecture", "Search.md"),
    `---
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

Lexical search uses SQLite FTS5 with the unicode61 tokenizer.

## Hybrid Search

Hybrid search combines lexical and embedding results using Reciprocal Rank Fusion.`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Configuration.md"),
    `# Configuration Guide

Vault-agent uses TOML configuration files stored in user-local directories.

## Server Settings

Default server endpoint is http://127.0.0.1:8787.`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Privacy.md"),
    `# Privacy and Security

Vault-agent is designed with local-first and private-by-default principles.

## Localhost Default

The server binds to 127.0.0.1 by default.`,
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

function createTestConfigWithApiKey(
  vaultRoot: string,
  indexDir: string,
  apiKey: string,
): Config {
  const config = createTestConfig(vaultRoot, indexDir);
  config.server.apiKey = apiKey;
  return config;
}

describe("Server Routes", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-server-idx-"));
    config = createTestConfig(vaultDir, indexDir);

    await indexVault(config);

    const dbPath = path.join(
      indexDir,
      vaultIdentity(path.resolve(vaultDir)),
      "index.sqlite",
    );
    store = await IndexStore.open(dbPath);

    app = await createServer(config);
    initApp(store, config);
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
    it("returns 200 with status ok when index is available", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.status).toBe("ok");
      expect(body.data.version).toBe("0.1.0");
      expect(body.data.index.available).toBe(true);
      expect(body.data.index.embeddingAvailable).toBe(false);
      expect(body.warnings).toEqual([]);
    });
  });

  describe("POST /search", () => {
    it("returns search results for a valid query", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/search",
        payload: { query: "search architecture" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.requestedMode).toBe("hybrid");
      expect(body.data.usedMode).toBe("lexical");
      expect(body.data.results.length).toBeGreaterThan(0);
    });

    it("returns 400 for empty query", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/search",
        payload: { query: "" },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_QUERY");
    });

    it("returns 400 for whitespace-only query", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/search",
        payload: { query: "   " },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_QUERY");
    });

    it("returns 400 for limit exceeding 50", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/search",
        payload: { query: "test", limit: 51 },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_LIMIT");
    });

    it("returns 400 INVALID_MODE for an unknown mode", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/search",
        payload: { query: "test", mode: "unknown" },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_MODE");
    });

    it("returns 503 for embedding mode when embeddings are unavailable", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/search",
        payload: { query: "test", mode: "embedding" },
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.error.code).toBe("EMBEDDING_UNAVAILABLE");
    });

    it("returns warning for hybrid mode falling back to lexical", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/search",
        payload: { query: "search", mode: "hybrid" },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.usedMode).toBe("lexical");
      expect(body.warnings.length).toBeGreaterThan(0);
    });
  });

  describe("POST /related", () => {
    it("returns related notes for a valid note ID", async () => {
      const notes = store.getAllNotes();
      const noteId = notes[0]!.note_id as string;

      const response = await app.inject({
        method: "POST",
        url: "/related",
        payload: { type: "note", id: noteId },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.input.type).toBe("note");
      expect(body.data.input.id).toBe(noteId);
    });

    it("returns 400 for invalid type", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/related",
        payload: { type: "invalid", id: "some-id" },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_REQUEST");
    });

    it("returns 400 INVALID_ID for invalid note ID", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/related",
        payload: { type: "note", id: "invalid-id" },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_ID");
    });

    it("returns 400 INVALID_ID for invalid chunk ID", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/related",
        payload: { type: "chunk", id: "not-a-valid-chunk-id" },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_ID");
    });

    it("returns 400 INVALID_LIMIT for limit exceeding 50", async () => {
      const notes = store.getAllNotes();
      const noteId = notes[0]!.note_id as string;

      const response = await app.inject({
        method: "POST",
        url: "/related",
        payload: { type: "note", id: noteId, limit: 51 },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_LIMIT");
    });

    it("returns 400 INVALID_MODE for an unknown mode", async () => {
      const notes = store.getAllNotes();
      const noteId = notes[0]!.note_id as string;

      const response = await app.inject({
        method: "POST",
        url: "/related",
        payload: { type: "note", id: noteId, mode: "unknown" },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_MODE");
    });
  });

  describe("GET /notes/:noteId", () => {
    it("returns a note for a valid note ID", async () => {
      const notes = store.getAllNotes();
      const noteId = notes[0]!.note_id as string;

      const response = await app.inject({
        method: "GET",
        url: `/notes/${noteId}`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.id).toBe(noteId);
      expect(body.data.path).toBeTruthy();
      expect(body.data.content.length).toBeGreaterThan(0);
    });

    it("returns 404 for a non-existent note ID", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/notes/00000000000000000000000000000000",
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe("NOTE_NOT_FOUND");
    });
  });

  describe("GET /chunks/:noteId/:chunkIndex", () => {
    it("returns a chunk for valid note ID and index", async () => {
      const notes = store.getAllNotes();
      const noteId = notes[0]!.note_id as string;

      const response = await app.inject({
        method: "GET",
        url: `/chunks/${noteId}/0`,
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.noteId).toBe(noteId);
      expect(body.data.chunkIndex).toBe(0);
    });

    it("returns 400 for invalid chunk index", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/chunks/abc/invalid",
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_ID");
    });

    it("returns 400 for negative chunk index", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/chunks/abc/-1",
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_ID");
    });

    it("returns 404 for non-existent chunk", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/chunks/00000000000000000000000000000000/0",
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe("CHUNK_NOT_FOUND");
    });
  });

  describe("GET /attachments/*", () => {
    it("returns attachment metadata", async () => {
      const attachmentsDir = path.join(vaultDir, "attachments");
      fs.mkdirSync(attachmentsDir, { recursive: true });
      fs.writeFileSync(path.join(attachmentsDir, "diagram.png"), "fake-png-data");

      const response = await app.inject({
        method: "GET",
        url: "/attachments/attachments/diagram.png",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.path).toBe("attachments/diagram.png");
      expect(body.data.fileName).toBe("diagram.png");
      expect(body.data.contentType).toBe("image/png");
      expect(body.data.size).toBeGreaterThan(0);
    });

    it("returns attachment bytes with download=true", async () => {
      const attachmentsDir = path.join(vaultDir, "attachments");
      fs.mkdirSync(attachmentsDir, { recursive: true });
      fs.writeFileSync(path.join(attachmentsDir, "data.csv"), "id,name\n1,test");

      const response = await app.inject({
        method: "GET",
        url: "/attachments/attachments/data.csv?download=true",
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers["content-type"]).toBe("text/csv");
      expect(response.headers["content-disposition"]).toContain("data.csv");
    });

    it("returns 404 for non-existent attachment", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/attachments/nonexistent/file.txt",
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe("ATTACHMENT_NOT_FOUND");
    });

    it("returns 403 for attachments excluded by user configuration", async () => {
      config.vault.exclude.push("attachments/private/**");
      const attachmentsDir = path.join(vaultDir, "attachments", "private");
      fs.mkdirSync(attachmentsDir, { recursive: true });
      fs.writeFileSync(path.join(attachmentsDir, "secret.pdf"), "fake-pdf-data");

      const response = await app.inject({
        method: "GET",
        url: "/attachments/attachments/private/secret.pdf",
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error.code).toBe("ATTACHMENT_NOT_ALLOWED");
    });
  });

  describe("POST /index", () => {
    it("triggers indexing and returns results", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/index",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.mode).toBeTruthy();
      expect(typeof body.data.notesIndexed).toBe("number");
      expect(typeof body.data.chunksIndexed).toBe("number");
    });
  });

  describe("POST /index request body validation", () => {
    it("rejects unknown fields in request body", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/index",
        payload: { requireEmbeddings: true, extraField: "bad" },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_REQUEST");
    });
  });

  describe("413 NOTE_TOO_LARGE for oversized note", () => {
    it("returns 413 when note exceeds size limit without allowLarge", async () => {
      const largeContent =
        "---\ntitle: \"Large Note\"\n---\n\n" +
        "x".repeat(DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT + 1000);
      fs.writeFileSync(path.join(vaultDir, "LargeNote.md"), largeContent);

      await reindexVault(config);
      const dbPath = path.join(
        indexDir,
        vaultIdentity(path.resolve(vaultDir)),
        "index.sqlite",
      );
      store.close();
      store = await IndexStore.open(dbPath);
      initApp(store, config);

      const noteId = noteIdFromPath("LargeNote.md");
      const response = await app.inject({
        method: "GET",
        url: `/notes/${noteId}`,
      });

      expect(response.statusCode).toBe(413);
      const body = response.json();
      expect(body.error.code).toBe("NOTE_TOO_LARGE");
    });
  });

  describe("413 ATTACHMENT_TOO_LARGE for oversized attachment", () => {
    it("returns 413 when attachment download exceeds size limit without allowLarge", async () => {
      const attachmentsDir = path.join(vaultDir, "attachments");
      fs.mkdirSync(attachmentsDir, { recursive: true });
      const oversizedBuffer = Buffer.alloc(10 * 1024 * 1024 + 1024);
      fs.writeFileSync(
        path.join(attachmentsDir, "large-file.bin"),
        oversizedBuffer,
      );

      const response = await app.inject({
        method: "GET",
        url: "/attachments/attachments/large-file.bin?download=true",
      });

      expect(response.statusCode).toBe(413);
      const body = response.json();
      expect(body.error.code).toBe("ATTACHMENT_TOO_LARGE");
    });
  });

  describe("400 INVALID_ID for invalid note ID format", () => {
    it("returns 400 for non-hex note ID", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/notes/invalid-id",
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_ID");
    });
  });

  describe("400 INVALID_ID for invalid chunk ID format", () => {
    it("returns 400 for non-numeric chunk index", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/chunks/invalid/not-a-number",
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_ID");
    });
  });

  describe("403 PATH_OUTSIDE_VAULT for path traversal", () => {
    it("returns 403 for directory traversal in attachment path", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/attachments/..%2F..%2F..%2Fetc%2Fpasswd",
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error.code).toBe("PATH_OUTSIDE_VAULT");
    });
  });

  describe("403 ATTACHMENT_NOT_ALLOWED for markdown files", () => {
    it("returns 403 when requesting a .md file as an attachment", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/attachments/Welcome.md",
      });

      expect(response.statusCode).toBe(403);
      const body = response.json();
      expect(body.error.code).toBe("ATTACHMENT_NOT_ALLOWED");
    });
  });

  describe("503 EMBEDDING_UNAVAILABLE for explicit embedding mode", () => {
    it("returns 503 when embedding mode is requested but embeddings are not configured", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/search",
        payload: { query: "test", mode: "embedding" },
      });

      expect(response.statusCode).toBe(503);
      const body = response.json();
      expect(body.error.code).toBe("EMBEDDING_UNAVAILABLE");
    });
  });

  describe("404 NOTE_NOT_FOUND for related missing note", () => {
    it("returns 404 for valid-format but non-existent note ID", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/related",
        payload: {
          type: "note",
          id: "00000000000000000000000000000000",
        },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe("NOTE_NOT_FOUND");
    });
  });

  describe("404 CHUNK_NOT_FOUND for related missing chunk", () => {
    it("returns 404 for valid-format but non-existent chunk ID", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/related",
        payload: {
          type: "chunk",
          id: "00000000000000000000000000000000:0",
        },
      });

      expect(response.statusCode).toBe(404);
      const body = response.json();
      expect(body.error.code).toBe("CHUNK_NOT_FOUND");
    });
  });

  describe("Request ID in error responses", () => {
    it("includes requestId in error.details", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/search",
        payload: { query: "" },
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_QUERY");
      expect(body.error.details).toBeDefined();
      expect(body.error.details.requestId).toBeDefined();
    });
  });

  describe("POST /index with requireEmbeddings", () => {
    it("accepts requireEmbeddings in request body", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/index",
        payload: { requireEmbeddings: true },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.mode).toBeTruthy();
    });
  });

  describe("POST /reindex with requireEmbeddings", () => {
    it("accepts requireEmbeddings in request body", async () => {
      const response = await app.inject({
        method: "POST",
        url: "/reindex",
        payload: { requireEmbeddings: true },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.mode).toBeTruthy();
    });
  });
});

describe("Server Authentication", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-server-auth-idx-"),
    );
    config = createTestConfigWithApiKey(vaultDir, indexDir, "test-secret-key");

    await indexVault(config);

    const dbPath = path.join(
      indexDir,
      vaultIdentity(path.resolve(vaultDir)),
      "index.sqlite",
    );
    store = await IndexStore.open(dbPath);

    app = await createServer(config);
    initApp(store, config);
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

  it("returns 401 when no authorization header is provided", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 401 when wrong token is provided", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        authorization: "Bearer wrong-token",
      },
    });

    expect(response.statusCode).toBe(401);
    const body = response.json();
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 200 when correct token is provided", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        authorization: "Bearer test-secret-key",
      },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.status).toBe("ok");
  });

  it("returns 401 when authorization header has no Bearer prefix", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        authorization: "test-secret-key",
      },
    });

    expect(response.statusCode).toBe(401);
  });
});

describe("Server non-localhost access policy", () => {
  let vaultDir: string;
  let indexDir: string;

  beforeEach(() => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-server-access-"),
    );
  });

  afterEach(() => {
    resetApp();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("rejects non-localhost bind without an API key at route-server creation time", async () => {
    const remoteConfig = createTestConfig(vaultDir, indexDir);
    remoteConfig.server.host = "0.0.0.0";
    remoteConfig.server.apiKey = "";

    await expect(createServer(remoteConfig)).rejects.toThrow("API_KEY_REQUIRED");
  });

  it("rejects non-localhost bind with a short API key", async () => {
    const remoteConfig = createTestConfig(vaultDir, indexDir);
    remoteConfig.server.host = "0.0.0.0";
    remoteConfig.server.apiKey = "short";

    await expect(createServer(remoteConfig)).rejects.toThrow("API_KEY_REQUIRED");
  });

  it("generates and stores an API key only for the default user-local config path", () => {
    const remoteConfig = createTestConfig(vaultDir, indexDir);
    remoteConfig.server.host = "0.0.0.0";
    remoteConfig.server.apiKey = "";
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-default-config-"),
    );
    const configPath = path.join(configDir, "config.toml");

    try {
      const prepared = prepareServerAccessConfig(remoteConfig, {
        defaultConfigPathOverride: configPath,
      });

      expect(prepared.server.apiKey.length).toBeGreaterThanOrEqual(32);
      const written = fs.readFileSync(configPath, "utf-8");
      expect(written).toContain("api_key");
      expect(written).toContain(prepared.server.apiKey);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("does not generate an API key into a custom config path", () => {
    const remoteConfig = createTestConfig(vaultDir, indexDir);
    remoteConfig.server.host = "0.0.0.0";
    remoteConfig.server.apiKey = "";
    const configDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-custom-config-"),
    );
    const defaultConfigPath = path.join(configDir, "default", "config.toml");
    const customConfigPath = path.join(configDir, "custom", "config.toml");

    try {
      expect(() =>
        prepareServerAccessConfig(remoteConfig, {
          configPath: customConfigPath,
          defaultConfigPathOverride: defaultConfigPath,
        }),
      ).toThrow("API_KEY_REQUIRED");
      expect(fs.existsSync(customConfigPath)).toBe(false);
      expect(fs.existsSync(defaultConfigPath)).toBe(false);
    } finally {
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("Server startup index compatibility policy", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-startup-index-"),
    );
    config = createTestConfig(vaultDir, indexDir);
    await indexVault(config);
    const dbPath = path.join(
      indexDir,
      vaultIdentity(path.resolve(vaultDir)),
      "index.sqlite",
    );
    store = await IndexStore.open(dbPath);
  });

  afterEach(() => {
    try {
      store?.close();
    } catch {}
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("allows a compatible startup index without warnings", () => {
    const result = validateStartupIndexState(store, config);
    expect(result.usable).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("surfaces stale startup indexes with an INDEX_STALE warning", () => {
    config.vault.exclude = ["private/**"];
    const result = validateStartupIndexState(store, config);
    expect(result.usable).toBe(true);
    expect(result.warnings[0]?.code).toBe("INDEX_STALE");
  });

  it("rejects incompatible startup indexes", () => {
    const otherVaultDir = createTestVault();
    const otherConfig = createTestConfig(otherVaultDir, indexDir);

    try {
      expect(() => validateStartupIndexState(store, otherConfig)).toThrow(
        "INDEX_INCOMPATIBLE",
      );
    } finally {
      fs.rmSync(otherVaultDir, { recursive: true, force: true });
    }
  });
});

describe("Server without initialized store", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    resetApp();
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-server-nostore-"),
    );
    config = createTestConfig(vaultDir, indexDir);
    app = await createServer(config);
  });

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
    resetApp();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("returns degraded status on /health without store", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/health",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.status).toBe("degraded");
    expect(body.data.index.available).toBe(false);
  });

  it("returns 409 on /search without store", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/search",
      payload: { query: "test" },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe("INDEX_NOT_FOUND");
  });

  it("returns 409 on /related without store", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/related",
      payload: { type: "note", id: "test" },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe("INDEX_NOT_FOUND");
  });

  it("returns 409 on /index without store", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/index",
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe("INDEX_NOT_FOUND");
  });

  it("returns 409 on /chunks without store", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/chunks/someid/0",
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe("INDEX_NOT_FOUND");
  });
});

describe("Server with initialized store but no usable index", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    resetApp();
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-server-empty-index-"),
    );
    config = createTestConfig(vaultDir, indexDir);
    const dbPath = path.join(
      indexDir,
      vaultIdentity(path.resolve(vaultDir)),
      "index.sqlite",
    );
    store = await IndexStore.open(dbPath);
    app = await createServer(config);
    initApp(store, config);
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

  it("returns 409 INDEX_NOT_FOUND on /search", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/search",
      payload: { query: "test" },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe("INDEX_NOT_FOUND");
  });

  it("returns 409 INDEX_NOT_FOUND on /related", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/related",
      payload: {
        type: "note",
        id: "00000000000000000000000000000000",
      },
    });

    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe("INDEX_NOT_FOUND");
  });
});

describe("CORS empty origins rejection", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;

  beforeEach(() => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-server-cors-"),
    );
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("rejects cors.enabled=true with empty allowedOrigins", async () => {
    config = createTestConfig(vaultDir, indexDir);
    config.cors.enabled = true;
    config.cors.allowedOrigins = [];

    let didThrow = false;
    try {
      await createServer(config);
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);
  });
});

describe("CORS wildcard origins rejection", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;

  beforeEach(() => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-server-cors2-"),
    );
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("rejects cors.allowedOrigins containing wildcard *", async () => {
    config = createTestConfig(vaultDir, indexDir);
    config.cors.enabled = true;
    config.cors.allowedOrigins = ["*"];

    let didThrow = false;
    try {
      await createServer(config);
    } catch {
      didThrow = true;
    }
    expect(didThrow).toBe(true);
  });
});

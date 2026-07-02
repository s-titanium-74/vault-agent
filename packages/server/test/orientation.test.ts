import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer, initApp, resetApp } from "../src/index.js";
import {
  Config,
  DEFAULT_CONFIG,
  IndexStore,
  indexVault,
  getIndexPath,
} from "@vault-agent/core";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-orientation-server-vault-"),
  );

  fs.mkdirSync(path.join(vaultDir, "Projects"), { recursive: true });

  fs.writeFileSync(
    path.join(vaultDir, "Projects", "App.md"),
    `---
title: "App"
tags:
  - project
  - app
type: project
status: active
---

# App

App content.`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Guide.md"),
    `---
title: "Guide"
tags:
  - guide
---

# Guide

Guide content.`,
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

describe("Orientation Routes", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-orientation-server-idx-"),
    );
    config = createTestConfig(vaultDir, indexDir);

    await indexVault(config);

    const dbPath = getIndexPath(config);
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

  describe("GET /overview", () => {
    it("returns compact vault metadata", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/overview",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.noteCount).toBe(2);
      expect(body.data.topLevelFolders).toHaveLength(1);
      expect(body.data.topLevelFolders[0].path).toBe("Projects");
      expect(body.warnings).toEqual([]);
    });
  });

  describe("GET /tree", () => {
    it("returns bounded directory tree", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/tree?depth=2&limit=50",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.tree.path).toBe("");
      expect(body.data.tree.children).toHaveLength(1);
      expect(body.data.tree.children[0].path).toBe("Projects");
    });

    it("rejects invalid depth", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/tree?depth=11",
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_PARAMETER");
    });
  });

  describe("GET /tags", () => {
    it("returns tag counts", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/tags?limit=10",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.data.tags).toContainEqual({ tag: "project", noteCount: 1 });
    });

    it("rejects invalid limit", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/tags?limit=999",
      });

      expect(response.statusCode).toBe(400);
      const body = response.json();
      expect(body.error.code).toBe("INVALID_PARAMETER");
    });
  });

  describe("GET /facets", () => {
    it("returns allowlisted field values", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/facets?limit=10",
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      const typeField = body.data.fields.find(
        (f: { name: string }) => f.name === "type",
      );
      expect(typeField.values).toContainEqual({
        value: "project",
        noteCount: 1,
      });
    });
  });
});

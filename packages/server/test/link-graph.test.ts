import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer, initApp, resetApp } from "../src/index.js";
import {
  Config,
  DEFAULT_CONFIG,
  IndexStore,
  getIndexPath,
  indexVault,
  noteIdFromPath,
} from "@vault-agent/core";

function createLinkVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-link-server-vault-"),
  );
  fs.writeFileSync(path.join(vaultDir, "Index.md"), "# Index\n\n[[Plan]]");
  fs.writeFileSync(path.join(vaultDir, "Plan.md"), "# Plan\n\n[[Missing]]");
  fs.writeFileSync(path.join(vaultDir, "Orphan.md"), "# Orphan\n");
  return vaultDir;
}

function createConfig(vaultRoot: string, indexDir: string): Config {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    vault: { root: vaultRoot, exclude: [] },
    server: { ...DEFAULT_CONFIG.server },
    index: { dir: indexDir },
    embedding: { ...DEFAULT_CONFIG.embedding },
    cors: { ...DEFAULT_CONFIG.cors },
  };
}

describe("Link graph routes", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    vaultDir = createLinkVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-link-server-idx-"),
    );
    config = createConfig(vaultDir, indexDir);
    await indexVault(config);
    store = await IndexStore.open(getIndexPath(config));
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

  it("returns note links", async () => {
    const planId = noteIdFromPath("Plan.md");
    const response = await app.inject({
      method: "GET",
      url: `/links/notes/${planId}`,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.path).toBe("Plan.md");
    expect(body.data.outlinks[0]).toMatchObject({
      rawTarget: "Missing",
      resolved: false,
    });
    expect(body.data.backlinks[0]).toMatchObject({
      sourcePath: "Index.md",
      targetPath: "Plan.md",
    });
    expect(body.warnings).toEqual([]);
  });

  it("returns broken links and orphan notes", async () => {
    const broken = await app.inject({
      method: "GET",
      url: "/links/broken?limit=10",
    });
    expect(broken.statusCode).toBe(200);
    expect(broken.json().data.total).toBe(1);

    const orphans = await app.inject({
      method: "GET",
      url: "/links/orphans?limit=10",
    });
    expect(orphans.statusCode).toBe(200);
    expect(
      orphans.json().data.notes.map((note: { path: string }) => note.path),
    ).toEqual(["Orphan.md"]);
  });

  it("returns link summary", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/links/summary?limit=5",
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.noteCount).toBe(3);
    expect(body.data.resolvedLinkCount).toBe(1);
    expect(body.data.unresolvedLinkCount).toBe(1);
  });

  it("rejects invalid note IDs", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/links/notes/not-a-note-id",
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_ID");
  });
});

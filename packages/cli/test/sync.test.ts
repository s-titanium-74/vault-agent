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
    path.join(os.tmpdir(), "vault-agent-cli-sync-vault-"),
  );
  fs.writeFileSync(path.join(vaultDir, "Welcome.md"), "# Welcome\n\nHello.");
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

describe("CLI sync command HTTP integration", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;
  let port: number;
  let baseUrl: string;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-cli-sync-idx-"),
    );
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

  it("GET /status sync section returns valid JSON when reachable", async () => {
    const res = await fetch(`${baseUrl}/status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    const sync = data.data.sync;
    expect(sync).toBeDefined();
    expect(sync).toHaveProperty("enabled");
    expect(sync).toHaveProperty("configured");
  });

  it("POST /sync/pull returns actionable error when sync is not configured", async () => {
    const res = await fetch(`${baseUrl}/sync/pull`, { method: "POST" });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.code).toBe("SYNC_NOT_CONFIGURED");
  });

  it("POST /sync/pull with wait=true returns actionable error when not configured", async () => {
    const res = await fetch(`${baseUrl}/sync/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wait: true, timeoutSeconds: 60 }),
    });
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.error.code).toBe("SYNC_NOT_CONFIGURED");
  });

  it("status JSON does not expose remote URL by default", async () => {
    const res = await fetch(`${baseUrl}/status`);
    const data = await res.json();
    const statusStr = JSON.stringify(data);
    expect(statusStr).not.toContain("https://");
    expect(statusStr).not.toContain("git@");
  });
});

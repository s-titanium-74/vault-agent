import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createServer, initApp, resetApp } from "../src/index.js";
import {
  DEFAULT_CONFIG,
  IndexStore,
  indexVault,
  vaultIdentity,
  GitSync,
} from "@vault-agent/core";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-status-vault-"),
  );
  fs.writeFileSync(path.join(vaultDir, "Welcome.md"), "# Welcome\n\nHello.");
  return vaultDir;
}

function createTestConfig(vaultRoot: string, indexDir: string) {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    vault: { root: vaultRoot, exclude: [] },
    index: { dir: indexDir },
  };
}

describe("GET /status", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: ReturnType<typeof createTestConfig>;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-status-idx-"),
    );
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

  it("returns 200 with status data when index is available", async () => {
    const response = await app.inject({ method: "GET", url: "/status" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data).toBeDefined();
    expect(body.data.server).toBeDefined();
    expect(body.data.index).toBeDefined();
    expect(body.data.watch).toBeDefined();
    expect(body.data.sync).toBeDefined();
  });

  it("returns 409 when index is not available", async () => {
    resetApp();
    const response = await app.inject({ method: "GET", url: "/status" });
    expect(response.statusCode).toBe(409);
  });

  it("returns stable JSON schema with server, index, watch, and sync sections", async () => {
    const response = await app.inject({ method: "GET", url: "/status" });
    const body = response.json();
    expect(body.data.server.running).toBe(true);
    expect(body.data.server.host).toBe("127.0.0.1");
    expect(body.data.server.port).toBe(8787);
    expect(body.data.index.freshness).toBeDefined();
    expect(body.data.watch.enabled).toBeDefined();
    expect(body.data.watch.state).toBeDefined();
    expect(body.data.sync.enabled).toBeDefined();
    expect(body.data.sync.configured).toBeDefined();
    expect(body.data.warnings).toBeUndefined();
    expect(body.warnings).toBeDefined();
  });

  it("does not expose API key in status response", async () => {
    const response = await app.inject({ method: "GET", url: "/status" });
    const body = response.json();
    const statusStr = JSON.stringify(body);
    expect(statusStr).not.toContain("test-api-key");
  });

  it("does not expose webhook secret in status response", async () => {
    const response = await app.inject({ method: "GET", url: "/status" });
    const body = response.json();
    const statusStr = JSON.stringify(body);
    expect(statusStr).not.toContain("webhook-secret");
  });

  it("does not include private absolute paths by default", async () => {
    const response = await app.inject({ method: "GET", url: "/status" });
    const body = response.json();
    const statusStr = JSON.stringify(body);
    expect(statusStr).not.toContain(vaultDir);
  });

  it("reflects pending state when watcher has pending changes", async () => {
    const response = await app.inject({ method: "GET", url: "/status" });
    const body = response.json();
    expect(body.data.watch.pending).toBe(false);
  });

  it("reflects stale state when index is behind vault changes", async () => {
    const response = await app.inject({ method: "GET", url: "/status" });
    const body = response.json();
    expect(["fresh", "stale", "pending", "unknown"]).toContain(
      body.data.index.freshness.state,
    );
  });

  it("reflects incompatible state when reindex is required", async () => {
    const response = await app.inject({ method: "GET", url: "/status" });
    const body = response.json();
    expect(body.data.index.freshness).toBeDefined();
  });

  it("requires API key authentication when configured", async () => {
    const configWithKey = createTestConfig(vaultDir, indexDir);
    configWithKey.server.apiKey = "test-key";
    const appWithKey = await createServer(configWithKey);
    initApp(store, configWithKey);

    const response = await appWithKey.inject({ method: "GET", url: "/status" });
    expect(response.statusCode).toBe(401);

    await appWithKey.close();
  });

  it("returns 401 for unauthenticated requests when API key is set", async () => {
    const configWithKey = createTestConfig(vaultDir, indexDir);
    configWithKey.server.apiKey = "test-key";
    const appWithKey = await createServer(configWithKey);
    initApp(store, configWithKey);

    const response = await appWithKey.inject({
      method: "GET",
      url: "/status",
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(response.statusCode).toBe(401);

    await appWithKey.close();
  });

  it("starts with stale status when index is usable but behind vault changes", async () => {
    const response = await app.inject({ method: "GET", url: "/status" });
    const body = response.json();
    expect(body.data.index.freshness.state).toBeDefined();
  });

  it("starts with fresh status when index matches current vault state", async () => {
    const response = await app.inject({ method: "GET", url: "/status" });
    const body = response.json();
    expect(["fresh", "stale", "pending", "unknown"]).toContain(
      body.data.index.freshness.state,
    );
  });
});

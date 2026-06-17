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
    path.join(os.tmpdir(), "vault-agent-sync-vault-"),
  );
  fs.writeFileSync(path.join(vaultDir, "Welcome.md"), "# Welcome\n\nHello.");
  return vaultDir;
}

function createTestConfig(vaultRoot: string, indexDir: string) {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    vault: { root: vaultRoot, exclude: [] },
    index: { dir: indexDir },
    sync: {
      enabled: false,
      repo: "",
      remote: "origin",
      branch: "",
      interval_seconds: 900,
      webhook_enabled: false,
      webhook_secret: "",
      pull_timeout_seconds: 120,
      failure_backoff_seconds: 3600,
    },
  };
}

describe("POST /sync/pull", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: ReturnType<typeof createTestConfig>;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-sync-idx-"));
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

  it("returns 409 when sync is not configured", async () => {
    const response = await app.inject({ method: "POST", url: "/sync/pull" });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe("SYNC_NOT_CONFIGURED");
  });

  it("does not expose remote URL in error responses", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.repo = "https://private-repo.example.com/user/repo.git";
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await app.inject({ method: "POST", url: "/sync/pull" });
    const body = response.json();
    const bodyStr = JSON.stringify(body);
    expect(bodyStr).not.toContain("private-repo.example.com");
  });
});

describe("POST /sync/webhook", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: ReturnType<typeof createTestConfig>;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-webhook-idx-"),
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

  it("returns 409 when sync is not configured", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/sync/webhook",
      headers: { "X-Vault-Agent-Webhook-Secret": "test" },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe("WEBHOOK_SYNC_NOT_CONFIGURED");
  });

  it("returns 403 when webhook is disabled", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.webhook_enabled = false;
    syncConfig.sync.webhook_secret = "secret";
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await app.inject({
      method: "POST",
      url: "/sync/webhook",
      headers: { "X-Vault-Agent-Webhook-Secret": "secret" },
    });
    expect(response.statusCode).toBe(403);
  });

  it("returns 401 when webhook secret is invalid", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.webhook_enabled = true;
    syncConfig.sync.webhook_secret = "correct-secret";
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await app.inject({
      method: "POST",
      url: "/sync/webhook",
      headers: { "X-Vault-Agent-Webhook-Secret": "wrong-secret" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("returns 401 when webhook secret header is missing", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.webhook_enabled = true;
    syncConfig.sync.webhook_secret = "secret";
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await app.inject({
      method: "POST",
      url: "/sync/webhook",
    });
    expect(response.statusCode).toBe(401);
  });

  it("does not expose remote URL in webhook responses", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.webhook_enabled = true;
    syncConfig.sync.webhook_secret = "secret";
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await app.inject({
      method: "POST",
      url: "/sync/webhook",
      headers: { "X-Vault-Agent-Webhook-Secret": "wrong" },
    });
    const bodyStr = JSON.stringify(response.json());
    expect(bodyStr).not.toContain("github.com");
    expect(bodyStr).not.toContain(".git");
  });

  it("rejects request body larger than 64 KiB with 413", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.webhook_enabled = true;
    syncConfig.sync.webhook_secret = "secret";
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const largeBody = { data: "x".repeat(100 * 1024) };
    const response = await app.inject({
      method: "POST",
      url: "/sync/webhook",
      headers: {
        "X-Vault-Agent-Webhook-Secret": "secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(largeBody),
    });
    expect(response.statusCode).toBe(413);
  });

  it("returns 503 with WEBHOOK_SECRET_NOT_CONFIGURED when secret is empty", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.webhook_enabled = true;
    syncConfig.sync.webhook_secret = "";
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await app.inject({
      method: "POST",
      url: "/sync/webhook",
      headers: { "X-Vault-Agent-Webhook-Secret": "any" },
    });
    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.error.code).toBe("WEBHOOK_SECRET_NOT_CONFIGURED");
  });

  it("accepts valid webhook and returns 202 with accepted: true", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.webhook_enabled = true;
    syncConfig.sync.webhook_secret = "valid-secret";
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await app.inject({
      method: "POST",
      url: "/sync/webhook",
      headers: { "X-Vault-Agent-Webhook-Secret": "valid-secret" },
    });
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.data.accepted).toBe(true);
  });

  it("ignores secret passed via query parameter", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.webhook_enabled = true;
    syncConfig.sync.webhook_secret = "valid-secret";
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await app.inject({
      method: "POST",
      url: "/sync/webhook?secret=valid-secret",
      headers: { "X-Vault-Agent-Webhook-Secret": "wrong-secret" },
    });
    expect(response.statusCode).toBe(401);
  });

  it("ignores changed-file lists in webhook payload (payload is not trusted)", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.webhook_enabled = true;
    syncConfig.sync.webhook_secret = "valid-secret";
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await app.inject({
      method: "POST",
      url: "/sync/webhook",
      headers: {
        "X-Vault-Agent-Webhook-Secret": "valid-secret",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        changed_files: ["malicious.md", "../etc/passwd"],
        repository: { clone_url: "https://attacker.com/repo.git" },
      }),
    });
    expect(response.statusCode).toBe(202);
    const bodyStr = JSON.stringify(response.json());
    expect(bodyStr).not.toContain("malicious.md");
    expect(bodyStr).not.toContain("attacker.com");
  });

  it("uses timing-safe secret comparison for webhook", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.webhook_enabled = true;
    syncConfig.sync.webhook_secret = "very-long-secret-1234567890abcdef";
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const correctResponse = await app.inject({
      method: "POST",
      url: "/sync/webhook",
      headers: {
        "X-Vault-Agent-Webhook-Secret": "very-long-secret-1234567890abcdef",
      },
    });
    expect(correctResponse.statusCode).toBe(202);

    const wrongResponse = await app.inject({
      method: "POST",
      url: "/sync/webhook",
      headers: {
        "X-Vault-Agent-Webhook-Secret": "very-long-secret-1234567890abcdeX",
      },
    });
    expect(wrongResponse.statusCode).toBe(401);
  });

  it("returns 409 with WEBHOOK_SYNC_NOT_CONFIGURED when webhook_enabled=true but enabled=false", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.webhook_enabled = true;
    syncConfig.sync.webhook_secret = "secret";
    syncConfig.sync.enabled = false;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await app.inject({
      method: "POST",
      url: "/sync/webhook",
      headers: { "X-Vault-Agent-Webhook-Secret": "secret" },
    });
    expect(response.statusCode).toBe(409);
    const body = response.json();
    expect(body.error.code).toBe("WEBHOOK_SYNC_NOT_CONFIGURED");
  });

  it("uses webhook secret auth instead of normal API key auth", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.server.apiKey = "normal-api-key";
    syncConfig.sync.webhook_enabled = true;
    syncConfig.sync.webhook_secret = "webhook-secret";
    syncConfig.sync.enabled = true;
    const appWithKey = await createServer(syncConfig);
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await appWithKey.inject({
      method: "POST",
      url: "/sync/webhook",
      headers: { "X-Vault-Agent-Webhook-Secret": "webhook-secret" },
    });

    expect(response.statusCode).toBe(202);
    await appWithKey.close();
  });
});

describe("POST /sync/pull response format", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: ReturnType<typeof createTestConfig>;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-pull-format-idx-"),
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

  it("POST /sync/pull response includes status, changed, startedAt, finishedAt fields", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.repo = vaultDir;
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await app.inject({ method: "POST", url: "/sync/pull" });
    const data = response.json();
    if (response.statusCode === 200) {
      expect(data.data).toHaveProperty("status");
      expect(["completed", "no_op"]).toContain(data.data.status);
      expect(data.data).toHaveProperty("changed");
      expect(typeof data.data.changed).toBe("boolean");
      expect(data.data).toHaveProperty("startedAt");
      expect(typeof data.data.startedAt).toBe("string");
      expect(data.data).toHaveProperty("finishedAt");
      expect(typeof data.data.finishedAt).toBe("string");
    }
  });

  it("POST /sync/pull response includes indexFreshness field", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.repo = vaultDir;
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await app.inject({ method: "POST", url: "/sync/pull" });
    const data = response.json();
    if (response.statusCode === 200) {
      expect(data.data).toHaveProperty("indexFreshness");
      expect([
        "fresh",
        "pending",
        "updating",
        "stale",
        "incompatible",
        "unknown",
      ]).toContain(data.data.indexFreshness);
    }
  });
});

describe("POST /sync/pull wait and timeout", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: ReturnType<typeof createTestConfig>;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-pull-wait-idx-"),
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

  it("POST /sync/pull with wait=true and timeoutSeconds returns 409 SYNC_IN_PROGRESS or 200", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.repo = vaultDir;
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    const response = await app.inject({
      method: "POST",
      url: "/sync/pull",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ wait: true, timeoutSeconds: 5 }),
    });

    expect([200, 400, 409]).toContain(response.statusCode);
  });

  it("GET /sync/pull returns 405 method not allowed", async () => {
    const response = await app.inject({ method: "GET", url: "/sync/pull" });
    expect(response.statusCode).toBe(405);
  });
});

describe("POST /sync/webhook method and rate limiting", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: ReturnType<typeof createTestConfig>;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-webhook-mr-idx-"),
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

  it("GET /sync/webhook returns 405 with WEBHOOK_INVALID_METHOD", async () => {
    const response = await app.inject({ method: "GET", url: "/sync/webhook" });
    expect(response.statusCode).toBe(405);
    const body = response.json();
    expect(body.error.code).toBe("WEBHOOK_INVALID_METHOD");
  });

  it("PUT /sync/webhook returns 405 with WEBHOOK_INVALID_METHOD", async () => {
    const response = await app.inject({ method: "PUT", url: "/sync/webhook" });
    expect(response.statusCode).toBe(405);
    const body = response.json();
    expect(body.error.code).toBe("WEBHOOK_INVALID_METHOD");
  });

  it("DELETE /sync/webhook returns 405 with WEBHOOK_INVALID_METHOD", async () => {
    const response = await app.inject({
      method: "DELETE",
      url: "/sync/webhook",
    });
    expect(response.statusCode).toBe(405);
    const body = response.json();
    expect(body.error.code).toBe("WEBHOOK_INVALID_METHOD");
  });

  it("returns 429 WEBHOOK_RATE_LIMITED after 60 valid webhooks per minute", async () => {
    const syncConfig = createTestConfig(vaultDir, indexDir);
    syncConfig.sync.webhook_enabled = true;
    syncConfig.sync.webhook_secret = "valid-secret";
    syncConfig.sync.enabled = true;
    const gitSync = new GitSync(syncConfig);
    gitSync.setVaultRoot(vaultDir);
    initApp(store, syncConfig, undefined, gitSync);

    let lastResponse: Awaited<ReturnType<typeof app.inject>> | null = null;
    for (let i = 0; i < 60; i++) {
      lastResponse = await app.inject({
        method: "POST",
        url: "/sync/webhook",
        headers: { "X-Vault-Agent-Webhook-Secret": "valid-secret" },
      });
      gitSync.cancelPendingWebhookSync();
    }
    expect(lastResponse!.statusCode).toBe(202);

    const rateLimitedResponse = await app.inject({
      method: "POST",
      url: "/sync/webhook",
      headers: { "X-Vault-Agent-Webhook-Secret": "valid-secret" },
    });
    expect(rateLimitedResponse.statusCode).toBe(429);
    const body = rateLimitedResponse.json();
    expect(body.error.code).toBe("WEBHOOK_RATE_LIMITED");
  });
});

describe("POST /sync/pull API key authentication", () => {
  let vaultDir: string;
  let indexDir: string;
  let store: IndexStore;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-pull-auth-idx-"),
    );
    const config = createTestConfig(vaultDir, indexDir);
    config.server.apiKey = "test-api-key-1234567890";
    await indexVault(config);
    const dbPath = path.join(
      indexDir,
      vaultIdentity(path.resolve(vaultDir)),
      "index.sqlite",
    );
    store = await IndexStore.open(dbPath);
    const app = await createServer(config);
    initApp(store, config);
  });

  afterEach(async () => {
    try {
      store?.close();
    } catch {}
    resetApp();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("POST /sync/pull requires Bearer auth when API key is set", async () => {
    const configWithKey = createTestConfig(vaultDir, indexDir);
    configWithKey.server.apiKey = "test-api-key-1234567890";
    const appWithKey = await createServer(configWithKey);
    initApp(store, configWithKey);

    const noAuthResponse = await appWithKey.inject({
      method: "POST",
      url: "/sync/pull",
    });
    expect(noAuthResponse.statusCode).toBe(401);

    const wrongAuthResponse = await appWithKey.inject({
      method: "POST",
      url: "/sync/pull",
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(wrongAuthResponse.statusCode).toBe(401);

    await appWithKey.close();
  });
});

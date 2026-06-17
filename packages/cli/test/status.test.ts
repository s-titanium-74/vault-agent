import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import { createServer, initApp, resetApp } from "../../server/src/index.js";
import { registerStatusCommands } from "../src/commands/status.js";
import { CliContext } from "../src/context.js";
import {
  Config,
  DEFAULT_CONFIG,
  IndexStore,
  indexVault,
  vaultIdentity,
} from "@vault-agent/core";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-cli-status-vault-"),
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

describe("CLI status commands against running server", () => {
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
      path.join(os.tmpdir(), "vault-agent-cli-status-idx-"),
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

  it("GET /status returns stable JSON when server is reachable", async () => {
    const res = await fetch(`${baseUrl}/status`);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data).toBeDefined();
    expect(data.data.server).toBeDefined();
    expect(data.data.server.running).toBe(true);
    expect(data.data.index).toBeDefined();
    expect(data.data.index.freshness).toBeDefined();
    expect(data.data.watch).toBeDefined();
    expect(data.data.sync).toBeDefined();
  });

  it("status JSON includes required index fields", async () => {
    const res = await fetch(`${baseUrl}/status`);
    const data = await res.json();
    const index = data.data.index;
    const freshness = index.freshness;
    expect(freshness).toHaveProperty("state");
    expect(freshness).toHaveProperty("lastSuccessfulUpdateAt");
    expect(freshness).toHaveProperty("pendingChangeCount");
    expect(freshness).toHaveProperty("reindexRequired");
    expect(freshness).toHaveProperty("reindexReasons");
    expect(index).toHaveProperty("embeddingState");
  });

  it("status JSON includes required watch fields", async () => {
    const res = await fetch(`${baseUrl}/status`);
    const data = await res.json();
    const watch = data.data.watch;
    expect(watch).toHaveProperty("enabled");
    expect(watch).toHaveProperty("state");
    expect(watch).toHaveProperty("lastEventAt");
    expect(watch).toHaveProperty("pending");
    expect(watch).toHaveProperty("lastError");
  });

  it("status JSON includes required sync fields", async () => {
    const res = await fetch(`${baseUrl}/status`);
    const data = await res.json();
    const sync = data.data.sync;
    expect(sync).toHaveProperty("enabled");
    expect(sync).toHaveProperty("configured");
    expect(sync).toHaveProperty("state");
    expect(sync).toHaveProperty("pending");
    expect(sync).toHaveProperty("lastSuccessfulSyncAt");
    expect(sync).toHaveProperty("consecutiveFailures");
    expect(sync).toHaveProperty("lastError");
  });

  it("status JSON does not include private absolute paths by default", async () => {
    const res = await fetch(`${baseUrl}/status`);
    const data = await res.json();
    const statusStr = JSON.stringify(data);
    expect(statusStr).not.toContain(vaultDir);
  });

  it("status JSON does not include API keys or webhook secrets", async () => {
    const configWithSecrets = createTestConfig(vaultDir, indexDir);
    configWithSecrets.server.apiKey = "secret-api-key-12345";
    configWithSecrets.sync.webhook_secret = "secret-webhook-67890";
    resetApp();
    const store2 = await IndexStore.open(
      path.join(
        indexDir,
        vaultIdentity(path.resolve(vaultDir)),
        "index.sqlite",
      ),
    );
    const app2 = await createServer(configWithSecrets);
    initApp(store2, configWithSecrets);
    const address = await app2.listen({ port: 0, host: "127.0.0.1" });
    const match = address.match(/:(\d+)$/);
    const port2 = match ? parseInt(match[1]!, 10) : 0;

    const res = await fetch(`http://127.0.0.1:${port2}/status`, {
      headers: { Authorization: "Bearer secret-api-key-12345" },
    });
    const data = await res.json();
    const statusStr = JSON.stringify(data);
    expect(statusStr).not.toContain("secret-api-key-12345");
    expect(statusStr).not.toContain("secret-webhook-67890");

    await app2.close();
    store2.close();
  });
});

describe("CLI status JSON when server is unreachable", () => {
  it("status command returns stable JSON with server.running=false and warning", async () => {
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test-vault";
    const ctx: CliContext = {
      resolveConfigPath: () => "/tmp/nonexistent-config.toml",
      resolveEndpoint: () => "http://127.0.0.1:1",
      resolveApiKey: () => "",
    };

    const program = new Command();
    program.exitOverride();
    registerStatusCommands(program, ctx);

    const stdoutLines: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map((a) => String(a)).join(" "));
    };
    process.exit = (() => {
      throw new Error("EXIT_CALLED");
    }) as never;

    try {
      try {
        await program.parseAsync(["node", "vault-agent", "status", "--json"]);
      } catch (e) {
        // expected: process.exit throws
      }
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
      delete process.env.VAULT_AGENT_VAULT_ROOT;
    }

    const stdout = stdoutLines.join("\n");
    const parsed = JSON.parse(stdout);
    expect(parsed.data.server.running).toBe(false);
    expect(parsed.data.server.endpoint).toBe("http://127.0.0.1:1");
    expect(parsed.data.index).toBeNull();
    expect(parsed.data.watch).toBeNull();
    expect(parsed.data.sync).toBeNull();
    expect(parsed.warnings).toBeDefined();
    expect(parsed.warnings.length).toBeGreaterThan(0);
    expect(parsed.warnings[0].code).toBe("SERVER_UNREACHABLE");
  });

  it("watch status command returns stable JSON with warning when server is unreachable", async () => {
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test-vault";
    const ctx: CliContext = {
      resolveConfigPath: () => "/tmp/nonexistent-config.toml",
      resolveEndpoint: () => "http://127.0.0.1:1",
      resolveApiKey: () => "",
    };

    const program = new Command();
    program.exitOverride();
    registerStatusCommands(program, ctx);

    const stdoutLines: string[] = [];
    const originalLog = console.log;
    const originalExit = process.exit;
    console.log = (...args: unknown[]) => {
      stdoutLines.push(args.map((a) => String(a)).join(" "));
    };
    process.exit = (() => {
      throw new Error("EXIT_CALLED");
    }) as never;

    try {
      try {
        await program.parseAsync([
          "node",
          "vault-agent",
          "watch",
          "status",
          "--json",
        ]);
      } catch (e) {
        // expected: process.exit throws
      }
    } finally {
      console.log = originalLog;
      process.exit = originalExit;
      delete process.env.VAULT_AGENT_VAULT_ROOT;
    }

    const stdout = stdoutLines.join("\n");
    const parsed = JSON.parse(stdout);
    expect(parsed.data.watch.state).toBe("unknown");
    expect(parsed.warnings[0].code).toBe("SERVER_UNREACHABLE");
  });
});

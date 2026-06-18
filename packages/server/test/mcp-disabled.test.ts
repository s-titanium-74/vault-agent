import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import Fastify from "fastify";
import {
  Config,
  DEFAULT_CONFIG,
  IndexStore,
  indexVault,
  vaultIdentity,
  FreshnessMachine,
} from "@vault-agent/core";
import { createServer } from "../src/index.js";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-mcp-disabled-vault-"),
  );
  fs.writeFileSync(
    path.join(vaultDir, "Welcome.md"),
    `# Welcome Note\n\nThis is a demonstration vault for MCP disabled testing.`,
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
    mcp: { enabled: false, http: { endpoint: "/mcp" } },
  };
}

describe("MCP disabled server", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-mcp-disabled-idx-"),
    );
    config = createTestConfig(vaultDir, indexDir);
    await indexVault(config);

    const dbPath = path.join(
      indexDir,
      vaultIdentity(path.resolve(vaultDir)),
      "index.sqlite",
    );
    store = await IndexStore.open(dbPath);

    const freshnessMachine = new FreshnessMachine();
    freshnessMachine.transition("fresh", "Startup check passed");

    app = await createServer(config, {
      store,
      config,
      embeddingProvider: null,
      freshnessMachine,
    });
  });

  afterEach(async () => {
    try {
      await app?.close();
    } catch {}
    try {
      store?.close();
    } catch {}
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("does not expose /mcp when mcp.enabled is false", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "0.1.0" },
        },
      }),
    });

    expect(response.statusCode).toBe(404);
  });
});

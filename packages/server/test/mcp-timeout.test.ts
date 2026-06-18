import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type { Config, SearchResult } from "@vault-agent/core";
import {
  IndexStore,
  DEFAULT_CONFIG,
  indexVault,
  vaultIdentity,
  FreshnessMachine,
} from "@vault-agent/core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createMcpServer, setMcpToolTimeoutMs } from "../src/mcp/adapter.js";

vi.mock("@vault-agent/core", async (importOriginal) => {
  const original = await importOriginal<typeof import("@vault-agent/core")>();
  return {
    ...original,
    search: vi.fn(
      async (): Promise<SearchResult> =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                requestedMode: "lexical",
                usedMode: "lexical",
                limit: 10,
                results: [],
                warnings: [],
              }),
            100,
          ),
        ),
    ),
  };
});

class InMemoryTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  other?: InMemoryTransport;

  async start(): Promise<void> {}

  async close(): Promise<void> {
    this.onclose?.();
    this.other?.onclose?.();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.other?.onmessage?.(message);
  }
}

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-mcp-timeout-vault-"),
  );
  fs.writeFileSync(
    path.join(vaultDir, "Welcome.md"),
    `# Welcome Note\n\nThis is a demonstration vault for MCP timeout testing.`,
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

describe("MCP tool invocation timeout", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;

  beforeEach(async () => {
    setMcpToolTimeoutMs(10);

    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-mcp-timeout-idx-"),
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
    setMcpToolTimeoutMs(60_000);
    try {
      store?.close();
    } catch {}
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("returns TIMEOUT when a tool invocation exceeds the timeout", async () => {
    const freshnessMachine = new FreshnessMachine();
    freshnessMachine.transition("fresh", "Startup check passed");

    const serverTransport = new InMemoryTransport();
    const clientTransport = new InMemoryTransport();
    serverTransport.other = clientTransport;
    clientTransport.other = serverTransport;

    const server = createMcpServer({
      store,
      config,
      embeddingProvider: null,
      freshnessMachine,
    });
    await server.connect(serverTransport);

    const client = new Client(
      { name: "test", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      await client.callTool({
        name: "search",
        arguments: { query: "test" },
      });
      expect.fail("Expected callTool to throw");
    } catch (error: unknown) {
      console.log("CAUGHT ERROR:", JSON.stringify(error, null, 2));
      const err = error as Record<string, unknown>;
      expect(err.code).toBe(-32012);
      expect((err.data as Record<string, unknown>).errorCode).toBe("TIMEOUT");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import Fastify from "fastify";
import {
  Config,
  DEFAULT_CONFIG,
  IndexStore,
  indexVault,
  vaultIdentity,
  FreshnessMachine,
} from "@vault-agent/core";
import { createMcpServer, McpAdapterContext } from "../src/mcp/adapter.js";
import { registerMcpStreamableHttpRoute } from "../src/mcp/streamable-http.js";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-mcp-http-vault-"),
  );
  fs.writeFileSync(
    path.join(vaultDir, "Welcome.md"),
    `# Welcome Note\n\nThis is a demonstration vault for MCP Streamable HTTP testing.`,
  );
  return vaultDir;
}

function patchMockSocketDestroySoon(app: ReturnType<typeof Fastify>): void {
  app.addHook("onRequest", async (request) => {
    const socket = request.raw.socket as
      | import("node:net").Socket
      | undefined
      | null;
    if (socket && typeof socket.destroySoon !== "function") {
      (socket as { destroySoon?: () => void }).destroySoon = () => {
        if (typeof socket.destroy === "function") {
          socket.destroy();
        }
      };
    }
  });
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

describe("MCP Streamable HTTP Route", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;
  let app: ReturnType<typeof Fastify>;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-mcp-http-idx-"),
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

    const context: McpAdapterContext = {
      store,
      config,
      embeddingProvider: null,
      freshnessMachine,
    };
    app = Fastify({ logger: false });
    registerMcpStreamableHttpRoute(app, {
      endpoint: "/mcp",
      createMcpServer: () => createMcpServer(context),
      transportOptions: { enableJsonResponse: true },
    });
    patchMockSocketDestroySoon(app);

    await app.ready();
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

  it("responds to POST /mcp with initialization", async () => {
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

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.jsonrpc).toBe("2.0");
    expect(body.id).toBe(1);
    expect(body.result.protocolVersion).toBe("2025-03-26");
    expect(body.result.serverInfo.name).toBe("vault-agent");
  });

  it("returns JSON-RPC auth error when API key is missing", async () => {
    const freshMachine = new FreshnessMachine();
    freshMachine.transition("fresh", "Startup check passed");
    const authContext = {
      store,
      config,
      embeddingProvider: null,
      freshnessMachine: freshMachine,
    };
    const authApp = Fastify({ logger: false });
    registerMcpStreamableHttpRoute(authApp, {
      endpoint: "/mcp",
      createMcpServer: () => createMcpServer(authContext),
      apiKey: "secret-key",
      transportOptions: { enableJsonResponse: true },
    });
    patchMockSocketDestroySoon(authApp);
    await authApp.ready();

    const response = await authApp.inject({
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

    expect(response.statusCode).toBe(401);
    const body = JSON.parse(response.payload);
    expect(body.error.code).toBe(-32020);
    expect(body.error.data.errorCode).toBe("AUTH_REQUIRED");

    await authApp.close();
  });

  it("returns JSON-RPC auth error when API key is invalid", async () => {
    const freshMachine = new FreshnessMachine();
    freshMachine.transition("fresh", "Startup check passed");
    const authContext = {
      store,
      config,
      embeddingProvider: null,
      freshnessMachine: freshMachine,
    };
    const authApp = Fastify({ logger: false });
    registerMcpStreamableHttpRoute(authApp, {
      endpoint: "/mcp",
      createMcpServer: () => createMcpServer(authContext),
      apiKey: "secret-key",
      transportOptions: { enableJsonResponse: true },
    });
    patchMockSocketDestroySoon(authApp);
    await authApp.ready();

    const response = await authApp.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: "Bearer wrong-key",
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

    expect(response.statusCode).toBe(403);
    const body = JSON.parse(response.payload);
    expect(body.error.code).toBe(-32021);
    expect(body.error.data.errorCode).toBe("AUTH_FAILED");

    await authApp.close();
  });

  it("rejects unsupported protocol version with JSON-RPC -32600", async () => {
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
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test", version: "0.1.0" },
        },
      }),
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error.code).toBe(-32600);
  });

  it("rejects missing protocolVersion with JSON-RPC -32600", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test", version: "0.1.0" },
        },
      }),
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error.code).toBe(-32600);
  });

  it("rejects malformed JSON with JSON-RPC -32700", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      payload: "{ invalid json",
    });

    expect(response.statusCode).toBe(400);
    const body = JSON.parse(response.payload);
    expect(body.error.code).toBe(-32700);
  });

  it("supports concurrent independent sessions", async () => {
    const [initA, initB] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: JSON.stringify({
          jsonrpc: "2.0",
          id: 10,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test-a", version: "0.1.0" },
          },
        }),
      }),
      app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        payload: JSON.stringify({
          jsonrpc: "2.0",
          id: 20,
          method: "initialize",
          params: {
            protocolVersion: "2025-03-26",
            capabilities: {},
            clientInfo: { name: "test-b", version: "0.1.0" },
          },
        }),
      }),
    ]);

    expect(initA.statusCode).toBe(200);
    expect(initB.statusCode).toBe(200);

    const bodyA = JSON.parse(initA.payload);
    const bodyB = JSON.parse(initB.payload);
    const sessionIdA = initA.headers["mcp-session-id"];
    const sessionIdB = initB.headers["mcp-session-id"];

    expect(bodyA.id).toBe(10);
    expect(bodyB.id).toBe(20);
    expect(sessionIdA).toBeDefined();
    expect(sessionIdB).toBeDefined();
    expect(sessionIdA).not.toBe(sessionIdB);

    const [listA, listB] = await Promise.all([
      app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": String(sessionIdA),
          "mcp-protocol-version": "2025-03-26",
        },
        payload: JSON.stringify({
          jsonrpc: "2.0",
          id: 11,
          method: "tools/list",
        }),
      }),
      app.inject({
        method: "POST",
        url: "/mcp",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-session-id": String(sessionIdB),
          "mcp-protocol-version": "2025-03-26",
        },
        payload: JSON.stringify({
          jsonrpc: "2.0",
          id: 21,
          method: "tools/list",
        }),
      }),
    ]);

    expect(listA.statusCode).toBe(200);
    expect(listB.statusCode).toBe(200);

    const listBodyA = JSON.parse(listA.payload);
    const listBodyB = JSON.parse(listB.payload);

    expect(listBodyA.id).toBe(11);
    expect(listBodyB.id).toBe(21);
    expect(listBodyA.result.tools).toHaveLength(5);
    expect(listBodyB.result.tools).toHaveLength(5);

    const namesA = listBodyA.result.tools
      .map((tool: { name: string }) => tool.name)
      .sort();
    const namesB = listBodyB.result.tools
      .map((tool: { name: string }) => tool.name)
      .sort();
    expect(namesA).toEqual(namesB);
    expect(namesA).toEqual([
      "get_attachment",
      "get_chunk",
      "get_note",
      "related",
      "search",
    ]);
  });

  it("accepts batched JSON-RPC messages", async () => {
    const initResponse = await app.inject({
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

    expect(initResponse.statusCode).toBe(200);
    const sessionId = initResponse.headers["mcp-session-id"];

    const response = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-session-id": String(sessionId),
        "mcp-protocol-version": "2025-03-26",
      },
      payload: JSON.stringify([
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
        },
        {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
        },
      ]),
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe(2);
    expect(body[0].result.tools).toHaveLength(5);
    expect(body[1].id).toBe(3);
    expect(body[1].result.tools).toHaveLength(5);
  });

  it("opens SSE stream via GET", async () => {
    const initResponse = await app.inject({
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

    expect(initResponse.statusCode).toBe(200);
    const sessionId = initResponse.headers["mcp-session-id"];

    await app.listen({ port: 0 });
    const address = app.server.address() as import("node:net").AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const controller = new AbortController();
    const response = await new Promise<http.IncomingMessage>((resolve) => {
      const req = http.get(
        `${baseUrl}/mcp`,
        {
          headers: {
            accept: "text/event-stream",
            "mcp-session-id": String(sessionId),
            "mcp-protocol-version": "2025-03-26",
          },
          signal: controller.signal,
        },
        resolve,
      );
      req.on("error", () => {
        // ignore AbortError
      });
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    controller.abort();
  });

  it("terminates session via DELETE", async () => {
    const initResponse = await app.inject({
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

    expect(initResponse.statusCode).toBe(200);
    const sessionId = initResponse.headers["mcp-session-id"];

    const response = await app.inject({
      method: "DELETE",
      url: "/mcp",
      headers: {
        "mcp-session-id": String(sessionId),
        "mcp-protocol-version": "2025-03-26",
      },
    });

    expect([200, 204].includes(response.statusCode)).toBe(true);
  });
});

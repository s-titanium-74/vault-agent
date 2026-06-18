import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Config,
  DEFAULT_CONFIG,
  IndexStore,
  indexVault,
  vaultIdentity,
  noteIdFromPath,
  FreshnessMachine,
} from "@vault-agent/core";
import { createMcpServer, McpAdapterContext } from "../src/mcp/adapter.js";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-mcp-vault-"),
  );

  fs.writeFileSync(
    path.join(vaultDir, "Welcome.md"),
    `---
title: "Welcome Note"
tags:
  - demo
---

# Welcome Note

This is a demonstration vault for MCP testing.

## Overview

Vault-agent provides search and retrieval.`,
  );

  fs.mkdirSync(path.join(vaultDir, "Architecture"), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, "Architecture", "Search.md"),
    `---
title: "Search Architecture"
tags:
  - architecture
---

# Search Architecture

Vault-agent search system uses a layered approach combining lexical and semantic signals.`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Privacy.md"),
    `---
title: "Privacy"
tags:
  - privacy
---

# Privacy

Vault-agent is designed with local-first and private-by-default principles.`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Common.md"),
    `---
title: "Common"
---

Vault-agent`,
  );

  fs.mkdirSync(path.join(vaultDir, "attachments"), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, "attachments", "data.csv"),
    "name,value\nalpha,1\nbeta,2\n",
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

describe("MCP Adapter", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;
  let context: McpAdapterContext;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-mcp-idx-"));
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

    context = {
      store,
      config,
      embeddingProvider: null,
      freshnessMachine,
    };
  });

  afterEach(() => {
    try {
      store?.close();
    } catch {}
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("lists expected tools", async () => {
    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_attachment",
      "get_chunk",
      "get_note",
      "related",
      "search",
    ]);

    await client.close();
    await server.close();
  });

  it("search tool returns results", async () => {
    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "search",
      arguments: { query: "demonstration vault", limit: 5 },
    });

    const textContent = result.content.find((c) => c.type === "text");
    expect(textContent).toBeDefined();
    const parsed = JSON.parse((textContent as { text: string }).text);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.freshness).toBe("fresh");

    await client.close();
    await server.close();
  });

  it("get_note tool returns note content", async () => {
    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const searchResult = await client.callTool({
      name: "search",
      arguments: { query: "Welcome Note", limit: 1 },
    });
    const searchText = searchResult.content.find((c) => c.type === "text") as {
      text: string;
    };
    const searchParsed = JSON.parse(searchText.text);
    const noteId = searchParsed.results[0].noteId;

    const result = await client.callTool({
      name: "get_note",
      arguments: { noteId },
    });
    const textContent = result.content.find((c) => c.type === "text") as {
      text: string;
    };
    const parsed = JSON.parse(textContent.text);
    expect(parsed.content).toContain("Welcome Note");
    expect(parsed.freshness).toBe("fresh");

    await client.close();
    await server.close();
  });

  it("returns JSON-RPC error for missing note", async () => {
    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await expect(
      client.callTool({
        name: "get_note",
        arguments: { noteId: "00000000000000000000000000000000" },
      }),
    ).rejects.toThrow();

    await client.close();
    await server.close();
  });

  it("returns JSON-RPC error when store is missing", async () => {
    const badContext: McpAdapterContext = {
      ...context,
      store: null,
    };
    const server = createMcpServer(badContext);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await expect(
      client.callTool({
        name: "search",
        arguments: { query: "test" },
      }),
    ).rejects.toThrow();

    await client.close();
    await server.close();
  });

  it("returns JSON-RPC error when vault root is not configured", async () => {
    const badContext: McpAdapterContext = {
      ...context,
      config: {
        ...context.config,
        vault: { ...context.config.vault, root: "" },
      },
    };
    const server = createMcpServer(badContext);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    await expect(
      client.callTool({
        name: "search",
        arguments: { query: "test" },
      }),
    ).rejects.toThrow();

    await client.close();
    await server.close();
  });

  it("get_chunk tool returns chunk content", async () => {
    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const searchResult = await client.callTool({
      name: "search",
      arguments: { query: "Welcome Note", limit: 1 },
    });
    const searchText = searchResult.content.find((c) => c.type === "text") as {
      text: string;
    };
    const searchParsed = JSON.parse(searchText.text);
    const noteId = searchParsed.results[0].noteId;

    const result = await client.callTool({
      name: "get_chunk",
      arguments: { noteId, chunkIndex: 0 },
    });
    const textContent = result.content.find((c) => c.type === "text") as {
      text: string;
    };
    const parsed = JSON.parse(textContent.text);
    expect(parsed.content).toContain("demonstration vault");
    expect(parsed.chunkIndex).toBe(0);
    expect(parsed.freshness).toBe("fresh");

    await client.close();
    await server.close();
  });

  it("get_attachment tool returns metadata", async () => {
    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "get_attachment",
      arguments: { vaultRelativePath: "attachments/data.csv" },
    });
    const textContent = result.content.find((c) => c.type === "text") as {
      text: string;
    };
    const parsed = JSON.parse(textContent.text);
    expect(parsed.fileName).toBe("data.csv");
    expect(parsed.size).toBeGreaterThan(0);
    expect(parsed.content).toBeUndefined();

    await client.close();
    await server.close();
  });

  it("get_attachment tool downloads file as base64", async () => {
    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "get_attachment",
      arguments: { vaultRelativePath: "attachments/data.csv", download: true },
    });
    const textContent = result.content.find((c) => c.type === "text") as {
      text: string;
    };
    const parsed = JSON.parse(textContent.text);
    expect(parsed.encoding).toBe("base64");
    expect(parsed.content).toBeDefined();
    const decoded = Buffer.from(parsed.content, "base64").toString("utf-8");
    expect(decoded).toContain("alpha,1");

    await client.close();
    await server.close();
  });

  it("get_attachment rejects Markdown notes with ATTACHMENT_NOT_ALLOWED", async () => {
    fs.writeFileSync(
      path.join(vaultDir, "Note.md"),
      "# Note\n\nThis is a Markdown note.\n",
    );

    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    let caught: McpError | undefined;
    try {
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "get_attachment",
            arguments: { vaultRelativePath: "Note.md" },
          },
        },
        CallToolResultSchema,
      );
    } catch (error) {
      caught = error as McpError;
    }

    expect(caught).toBeDefined();
    expect(caught?.code).toBe(-32009);
    expect((caught?.data as { errorCode: string } | undefined)?.errorCode).toBe(
      "ATTACHMENT_NOT_ALLOWED",
    );

    await client.close();
    await server.close();
  });

  it("get_attachment honors allowLarge=false for oversized files", async () => {
    const largeBuffer = Buffer.alloc(11 * 1024 * 1024);
    fs.writeFileSync(
      path.join(vaultDir, "attachments", "large.bin"),
      largeBuffer,
    );

    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    let caught: McpError | undefined;
    try {
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "get_attachment",
            arguments: {
              vaultRelativePath: "attachments/large.bin",
              download: true,
              allowLarge: false,
            },
          },
        },
        CallToolResultSchema,
      );
    } catch (error) {
      caught = error as McpError;
    }

    expect(caught).toBeDefined();
    expect(caught?.code).toBe(-32008);
    expect((caught?.data as { errorCode: string } | undefined)?.errorCode).toBe(
      "QUERY_TOO_LARGE",
    );

    await client.close();
    await server.close();
  });

  it("get_attachment honors allowLarge=true for oversized files", async () => {
    const largeBuffer = Buffer.alloc(11 * 1024 * 1024);
    fs.writeFileSync(
      path.join(vaultDir, "attachments", "large.bin"),
      largeBuffer,
    );

    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.callTool({
      name: "get_attachment",
      arguments: {
        vaultRelativePath: "attachments/large.bin",
        download: true,
        allowLarge: true,
      },
    });
    const textContent = result.content.find((c) => c.type === "text") as {
      text: string;
    };
    const parsed = JSON.parse(textContent.text);
    expect(parsed.encoding).toBe("base64");
    expect(parsed.content).toBeDefined();
    const decoded = Buffer.from(parsed.content, "base64");
    expect(decoded.length).toBe(11 * 1024 * 1024);

    await client.close();
    await server.close();
  });

  it("get_attachment returns correct MIME types", async () => {
    fs.writeFileSync(
      path.join(vaultDir, "attachments", "data.csv"),
      "name,value\nalpha,1\n",
    );
    fs.writeFileSync(
      path.join(vaultDir, "attachments", "diagram.png"),
      Buffer.from("PNGFAKE", "utf-8"),
    );
    fs.writeFileSync(
      path.join(vaultDir, "attachments", "unknown.unknown"),
      "unknown content",
    );

    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    for (const [fileName, expectedType] of [
      ["data.csv", "text/csv"],
      ["diagram.png", "image/png"],
      ["unknown.unknown", "application/octet-stream"],
    ] as const) {
      const result = await client.callTool({
        name: "get_attachment",
        arguments: {
          vaultRelativePath: `attachments/${fileName}`,
          download: false,
        },
      });
      const textContent = result.content.find((c) => c.type === "text") as {
        text: string;
      };
      const parsed = JSON.parse(textContent.text);
      expect(parsed.contentType).toBe(expectedType);
      expect(parsed.content).toBeUndefined();
    }

    await client.close();
    await server.close();
  });

  it("related tool returns candidates", async () => {
    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const noteId = noteIdFromPath("Common.md");
    const result = await client.callTool({
      name: "related",
      arguments: { type: "note", id: noteId, limit: 5 },
    });
    const textContent = result.content.find((c) => c.type === "text") as {
      text: string;
    };
    const parsed = JSON.parse(textContent.text);
    expect(parsed.results.length).toBeGreaterThan(0);
    expect(parsed.freshness).toBe("fresh");

    await client.close();
    await server.close();
  });

  it("returns all five tools via a tools/list JSON-RPC request", async () => {
    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const result = await client.request(
      { method: "tools/list", params: {} },
      ListToolsResultSchema,
    );

    const names = result.tools.map((t) => t.name).sort();
    expect(names).toEqual([
      "get_attachment",
      "get_chunk",
      "get_note",
      "related",
      "search",
    ]);

    for (const tool of result.tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.inputSchema.type).toBe("object");
    }

    const schemas = Object.fromEntries(
      result.tools.map((t) => [t.name, t.inputSchema]),
    );

    expect(schemas.search.required).toEqual(["query"]);
    expect(schemas.search.properties).toMatchObject({
      query: { type: "string" },
      mode: { type: "string", enum: ["lexical", "embedding", "hybrid"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    });

    expect(schemas.get_note.required).toEqual(["noteId"]);
    expect(schemas.get_note.properties).toMatchObject({
      noteId: { type: "string" },
      allowLarge: { type: "boolean" },
    });

    expect(schemas.get_chunk.required).toEqual(["noteId", "chunkIndex"]);
    expect(schemas.get_chunk.properties).toMatchObject({
      noteId: { type: "string" },
      chunkIndex: { type: "integer", minimum: 0 },
    });

    expect(schemas.get_attachment.required).toEqual(["vaultRelativePath"]);
    expect(schemas.get_attachment.properties).toMatchObject({
      vaultRelativePath: { type: "string" },
      download: { type: "boolean" },
      allowLarge: { type: "boolean" },
    });

    expect(schemas.related.required).toEqual(["type", "id"]);
    expect(schemas.related.properties).toMatchObject({
      type: { type: "string", enum: ["note", "chunk"] },
      id: { type: "string" },
      mode: { type: "string", enum: ["lexical", "embedding", "hybrid"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    });

    await client.close();
    await server.close();
  });

  it("sanitizes JSON-RPC error responses for a missing note", async () => {
    const server = createMcpServer(context);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.1.0" });

    await server.connect(serverTransport);
    await client.connect(clientTransport);

    let caught: McpError | undefined;
    try {
      await client.request(
        {
          method: "tools/call",
          params: {
            name: "get_note",
            arguments: { noteId: "00000000000000000000000000000000" },
          },
        },
        CallToolResultSchema,
      );
    } catch (error) {
      caught = error as McpError;
    }

    expect(caught).toBeDefined();
    expect(caught?.code).toBe(-32004);
    expect((caught?.data as { errorCode: string } | undefined)?.errorCode).toBe(
      "NOTE_NOT_FOUND",
    );

    const serialized = JSON.stringify({
      code: caught?.code,
      message: caught?.message,
      data: caught?.data,
    });

    expect(serialized).not.toContain(vaultDir);
    expect(serialized).not.toContain("Welcome Note");
    expect(serialized).not.toContain("demonstration vault");
    expect(serialized).not.toContain("Search Architecture");
    expect(serialized).not.toContain("Privacy");
    expect(serialized).not.toMatch(/api[_-]?key|token|secret|password/i);

    await client.close();
    await server.close();
  });
});

import { SyntheticPCloud } from "../../core/test/helpers/pcloud.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { once } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DEFAULT_CONFIG,
  IndexStore,
  FreshnessMachine,
  getIndexPath,
  indexVault,
  noteIdFromPath,
  type Config,
} from "@vault-agent/core";
import { mutationStatePath } from "../../core/src/local/mutation-state.js";
import {
  createServer,
  initApp,
  resetApp,
  prepareServerAccessConfig,
} from "../src/index.js";
import { createMcpServer } from "../src/mcp/adapter.js";
import {
  LocalMutationRuntime,
  MCP_WRITE_REQUEST_BYTES,
} from "../src/mcp/mutations.js";
import { boundedStdioInput } from "../src/mcp/stdio.js";
import { patchMockSocketDestroySoon } from "./test-utils.js";

const create = (
  file = "Notes/New.md",
  content = "# Synthetic\n\nMarkerbody.",
) => ({ type: "create_note", path: file, content });
const update = (
  file: string,
  version: string,
  content = "# Updated\n\nChangedbody.",
) => ({ type: "replace_note", path: file, expected_version: version, content });
const remove = (file: string, version: string) => ({
  type: "delete_file",
  path: file,
  expected_version: version,
});
const readKey = "r".repeat(64),
  adminKey = "a".repeat(64);
function unpack(result: unknown): any {
  return JSON.parse(
    (result as { content: { text: string }[] }).content[0]!.text,
  );
}
function rpc(result: { body: string }): any {
  if (result.body.startsWith("{")) return JSON.parse(result.body);
  const data = result.body
    .split("\n")
    .find((line) => line.startsWith("data: "));
  return data ? JSON.parse(data.slice(6)) : null;
}

describe("local MCP file changes", () => {
  let directory: string, config: Config, store: IndexStore;
  let runtime: LocalMutationRuntime | null, client: Client | undefined;
  let server: ReturnType<typeof createMcpServer> | undefined;
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  beforeEach(async () => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-mcp-write-"),
    );
    const root = path.join(directory, "vault");
    fs.mkdirSync(root);
    fs.writeFileSync(
      path.join(root, "Seed.md"),
      "# Seed\n\nSynthetic search seed.",
    );
    config = structuredClone(DEFAULT_CONFIG);
    config.vault.root = root;
    config.index.dir = path.join(directory, "indexes");
    config.embedding.enabled = false;
    config.watch.enabled = false;
    config.server.logLevel = "error";
    await indexVault(config);
    store = await IndexStore.open(getIndexPath(config));
    runtime = null;
    client = undefined;
    server = undefined;
    app = undefined;
  });
  afterEach(async () => {
    await client?.close();
    await server?.close();
    await app?.close();
    await runtime?.close();
    resetApp();
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  async function connect(enabled = true, mode: "review" | "direct" = "review") {
    config.write = { ...config.write, enabled, mode };
    const freshness = new FreshnessMachine("fresh");
    runtime = enabled ? new LocalMutationRuntime(config, freshness) : null;
    server = createMcpServer({
      config,
      store,
      embeddingProvider: null,
      freshnessMachine: freshness,
      mutations: runtime,
    });
    client = new Client({ name: "synthetic-write-client", version: "1" });
    const [one, two] = InMemoryTransport.createLinkedPair();
    await server.connect(two);
    await client.connect(one);
  }
  const call = async (name: string, args: Record<string, unknown>) =>
    unpack(await client!.callTool({ name, arguments: args }));
  async function apply(operations: unknown[]) {
    const plan = await call("preview_changes", { operations });
    return call("apply_changes", {
      operations,
      operation_id: plan.operation_id,
      preview_binding: plan.preview_binding,
    });
  }
  async function http() {
    config.write.enabled = true;
    config.mcp.enabled = true;
    config.server.readKey = readKey;
    config.server.adminKey = adminKey;
    initApp(store, config);
    app = await createServer(config, {
      store,
      config,
      embeddingProvider: null,
      freshnessMachine: new FreshnessMachine("fresh"),
    });
    patchMockSocketDestroySoon(app);
    await app.ready();
  }
  async function request(
    method: string,
    params: Record<string, unknown>,
    token = adminKey,
    session?: string,
  ) {
    return app!.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-03-26",
        authorization: `Bearer ${token}`,
        ...(session ? { "mcp-session-id": session } : {}),
      },
      payload: { jsonrpc: "2.0", id: 1, method, params },
    });
  }
  async function session(token = adminKey) {
    const result = await request(
      "initialize",
      {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "synthetic-http", version: "1" },
      },
      token,
    );
    expect(result.statusCode).toBe(200);
    return String(result.headers["mcp-session-id"]);
  }

  it("updates a pCloud note through the MCP client and publishes it to search", async () => {
    const api = new SyntheticPCloud();
    api.set("Notes/Apple.md", "# Apple\n\nSynthetic orchard.");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(api.fetch);
    try {
      config.index.dir = path.join(directory, "pcloud-index");
      config.vault.pcloud = {
        region: "us",
        folder_id: "1",
        access_token: "synthetic",
        includes: ["Notes"],
        poll_seconds: 60,
      };
      await indexVault(config);
      store.close();
      store = await IndexStore.open(getIndexPath(config));
      await connect();
      const relative = "Notes/Apple.md";
      const note = await call("get_note", { noteId: noteIdFromPath(relative) });
      const result = await apply([update(relative, note.version)]);
      expect(result.results[0]).toMatchObject({ status: "applied" });
      await runtime!.flush();
      const status = await call("get_change_status", {
        operation_id: result.operation_id,
      });
      expect(status.results[0]).toMatchObject({ index_state: "fresh" });
      expect(
        (await call("get_note", { noteId: noteIdFromPath(relative) })).content,
      ).toContain("Changedbody");
    } finally {
      await runtime?.close();
      fetchMock.mockRestore();
    }
  });

  it("keeps mutations absent/default-off and refuses direct calls with no journal", async () => {
    await connect(false);
    expect(
      (await client!.listTools()).tools.some(
        (tool) => tool.name === "preview_changes",
      ),
    ).toBe(false);
    await expect(
      call("preview_changes", { operations: [create()] }),
    ).rejects.toMatchObject({ data: { errorCode: "WRITE_DISABLED" } });
    expect(fs.existsSync(mutationStatePath(getIndexPath(config)))).toBe(false);
    expect(fs.existsSync(path.join(config.vault.root, "Notes"))).toBe(false);
  });
  it("exposes three explicitly annotated tools with untrusted-content descriptions", async () => {
    await connect();
    const tools = (await client!.listTools()).tools;
    for (const name of [
      "preview_changes",
      "apply_changes",
      "get_change_status",
    ]) {
      const tool = tools.find((tool) => tool.name === name)!;
      expect(tool.description).toContain("untrusted");
      expect(tool.annotations?.readOnlyHint).toBe(false);
    }
    expect(
      tools.find((tool) => tool.name === "apply_changes")?.annotations,
    ).toMatchObject({ destructiveHint: true, idempotentHint: true });
  });
  it("previews/applies/reads a note, preserves metadata and deduplicates a lost response", async () => {
    await connect();
    const operations = [
      create(
        "Notes/New.md",
        "---\ntitle: Synthetic title\ntags: [demo]\n---\n\n# New\nBodymarker.",
      ),
    ];
    const plan = await call("preview_changes", { operations });
    expect(plan.preview.results[0].diff.added).toContain("Bodymarker");
    expect(fs.existsSync(path.join(config.vault.root, "Notes"))).toBe(false);
    const result = await call("apply_changes", {
      operations,
      operation_id: plan.operation_id,
      preview_binding: plan.preview_binding,
    });
    expect(result.results[0]).toMatchObject({
      status: "applied",
      note_id: noteIdFromPath("Notes/New.md"),
      version: expect.stringMatching(/^fs1:/),
    });
    expect(JSON.stringify(result)).not.toContain("Bodymarker");
    const note = await call("get_note", { noteId: result.results[0].note_id });
    expect(note).toMatchObject({
      content: expect.stringContaining("Bodymarker"),
      version: result.results[0].version,
      metadata: { tags: ["demo"] },
      title: "Synthetic title",
    });
    const before = fs.statSync(
      path.join(config.vault.root, "Notes/New.md"),
    ).ino;
    const replay = await call("apply_changes", {
      operations,
      operation_id: plan.operation_id,
      preview_binding: plan.preview_binding,
    });
    expect(replay.results[0].version).toBe(result.results[0].version);
    expect(fs.statSync(path.join(config.vault.root, "Notes/New.md")).ino).toBe(
      before,
    );
    expect(
      (await call("get_change_status", { operation_id: plan.operation_id }))
        .state,
    ).toBe("completed");
  });
  it("requires review bindings, rejects changed/unknown fields, and permits explicit direct mode", async () => {
    await connect();
    const operations = [create()];
    const plan = await call("preview_changes", { operations });
    await expect(
      call("apply_changes", { operations, operation_id: plan.operation_id }),
    ).rejects.toMatchObject({ data: { errorCode: "PREVIEW_REQUIRED" } });
    await expect(
      call("apply_changes", {
        operations: [create("Notes/New.md", "Changed")],
        operation_id: plan.operation_id,
        preview_binding: plan.preview_binding,
      }),
    ).rejects.toMatchObject({ data: { errorCode: "IDEMPOTENCY_CONFLICT" } });
    await expect(
      call("preview_changes", { operations, force: true }),
    ).rejects.toMatchObject({ data: { errorCode: "INVALID_REQUEST" } });
    await expect(
      call("get_change_status", {
        operation_id: plan.operation_id,
        force: true,
      }),
    ).rejects.toMatchObject({ data: { errorCode: "INVALID_REQUEST" } });
    await expect(
      call("preview_changes", { operations, preview: false }),
    ).rejects.toMatchObject({ data: { errorCode: "PREVIEW_REQUIRED" } });
    await client!.close();
    await server!.close();
    await runtime!.close();
    client = undefined;
    server = undefined;
    runtime = null;
    await connect(true, "direct");
    const direct = await call("preview_changes", {
      operations,
      preview: false,
    });
    expect(direct.preview).toBeUndefined();
    expect(
      (
        await call("apply_changes", {
          operations,
          operation_id: direct.operation_id,
        })
      ).results[0].status,
    ).toBe("applied");
  });
  it("gets source versions, rejects stale chunks, and deletes without exposing old search results", async () => {
    await connect();
    const seed = await call("get_note", { noteId: noteIdFromPath("Seed.md") });
    const old = (
      await call("search", { query: "seed", mode: "lexical" })
    ).results.find((item: { type: string }) => item.type === "chunk");
    expect(old.version).toMatch(/^chunk1:/);
    expect(
      (
        await call("get_chunk", {
          noteId: old.noteId,
          chunkIndex: old.chunkIndex,
          expected_version: old.version,
        })
      ).content,
    ).toContain("Synthetic search seed");
    await expect(
      call("get_chunk", { noteId: old.noteId, chunkIndex: old.chunkIndex }),
    ).rejects.toMatchObject({ data: { errorCode: "INVALID_REQUEST" } });
    const replaced = await apply([update("Seed.md", seed.version)]);
    await expect(
      call("get_chunk", {
        noteId: seed.id,
        chunkIndex: 0,
        expected_version: seed.version,
      }),
    ).rejects.toMatchObject({ data: { errorCode: "REVISION_CHANGED" } });
    expect((await call("get_note", { noteId: seed.id })).content).toContain(
      "Changedbody",
    );
    await runtime!.flush();
    await expect(
      call("get_chunk", {
        noteId: old.noteId,
        chunkIndex: old.chunkIndex,
        expected_version: old.version,
      }),
    ).rejects.toMatchObject({ data: { errorCode: "REVISION_CHANGED" } });
    expect(
      (
        await call("get_chunk", {
          noteId: seed.id,
          chunkIndex: 0,
          expected_version: replaced.results[0].version,
        })
      ).content,
    ).toContain("Changedbody");
    expect(
      (await apply([remove("Seed.md", replaced.results[0].version)])).results[0]
        .status,
    ).toBe("applied");
    await expect(call("get_note", { noteId: seed.id })).rejects.toMatchObject({
      data: { errorCode: "NOTE_NOT_FOUND" },
    });
    expect(
      (await call("search", { query: "Changedbody", mode: "lexical" })).results,
    ).toEqual([]);
  });
  it("supports attachment upload/versioned replace/delete and rejects malformed Base64", async () => {
    await connect();
    await apply([
      {
        type: "upload_attachment",
        path: "Images/New.png",
        content_base64: "AAEC/w==",
      },
    ]);
    const metadata = await call("get_attachment", {
      vaultRelativePath: "Images/New.png",
    });
    expect(metadata).toMatchObject({
      size: 4,
      version: expect.stringMatching(/^fs1:/),
    });
    expect(metadata.content).toBeUndefined();
    const downloaded = await call("get_attachment", {
      vaultRelativePath: "Images/New.png",
      download: true,
    });
    expect(downloaded.content).toBe("AAEC/w==");
    const replaced = await apply([
      {
        type: "upload_attachment",
        path: "Images/New.png",
        replace: true,
        expected_version: metadata.version,
        content_base64: "AQID",
      },
    ]);
    await apply([remove("Images/New.png", replaced.results[0].version)]);
    await expect(
      call("get_attachment", { vaultRelativePath: "Images/New.png" }),
    ).rejects.toMatchObject({ data: { errorCode: "ATTACHMENT_NOT_FOUND" } });
    await expect(
      call("preview_changes", {
        operations: [
          {
            type: "upload_attachment",
            path: "Other.png",
            content_base64: "AB==",
          },
        ],
      }),
    ).rejects.toMatchObject({ data: { errorCode: "INVALID_BASE64" } });
  });
  it("retains default note read size limits while explicitly allowing saved larger notes", async () => {
    await connect();
    await apply([create("Large.md", "X".repeat(210 * 1024))]);
    await expect(
      call("get_note", { noteId: noteIdFromPath("Large.md") }),
    ).rejects.toMatchObject({ data: { errorCode: "NOTE_TOO_LARGE" } });
    expect(
      (
        await call("get_note", {
          noteId: noteIdFromPath("Large.md"),
          allowLarge: true,
        })
      ).size,
    ).toBe(210 * 1024);
  });
  it("does not treat the configured save-size limit as the source read-size limit", async () => {
    config.write.max_file_bytes = 8;
    await connect();
    const seed = await call("get_note", { noteId: noteIdFromPath("Seed.md") });
    expect(seed.content).toContain("Synthetic search seed");
    expect(seed.size).toBeGreaterThan(8);
  });
  it("keeps saved source readable with valid stale freshness when required indexing fails", async () => {
    config.embedding.enabled = true;
    config.embedding.require = true;
    config.embedding.model = "";
    await connect();
    const applied = await apply([create()]);
    await expect(runtime!.flush()).rejects.toMatchObject({
      code: "EMBEDDING_CONFIG_INVALID",
    });
    const note = await call("get_note", { noteId: applied.results[0].note_id });
    expect(note).toMatchObject({
      content: expect.stringContaining("Markerbody"),
      index_state: "failed",
      freshness: "stale",
    });
  });
  it("observes external edits/deletes/recreations and rejects stale proposals", async () => {
    await connect();
    await apply([create()]);
    await runtime!.flush();
    const before = await call("get_note", {
      noteId: noteIdFromPath("Notes/New.md"),
    });
    const operations = [update("Notes/New.md", before.version)];
    const proposal = await call("preview_changes", { operations });
    const external =
      "\ufeff# External\n" + "日".repeat(30000) + "\nExternalmarker.";
    fs.writeFileSync(path.join(config.vault.root, "Notes/New.md"), external);
    const result = await call("apply_changes", {
      operations,
      operation_id: proposal.operation_id,
      preview_binding: proposal.preview_binding,
    });
    expect(result.results[0].code).toBe("SOURCE_REVISION_MISMATCH");
    expect((await call("get_note", { noteId: before.id })).content).toBe(
      external,
    );
    await runtime!.flush();
    const candidates = (
      await call("search", { query: "Externalmarker", mode: "lexical" })
    ).results;
    expect(candidates.length).toBeGreaterThan(0);
    expect(
      candidates.every((item: { noteId: string }) => item.noteId === before.id),
    ).toBe(true);
    fs.unlinkSync(path.join(config.vault.root, "Notes/New.md"));
    runtime!.service.refreshSources();
    expect(store.getNote(before.id)).toBeNull();
    fs.writeFileSync(
      path.join(config.vault.root, "Notes/New.md"),
      "# Recreated\n\nRecreatedmarker.",
    );
    runtime!.service.refreshSources();
    await runtime!.flush();
    expect((await call("get_note", { noteId: before.id })).content).toContain(
      "Recreatedmarker",
    );
  });
  it("refuses anonymous or legacy-key HTTP enablement before allocating source state", async () => {
    config.write.enabled = true;
    await expect(createServer(config)).rejects.toThrow(/separate|distinct/);
    config.server.apiKey = adminKey;
    await expect(createServer(config)).rejects.toThrow(/separate|distinct/);
    config.server.apiKey = "";
    config.server.host = "0.0.0.0";
    expect(() =>
      prepareServerAccessConfig(config, {
        configPath: path.join(directory, "private.toml"),
        defaultConfigPathOverride: path.join(directory, "default.toml"),
      }),
    ).toThrow(/distinct/);
    expect(fs.existsSync(mutationStatePath(getIndexPath(config)))).toBe(false);
  });
  it("filters HTTP lists and denies read-key preview/status/apply before decoding", async () => {
    await http();
    const readSession = await session(readKey),
      adminSession = await session();
    const read = rpc(await request("tools/list", {}, readKey, readSession));
    expect(
      read.result.tools.some(
        (tool: { name: string }) => tool.name === "preview_changes",
      ),
    ).toBe(false);
    const admin = rpc(await request("tools/list", {}, adminKey, adminSession));
    expect(
      admin.result.tools.some(
        (tool: { name: string }) => tool.name === "preview_changes",
      ),
    ).toBe(true);
    for (const name of [
      "preview_changes",
      "get_change_status",
      "apply_changes",
    ]) {
      const denied = await request(
        "tools/call",
        {
          name,
          arguments: {
            operations: [
              {
                type: "upload_attachment",
                path: "Denied.png",
                content_base64: "invalid",
              },
            ],
          },
        },
        readKey,
        readSession,
      );
      expect(denied.statusCode).toBe(403);
      expect(rpc(denied).error.data.errorCode).toBe("ADMIN_REQUIRED");
    }
    expect(fs.existsSync(path.join(config.vault.root, "Denied.png"))).toBe(
      false,
    );
  });
  it("checks current HTTP roles on every reused session and invalidates revoked tokens", async () => {
    await http();
    const readSession = await session(readKey),
      adminSession = await session();
    expect(
      (await request("tools/list", {}, readKey, adminSession)).statusCode,
    ).toBe(403);
    expect(
      (await request("tools/list", {}, adminKey, readSession)).statusCode,
    ).toBe(403);
    config.server.adminKey = "b".repeat(64);
    expect(
      (await request("tools/list", {}, adminKey, adminSession)).statusCode,
    ).toBe(403);
    expect(
      (await request("tools/list", {}, config.server.adminKey, adminSession))
        .statusCode,
    ).toBe(200);
    config.server.readKey = undefined;
    config.server.adminKey = undefined;
    expect(
      (await request("tools/list", {}, readKey, readSession)).statusCode,
    ).toBe(401);
  });
  it("runs HTTP review/apply and exposes current versions through REST", async () => {
    await http();
    const id = await session();
    const operations = [create()];
    const preview = rpc(
      await request(
        "tools/call",
        { name: "preview_changes", arguments: { operations } },
        adminKey,
        id,
      ),
    );
    const plan = unpack(preview.result);
    const response = rpc(
      await request(
        "tools/call",
        {
          name: "apply_changes",
          arguments: {
            operations,
            operation_id: plan.operation_id,
            preview_binding: plan.preview_binding,
          },
        },
        adminKey,
        id,
      ),
    );
    expect(unpack(response.result).results[0].status).toBe("applied");
    const note = await app!.inject({
      method: "GET",
      url: `/notes/${noteIdFromPath("Notes/New.md")}`,
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(note.statusCode).toBe(200);
    expect(note.json().data.version).toMatch(/^fs1:/);
    expect(note.json().data.content).toContain("Markerbody");
    await app!.vaultMutations!.flush();
    const noPin = await app!.inject({
      method: "GET",
      url: `/chunks/${noteIdFromPath("Notes/New.md")}/0`,
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(noPin.statusCode).toBe(400);
    const chunk = await app!.inject({
      method: "GET",
      url: `/chunks/${noteIdFromPath("Notes/New.md")}/0?expected_version=${encodeURIComponent(note.json().data.version)}`,
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(chunk.statusCode).toBe(200);
    const search = await app!.inject({
      method: "POST",
      url: "/search",
      headers: { authorization: `Bearer ${readKey}` },
      payload: { query: "Markerbody", mode: "lexical" },
    });
    const candidate = search.json().data.results[0];
    expect(candidate.version).toMatch(/^chunk1:/);
    const pinned = await app!.inject({
      method: "GET",
      url: `/chunks/${candidate.noteId}/${candidate.chunkIndex}?expected_version=${encodeURIComponent(candidate.version)}`,
      headers: { authorization: `Bearer ${readKey}` },
    });
    expect(pinned.statusCode).toBe(200);
  });
  it("rejects read-key mutation batches and bounds raw requests before preparing content", async () => {
    await http();
    const id = await session(readKey);
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${readKey}`,
      "mcp-session-id": id,
    };
    const denied = await app!.inject({
      method: "POST",
      url: "/mcp",
      headers,
      payload: [
        { jsonrpc: "2.0", id: 1, method: "tools/list" },
        {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "preview_changes",
            arguments: { operations: [create()] },
          },
        },
      ],
    });
    expect(denied.statusCode).toBe(403);
    const oversized = await app!.inject({
      method: "POST",
      url: "/mcp",
      headers: { ...headers, authorization: `Bearer ${adminKey}` },
      payload: " ".repeat(MCP_WRITE_REQUEST_BYTES + 1),
    });
    expect(oversized.statusCode).toBe(413);
    const invalid = await app!.inject({
      method: "POST",
      url: "/mcp",
      headers: { "content-type": "application/json" },
      payload: "invalid",
    });
    expect(invalid.statusCode).toBe(401);
    expect(fs.existsSync(path.join(config.vault.root, "Notes"))).toBe(false);
  });
});

describe("bounded stdio frames", () => {
  it("counts bytes per line and accepts separate frames", async () => {
    const input = boundedStdioInput(8);
    const parts: Buffer[] = [];
    input.on("data", (part) => parts.push(part));
    input.end(Buffer.from("12345678\n1234\n"));
    await once(input, "end");
    expect(Buffer.concat(parts).toString()).toBe("12345678\n1234\n");
  });
  it("rejects oversized UTF-8 frames with a fixed content-free error", async () => {
    const input = boundedStdioInput(8);
    const failure = once(input, "error");
    input.write(Buffer.from("日".repeat(3)));
    expect((await failure)[0].message).toBe("MCP frame exceeds size limit.");
  });
  it("rejects malformed UTF-8 before SDK parsing", async () => {
    const input = boundedStdioInput();
    const failure = once(input, "error");
    input.write(Buffer.from([255]));
    expect((await failure)[0].message).toBe("MCP frame is not valid UTF-8.");
  });
});

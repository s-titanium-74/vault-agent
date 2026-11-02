import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { indexVault, loadConfig } from "@vault-agent/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../dist/main.js");

describe("MCP stdio opt-in file changes", () => {
  let vaultDir: string,
    indexDir: string,
    child: ChildProcessWithoutNullStreams | undefined;
  beforeEach(() => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-write-stdio-"),
    );
    child = undefined;
  });
  afterEach(async () => {
    if (child && child.exitCode === null && !child.killed)
      await new Promise<void>((resolve) => {
        child!.once("exit", () => resolve());
        child!.kill("SIGINT");
      });
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });
  it("previews, saves, reads and permanently deletes through the actual CLI without HTTP credentials", async () => {
    const file = path.join(indexDir, "config.toml");
    writeTestConfig(file, vaultDir, indexDir, false);
    fs.appendFileSync(file, "\n[write]\nenabled = true\n");
    child = await spawnMcpChild(file);
    const initialize = await sendRequest(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "synthetic-write", version: "1" },
      },
    });
    expect(initialize.result).toBeDefined();
    let id = 1;
    async function call(
      name: string,
      args: Record<string, unknown>,
    ): Promise<Record<string, any>> {
      const response = await sendRequest(child!, {
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      expect(response.error).toBeUndefined();
      return JSON.parse(
        (response.result as { content: { text: string }[] }).content[0]!.text,
      );
    }
    const operations = [
      {
        type: "create_note",
        path: "Notes/Stdio.md",
        content: "# Stdio synthetic\n\nOriginal marker.",
      },
    ];
    const plan = await call("preview_changes", { operations });
    expect(fs.existsSync(path.join(vaultDir, "Notes/Stdio.md"))).toBe(false);
    const applied = await call("apply_changes", {
      operations,
      operation_id: plan.operation_id,
      preview_binding: plan.preview_binding,
    });
    const note = await call("get_note", { noteId: applied.results[0].note_id });
    expect(note.content).toContain("Original marker");
    expect(note.version).toMatch(/^fs1:/);
    const changes = [
      {
        type: "replace_note",
        path: "Notes/Stdio.md",
        expected_version: note.version,
        content: "# Stdio updated\n\nUpdated marker.",
      },
    ];
    const next = await call("preview_changes", { operations: changes });
    const updated = await call("apply_changes", {
      operations: changes,
      operation_id: next.operation_id,
      preview_binding: next.preview_binding,
    });
    expect((await call("get_note", { noteId: note.id })).content).toContain(
      "Updated marker",
    );
    const deletions = [
      {
        type: "delete_file",
        path: "Notes/Stdio.md",
        expected_version: updated.results[0].version,
      },
    ];
    const removal = await call("preview_changes", { operations: deletions });
    await call("apply_changes", {
      operations: deletions,
      operation_id: removal.operation_id,
      preview_binding: removal.preview_binding,
    });
    expect(fs.existsSync(path.join(vaultDir, "Notes/Stdio.md"))).toBe(false);
    expect(
      (await call("get_change_status", { operation_id: removal.operation_id }))
        .results[0].status,
    ).toBe("applied");
  });
  it("rejects invalid write configuration instead of silently starting a read-only fallback", async () => {
    const file = path.join(indexDir, "config.toml");
    writeTestConfig(file, vaultDir, indexDir, false);
    fs.appendFileSync(file, '\n[write]\nenabled = true\nmode = "force"\n');
    child = spawnMcpChildRaw(file);
    const streams = collectStreams(child);
    const code = await new Promise<number | null>((resolve) =>
      child!.once("exit", resolve),
    );
    expect(code).toBe(2);
    expect(streams.stderrRaw()).toContain("CONFIG_INVALID");
    expect(streams.stdoutRaw()).toBe("");
    streams.detach();
  });
});

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-mcp-stdio-vault-"),
  );
  fs.writeFileSync(
    path.join(vaultDir, "Welcome.md"),
    `---
title: "Welcome Note"
---

# Welcome Note

This is a demonstration vault for MCP stdio testing.`,
  );
  return vaultDir;
}

async function sendRequest(
  child: ChildProcessWithoutNullStreams,
  request: unknown,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Timeout waiting for MCP response"));
    }, 5000);

    let buffer = "";
    const onData = (data: Buffer) => {
      buffer += data.toString("utf-8");
      const lines = buffer.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const parsed = JSON.parse(trimmed);
          clearTimeout(timeout);
          cleanup();
          resolve(parsed as Record<string, unknown>);
          return;
        } catch {
          // continue accumulating
        }
      }
      buffer = lines[lines.length - 1] ?? "";
    };

    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`MCP process exited with code ${code}`));
    };

    const cleanup = () => {
      child.stdout.off("data", onData);
      child.off("exit", onExit);
    };

    child.stdout.on("data", onData);
    child.once("exit", onExit);

    child.stdin.write(JSON.stringify(request) + "\n");
  });
}

function writeTestConfig(
  configPath: string,
  vaultDir: string,
  indexDir: string,
  mcpEnabled?: boolean,
): void {
  let config = `vault.root = "${vaultDir.replace(/\\/g, "/")}"
vault.exclude = []
index.dir = "${indexDir.replace(/\\/g, "/")}"
`;
  if (mcpEnabled !== undefined) {
    config += `mcp.enabled = ${mcpEnabled}\n`;
  }
  fs.writeFileSync(configPath, config);
}

async function spawnMcpChild(
  configPath: string,
): Promise<ChildProcessWithoutNullStreams> {
  const configObj = loadConfig(configPath);
  await indexVault(configObj);

  return spawn("node", [cliPath, "mcp", "--config", configPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function spawnMcpChildRaw(configPath: string): ChildProcessWithoutNullStreams {
  return spawn("node", [cliPath, "mcp", "--config", configPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function writeUnconfiguredConfig(configPath: string, indexDir: string): void {
  const config = `index.dir = "${indexDir.replace(/\\/g, "/")}"
`;
  fs.writeFileSync(configPath, config);
}

function writeMissingIndexConfig(
  configPath: string,
  vaultDir: string,
  indexDir: string,
): void {
  const config = `vault.root = "${vaultDir.replace(/\\/g, "/")}"
vault.exclude = []
index.dir = "${indexDir.replace(/\\/g, "/")}"
`;
  fs.writeFileSync(configPath, config);
}

function collectStreams(child: ChildProcessWithoutNullStreams): {
  stdoutRaw: () => string;
  stderrRaw: () => string;
  detach: () => void;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];

  const onStdout = (data: Buffer) => stdout.push(data.toString("utf-8"));
  const onStderr = (data: Buffer) => stderr.push(data.toString("utf-8"));

  child.stdout.on("data", onStdout);
  child.stderr.on("data", onStderr);

  return {
    stdoutRaw: () => stdout.join(""),
    stderrRaw: () => stderr.join(""),
    detach: () => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
    },
  };
}

describe("MCP stdio transport", () => {
  let vaultDir: string;
  let indexDir: string;
  let configPath: string;
  let child: ChildProcessWithoutNullStreams;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-mcp-stdio-idx-"),
    );
    configPath = path.join(indexDir, "config.toml");
    writeTestConfig(configPath, vaultDir, indexDir);

    child = await spawnMcpChild(configPath);
  });

  afterEach(() => {
    if (child && !child.killed) {
      child.kill();
    }
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("responds to initialize over stdio", async () => {
    const response = await sendRequest(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      },
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect((response.result as Record<string, unknown>).protocolVersion).toBe(
      "2025-03-26",
    );
    expect(
      (
        (response.result as Record<string, unknown>).serverInfo as Record<
          string,
          unknown
        >
      ).name,
    ).toBe("vault-agent");
  });

  it("shuts down gracefully on SIGINT", async () => {
    await sendRequest(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      },
    });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      child.kill("SIGINT");
    });

    expect(exitCode).toBe(0);
  });
});

describe("MCP stdio transport with mcp.enabled = false", () => {
  let vaultDir: string;
  let indexDir: string;
  let configPath: string;
  let child: ChildProcessWithoutNullStreams;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-mcp-stdio-disabled-idx-"),
    );
    configPath = path.join(indexDir, "config.toml");
    writeTestConfig(configPath, vaultDir, indexDir, false);

    child = await spawnMcpChild(configPath);
  });

  afterEach(() => {
    if (child && !child.killed) {
      child.kill();
    }
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("responds to initialize over stdio even when mcp.enabled is false", async () => {
    const response = await sendRequest(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      },
    });

    expect(response.jsonrpc).toBe("2.0");
    expect(response.id).toBe(1);
    expect((response.result as Record<string, unknown>).protocolVersion).toBe(
      "2025-03-26",
    );
    expect(
      (
        (response.result as Record<string, unknown>).serverInfo as Record<
          string,
          unknown
        >
      ).name,
    ).toBe("vault-agent");
  });
});

describe("MCP stdio transport stream integrity", () => {
  let vaultDir: string;
  let indexDir: string;
  let configPath: string;
  let child: ChildProcessWithoutNullStreams;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-mcp-stdio-integrity-idx-"),
    );
    configPath = path.join(indexDir, "config.toml");
    writeTestConfig(configPath, vaultDir, indexDir);

    child = await spawnMcpChild(configPath);
  });

  afterEach(() => {
    if (child && !child.killed) {
      child.kill();
    }
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("stderr logging does not corrupt stdout JSON-RPC stream", async () => {
    const collector = collectStreams(child);

    const initializeResponse = await sendRequest(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      },
    });

    expect(initializeResponse.id).toBe(1);

    const listResponse = await sendRequest(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });

    expect(listResponse.id).toBe(2);

    collector.detach();

    const stdoutLines = collector
      .stdoutRaw()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const stderrLines = collector
      .stderrRaw()
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    expect(stdoutLines.length).toBeGreaterThanOrEqual(2);

    for (const line of stdoutLines) {
      const parsed = JSON.parse(line);
      expect(parsed.jsonrpc).toBe("2.0");
      expect(parsed).toHaveProperty("id");
    }

    for (const line of stderrLines) {
      expect(stdoutLines).not.toContain(line);
    }
  });
});

describe("MCP stdio transport without configured vault root", () => {
  let indexDir: string;
  let configPath: string;
  let child: ChildProcessWithoutNullStreams;

  beforeEach(() => {
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-mcp-stdio-no-root-idx-"),
    );
    configPath = path.join(indexDir, "config.toml");
    writeUnconfiguredConfig(configPath, indexDir);

    child = spawnMcpChildRaw(configPath);
  });

  afterEach(() => {
    if (child && !child.killed) {
      child.kill();
    }
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("returns actionable error when no vault root is configured", async () => {
    const initializeResponse = await sendRequest(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      },
    });

    expect(initializeResponse.id).toBe(1);

    const response = await sendRequest(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "search",
        arguments: { query: "test" },
      },
    });

    expect(response.error).toBeDefined();
    expect((response.error as Record<string, unknown>).code).toBe(-32013);
    expect(
      (
        (response.error as Record<string, unknown>).data as Record<
          string,
          unknown
        >
      ).errorCode,
    ).toBe("VAULT_NOT_CONFIGURED");
  });
});

describe("MCP stdio transport without usable index", () => {
  let vaultDir: string;
  let tmpDir: string;
  let configPath: string;
  let child: ChildProcessWithoutNullStreams;

  beforeEach(() => {
    vaultDir = createTestVault();
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-mcp-stdio-no-index-"),
    );

    // Block index creation by making the index parent path a file, so the
    // store cannot be opened and the server reports INDEX_NOT_FOUND.
    const blockFile = path.join(tmpDir, "index-block");
    fs.writeFileSync(blockFile, "");
    const indexDir = path.join(blockFile, "indexes");

    configPath = path.join(tmpDir, "config.toml");
    writeMissingIndexConfig(configPath, vaultDir, indexDir);

    child = spawnMcpChildRaw(configPath);
  });

  afterEach(() => {
    if (child && !child.killed) {
      child.kill();
    }
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns actionable error when no usable index exists", async () => {
    const initializeResponse = await sendRequest(child, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0.1.0" },
      },
    });

    expect(initializeResponse.id).toBe(1);

    const response = await sendRequest(child, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "search",
        arguments: { query: "test" },
      },
    });

    expect(response.error).toBeDefined();
    expect((response.error as Record<string, unknown>).code).toBe(-32001);
    expect(
      (
        (response.error as Record<string, unknown>).data as Record<
          string,
          unknown
        >
      ).errorCode,
    ).toBe("INDEX_NOT_FOUND");
  });
});

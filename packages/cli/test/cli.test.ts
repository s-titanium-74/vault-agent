import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getCommandResultFromHttpResponse, program } from "../src/index.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import TOML from "smol-toml";

function createTempConfigDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-cli-test-"));
}

function createTempConfig(
  configDir: string,
  overrides: Record<string, unknown> = {},
): string {
  const config = {
    vault: { root: "/tmp/test-vault", exclude: [] },
    server: {
      endpoint: "http://127.0.0.1:8787",
      host: "127.0.0.1",
      port: 8787,
      api_key: "",
      log_level: "info",
    },
    index: { dir: "" },
    embedding: {
      enabled: false,
      endpoint: "http://127.0.0.1:11434/v1/embeddings",
      model: "",
      require: false,
    },
    cors: { enabled: false, allowed_origins: [] },
    ...overrides,
  };

  const configPath = path.join(configDir, "config.toml");
  const lines: string[] = [];
  for (const [section, values] of Object.entries(config)) {
    if (typeof values === "object" && values !== null) {
      lines.push(`[${section}]`);
      for (const [key, val] of Object.entries(
        values as Record<string, unknown>,
      )) {
        if (Array.isArray(val)) {
          lines.push(`${key} = [${val.map((v) => `"${v}"`).join(", ")}]`);
        } else if (typeof val === "boolean") {
          lines.push(`${key} = ${val}`);
        } else if (typeof val === "number") {
          lines.push(`${key} = ${val}`);
        } else {
          lines.push(`${key} = "${val}"`);
        }
      }
      lines.push("");
    }
  }
  fs.writeFileSync(configPath, lines.join("\n"), "utf-8");
  return configPath;
}

describe("CLI command parsing", () => {
  it("program has correct name and version", () => {
    expect(program.name()).toBe("vault-agent");
  });

  it("has serve command", () => {
    const serveCmd = program.commands.find((c) => c.name() === "serve");
    expect(serveCmd).toBeDefined();
  });

  it("has index command", () => {
    const indexCmd = program.commands.find((c) => c.name() === "index");
    expect(indexCmd).toBeDefined();
  });

  it("has reindex command", () => {
    const reindexCmd = program.commands.find((c) => c.name() === "reindex");
    expect(reindexCmd).toBeDefined();
  });

  it("has search command", () => {
    const searchCmd = program.commands.find((c) => c.name() === "search");
    expect(searchCmd).toBeDefined();
  });

  it("has related command", () => {
    const relatedCmd = program.commands.find((c) => c.name() === "related");
    expect(relatedCmd).toBeDefined();
  });

  it("has get command with subcommands", () => {
    const getCmd = program.commands.find((c) => c.name() === "get");
    expect(getCmd).toBeDefined();

    const subcommands = getCmd!.commands.map((c) => c.name());
    expect(subcommands).toContain("note");
    expect(subcommands).toContain("chunk");
    expect(subcommands).toContain("attachment");
  });

  it("has config command with subcommands", () => {
    const configCmd = program.commands.find((c) => c.name() === "config");
    expect(configCmd).toBeDefined();

    const subcommands = configCmd!.commands.map((c) => c.name());
    expect(subcommands).toContain("get");
    expect(subcommands).toContain("set");
    expect(subcommands).toContain("path");
    expect(subcommands).toContain("reveal-api-key");
  });
});

describe("CLI config commands", () => {
  let configDir: string;

  beforeEach(() => {
    configDir = createTempConfigDir();
  });

  afterEach(() => {
    fs.rmSync(configDir, { recursive: true, force: true });
  });

  it("config get without key shows all config", async () => {
    const configPath = createTempConfig(configDir);
    process.env.VAULT_AGENT_CONFIG_PATH = configPath;
    process.env.VAULT_AGENT_VAULT_ROOT = "/test/vault/path";

    try {
      const { ConfigManager } = await import("@vault-agent/core");
      const manager = new ConfigManager(configPath);
      const config = manager.load();
      expect(config.vault.root).toBe("/test/vault/path");
    } finally {
      delete process.env.VAULT_AGENT_CONFIG_PATH;
      delete process.env.VAULT_AGENT_VAULT_ROOT;
    }
  });

  it("config set writes a value to the config file", async () => {
    const configPath = createTempConfig(configDir);

    const { ConfigManager } = await import("@vault-agent/core");
    const manager = new ConfigManager(configPath);
    manager.set("server.port", 9999);

    const config = manager.load();
    expect(config.server.port).toBe(9999);
  });

  it("config set with boolean value", async () => {
    const configPath = createTempConfig(configDir);

    const { ConfigManager } = await import("@vault-agent/core");
    const manager = new ConfigManager(configPath);
    manager.set("embedding.enabled", true);

    const config = manager.load();
    expect(config.embedding.enabled).toBe(true);
  });

  it("config path returns the resolved path", async () => {
    const { ConfigManager } = await import("@vault-agent/core");
    const manager = new ConfigManager("/test/path/config.toml");
    expect(manager.getPath()).toBe("/test/path/config.toml");
  });

  it("isSecretKey identifies server.apiKey as secret", async () => {
    const { ConfigManager } = await import("@vault-agent/core");
    const manager = new ConfigManager("/test/config.toml");
    expect(manager.isSecretKey("server.apiKey")).toBe(true);
    expect(manager.isSecretKey("server.port")).toBe(false);
  });
});

describe("CLI endpoint resolution", () => {
  it("resolves endpoint from config", async () => {
    const configDir = createTempConfigDir();
    const configPath = createTempConfig(configDir);
    process.env.VAULT_AGENT_CONFIG_PATH = configPath;
    delete process.env.VAULT_AGENT_SERVER_ENDPOINT;

    try {
      const { loadConfig } = await import("@vault-agent/core");
      const config = loadConfig(configPath);
      expect(config.server.endpoint).toBe("http://127.0.0.1:8787");
    } finally {
      delete process.env.VAULT_AGENT_CONFIG_PATH;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });

  it("resolves endpoint from environment variable", async () => {
    const configDir = createTempConfigDir();
    const configPath = createTempConfig(configDir);
    process.env.VAULT_AGENT_CONFIG_PATH = configPath;
    process.env.VAULT_AGENT_SERVER_ENDPOINT = "http://localhost:9999";

    try {
      const { loadConfig } = await import("@vault-agent/core");
      const config = loadConfig(configPath);
      expect(config.server.endpoint).toBe("http://localhost:9999");
    } finally {
      delete process.env.VAULT_AGENT_CONFIG_PATH;
      delete process.env.VAULT_AGENT_SERVER_ENDPOINT;
      fs.rmSync(configDir, { recursive: true, force: true });
    }
  });
});

describe("CLI HTTP error handling", () => {
  it("treats non-2xx index responses as command failures", () => {
    const result = getCommandResultFromHttpResponse(409, {
      error: {
        code: "INDEX_NOT_FOUND",
        message: "No usable index.",
      },
    });

    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.message).toBe("INDEX_NOT_FOUND: No usable index.");
  });

  it("treats successful index responses as command success", () => {
    const result = getCommandResultFromHttpResponse(200, {
      data: {
        mode: "incremental",
      },
      warnings: [],
    });

    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
  });
});

describe("CLI format output helpers", () => {
  it("search command supports --mode flag", () => {
    const searchCmd = program.commands.find((c) => c.name() === "search");
    expect(searchCmd).toBeDefined();
    const modeOption = searchCmd!.options.find((o) => o.long === "--mode");
    expect(modeOption).toBeDefined();
  });

  it("search command supports --limit flag", () => {
    const searchCmd = program.commands.find((c) => c.name() === "search");
    expect(searchCmd).toBeDefined();
    const limitOption = searchCmd!.options.find((o) => o.long === "--limit");
    expect(limitOption).toBeDefined();
  });

  it("related command supports --type flag", () => {
    const relatedCmd = program.commands.find((c) => c.name() === "related");
    expect(relatedCmd).toBeDefined();
    const typeOption = relatedCmd!.options.find((o) => o.long === "--type");
    expect(typeOption).toBeDefined();
  });

  it("attachment download requires --output flag", () => {
    const getCmd = program.commands.find((c) => c.name() === "get");
    const attCmd = getCmd!.commands.find((c) => c.name() === "attachment");
    expect(attCmd).toBeDefined();
    const outputOption = attCmd!.options.find((o) => o.long === "--output");
    expect(outputOption).toBeDefined();
    const downloadOption = attCmd!.options.find((o) => o.long === "--download");
    expect(downloadOption).toBeDefined();
  });

  it("serve command supports --vault-root flag", () => {
    const serveCmd = program.commands.find((c) => c.name() === "serve");
    expect(serveCmd).toBeDefined();
    const vrOption = serveCmd!.options.find((o) => o.long === "--vault-root");
    expect(vrOption).toBeDefined();
  });
});

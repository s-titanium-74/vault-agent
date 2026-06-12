import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager, DEFAULT_CONFIG } from "../src/config.js";
import { ConfigError } from "../src/errors.js";

function writeTOML(testDir: string, content: string): string {
  const configPath = path.join(testDir, "config.toml");
  fs.writeFileSync(configPath, content, "utf-8");
  return configPath;
}

describe("ConfigManager", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-cfg-"));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("loads default config with vault root when no file exists", () => {
    const configPath = path.join(testDir, "config.toml");
    const manager = new ConfigManager(configPath);
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test-vault";
    try {
      const config = manager.load();
      expect(config.server.host).toBe("127.0.0.1");
      expect(config.server.port).toBe(8787);
      expect(config.embedding.enabled).toBe(false);
      expect(config.vault.root).toBe("/tmp/test-vault");
    } finally {
      delete process.env.VAULT_AGENT_VAULT_ROOT;
    }
  });

  it("sets and gets config values", () => {
    const configPath = path.join(testDir, "config.toml");
    const manager = new ConfigManager(configPath);

    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test-vault";
    try {
      manager.set("server.port", "9090");
      manager.set("vault.root", "/tmp/test-vault");
      const config = manager.load();
      expect(config.server.port).toBe(9090);
    } finally {
      delete process.env.VAULT_AGENT_VAULT_ROOT;
    }
  });

  it("identifies secret keys", () => {
    const manager = new ConfigManager("/tmp/vault-agent-test/config.toml");
    expect(manager.isSecretKey("server.apiKey")).toBe(true);
    expect(manager.isSecretKey("server.port")).toBe(false);
  });

  it("masks secret values in formatValue", () => {
    const manager = new ConfigManager("/tmp/vault-agent-test/config.toml");
    const result = manager.formatValue("server.apiKey", "secret-value");
    expect(result.set).toBe(true);
    expect(result.value).toBeUndefined();

    const emptyResult = manager.formatValue("server.apiKey", "");
    expect(emptyResult.set).toBe(false);
  });
});

describe("DEFAULT_CONFIG", () => {
  it("has sane defaults", () => {
    expect(DEFAULT_CONFIG.server.host).toBe("127.0.0.1");
    expect(DEFAULT_CONFIG.server.port).toBe(8787);
    expect(DEFAULT_CONFIG.server.apiKey).toBe("");
    expect(DEFAULT_CONFIG.embedding.enabled).toBe(false);
    expect(DEFAULT_CONFIG.cors.enabled).toBe(false);
    expect(DEFAULT_CONFIG.index.dir).toBe("");
  });
});

describe("TOML parsing (smol-toml)", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-cfg-"));
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("parses a valid TOML config file", () => {
    const keys = Object.keys(process.env).filter(k => k.startsWith("VAULT_AGENT_"));
    for (const k of keys) { const v = process.env[k]; delete process.env[k]; if (v !== undefined) process.env[k] = v; }
    delete process.env.VAULT_AGENT_VAULT_ROOT;
    const configPath = writeTOML(testDir, `[vault]
root = "/my/vault"
exclude = ["node_modules", ".git"]

[server]
host = "0.0.0.0"
port = 9999
api_key = "secret123"
log_level = "debug"

[index]
dir = "/tmp/index"

[embedding]
enabled = true
endpoint = "http://localhost:11434/v1/embeddings"
model = "nomic-embed-text"
require = true

[cors]
enabled = true
allowed_origins = ["http://localhost:3000"]
`);
      const manager = new ConfigManager(configPath);
      const config = manager.load();
      expect(config.vault.root).toBe("/my/vault");
      expect(config.vault.exclude).toEqual(["node_modules", ".git"]);
      expect(config.server.host).toBe("0.0.0.0");
      expect(config.server.port).toBe(9999);
      expect(config.server.apiKey).toBe("secret123");
      expect(config.server.logLevel).toBe("debug");
      expect(config.index.dir).toBe("/tmp/index");
      expect(config.embedding.enabled).toBe(true);
      expect(config.embedding.model).toBe("nomic-embed-text");
      expect(config.embedding.require).toBe(true);
      expect(config.cors.enabled).toBe(true);
      expect(config.cors.allowedOrigins).toEqual(["http://localhost:3000"]);
  });

  it("parses camelCase config keys", () => {
    delete process.env.VAULT_AGENT_VAULT_ROOT;
    const configPath = writeTOML(testDir, `[vault]
root = "/tmp/vault"

[server]
apiKey = "my-key"
logLevel = "warn"

[cors]
allowedOrigins = ["http://localhost:5173"]
`);
      const manager = new ConfigManager(configPath);
      const config = manager.load();
      expect(config.server.apiKey).toBe("my-key");
      expect(config.server.logLevel).toBe("warn");
      expect(config.cors.allowedOrigins).toEqual(["http://localhost:5173"]);
  });

  it("rejects unknown config sections", () => {
    delete process.env.VAULT_AGENT_VAULT_ROOT;
    const configPath = writeTOML(testDir, `[unknown_section]
foo = "bar"
`);
      const manager = new ConfigManager(configPath);
      expect(() => manager.load()).toThrow(ConfigError);
      expect(() => manager.load()).toThrow(/Unknown configuration section/);
  });

  it("rejects unknown config keys in known sections", () => {
    delete process.env.VAULT_AGENT_VAULT_ROOT;
    const configPath = writeTOML(testDir, `[server]
host = "127.0.0.1"
unknown_key = "value"
`);
      const manager = new ConfigManager(configPath);
      expect(() => manager.load()).toThrow(ConfigError);
      expect(() => manager.load()).toThrow(/Unknown configuration key/);
  });

  it("round-trips config through set and load", () => {
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/vault";
    try {
      const configPath = path.join(testDir, "config.toml");
      const manager = new ConfigManager(configPath);
      manager.set("server.port", "9090");
      manager.set("vault.root", "/tmp/vault");

      const reloaded = manager.load();
      expect(reloaded.server.port).toBe(9090);
      expect(reloaded.vault.root).toBe("/tmp/vault");
    } finally {
      delete process.env.VAULT_AGENT_VAULT_ROOT;
    }
  });

  it("handles TOML multiline strings and complex values", () => {
    delete process.env.VAULT_AGENT_VAULT_ROOT;
    const configPath = writeTOML(testDir, `[vault]
root = "/tmp/vault"
exclude = []

[server]
host = "127.0.0.1"
port = 8787
api_key = ""
log_level = "info"

[index]
dir = ""

[embedding]
enabled = false
endpoint = "http://127.0.0.1:11434/v1/embeddings"
model = ""
require = false

[cors]
enabled = false
allowed_origins = []
`);
      const manager = new ConfigManager(configPath);
      const config = manager.load();
      expect(config.vault.exclude).toEqual([]);
      expect(config.cors.allowedOrigins).toEqual([]);
  });

  it("rejects setting unknown keys via setDottedKey", () => {
    const configPath = path.join(testDir, "config.toml");
    const manager = new ConfigManager(configPath);
    expect(() => manager.set("server.unknownKey", "value")).toThrow(ConfigError);
  });
});
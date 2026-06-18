import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ConfigManager,
  DEFAULT_CONFIG,
  configSchema,
  type Config,
} from "../src/config.js";
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
    const keys = Object.keys(process.env).filter((k) =>
      k.startsWith("VAULT_AGENT_"),
    );
    for (const k of keys) {
      const v = process.env[k];
      delete process.env[k];
      if (v !== undefined) process.env[k] = v;
    }
    delete process.env.VAULT_AGENT_VAULT_ROOT;
    const configPath = writeTOML(
      testDir,
      `[vault]
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
`,
    );
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
    const configPath = writeTOML(
      testDir,
      `[vault]
root = "/tmp/vault"

[server]
apiKey = "my-key"
logLevel = "warn"

[cors]
allowedOrigins = ["http://localhost:5173"]
`,
    );
    const manager = new ConfigManager(configPath);
    const config = manager.load();
    expect(config.server.apiKey).toBe("my-key");
    expect(config.server.logLevel).toBe("warn");
    expect(config.cors.allowedOrigins).toEqual(["http://localhost:5173"]);
  });

  it("rejects unknown config sections", () => {
    delete process.env.VAULT_AGENT_VAULT_ROOT;
    const configPath = writeTOML(
      testDir,
      `[unknown_section]
foo = "bar"
`,
    );
    const manager = new ConfigManager(configPath);
    expect(() => manager.load()).toThrow(ConfigError);
    expect(() => manager.load()).toThrow(/Unknown configuration section/);
  });

  it("rejects unknown config keys in known sections", () => {
    delete process.env.VAULT_AGENT_VAULT_ROOT;
    const configPath = writeTOML(
      testDir,
      `[server]
host = "127.0.0.1"
unknown_key = "value"
`,
    );
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
    const configPath = writeTOML(
      testDir,
      `[vault]
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
`,
    );
    const manager = new ConfigManager(configPath);
    const config = manager.load();
    expect(config.vault.exclude).toEqual([]);
    expect(config.cors.allowedOrigins).toEqual([]);
  });

  it("rejects setting unknown keys via setDottedKey", () => {
    const configPath = path.join(testDir, "config.toml");
    const manager = new ConfigManager(configPath);
    expect(() => manager.set("server.unknownKey", "value")).toThrow(
      ConfigError,
    );
  });

  it("parses watch and sync config sections", () => {
    delete process.env.VAULT_AGENT_VAULT_ROOT;
    const configPath = writeTOML(
      testDir,
      `[vault]
root = "/tmp/vault"

[watch]
enabled = false
debounce_ms = 5000
max_batch_delay_ms = 30000
ignore_initial = false

[sync]
enabled = true
repo = "/tmp/repo"
remote = "upstream"
branch = "main"
interval_seconds = 600
webhook_enabled = true
webhook_secret = "shh"
pull_timeout_seconds = 60
failure_backoff_seconds = 1800
`,
    );
    const manager = new ConfigManager(configPath);
    const config = manager.load();
    expect(config.watch.enabled).toBe(false);
    expect(config.watch.debounce_ms).toBe(5000);
    expect(config.watch.max_batch_delay_ms).toBe(30000);
    expect(config.watch.ignore_initial).toBe(false);
    expect(config.sync.enabled).toBe(true);
    expect(config.sync.repo).toBe("/tmp/repo");
    expect(config.sync.remote).toBe("upstream");
    expect(config.sync.branch).toBe("main");
    expect(config.sync.interval_seconds).toBe(600);
    expect(config.sync.webhook_enabled).toBe(true);
    expect(config.sync.webhook_secret).toBe("shh");
    expect(config.sync.pull_timeout_seconds).toBe(60);
    expect(config.sync.failure_backoff_seconds).toBe(1800);
  });

  it("round-trips watch and sync config via set and load", () => {
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/vault";
    try {
      const configPath = path.join(testDir, "config.toml");
      const manager = new ConfigManager(configPath);
      manager.set("watch.enabled", "false");
      manager.set("watch.debounce_ms", "5000");
      manager.set("sync.enabled", "true");
      manager.set("sync.repo", "/tmp/repo");

      const reloaded = manager.load();
      expect(reloaded.watch.enabled).toBe(false);
      expect(reloaded.watch.debounce_ms).toBe(5000);
      expect(reloaded.sync.enabled).toBe(true);
      expect(reloaded.sync.repo).toBe("/tmp/repo");
    } finally {
      delete process.env.VAULT_AGENT_VAULT_ROOT;
    }
  });

  it("rejects unknown watch keys", () => {
    delete process.env.VAULT_AGENT_VAULT_ROOT;
    const configPath = writeTOML(
      testDir,
      `[watch]
unknown_watch_key = true
`,
    );
    const manager = new ConfigManager(configPath);
    expect(() => manager.load()).toThrow(ConfigError);
    expect(() => manager.load()).toThrow(/Unknown configuration key/);
  });

  it("rejects unknown sync keys", () => {
    delete process.env.VAULT_AGENT_VAULT_ROOT;
    const configPath = writeTOML(
      testDir,
      `[sync]
unknown_sync_key = true
`,
    );
    const manager = new ConfigManager(configPath);
    expect(() => manager.load()).toThrow(ConfigError);
    expect(() => manager.load()).toThrow(/Unknown configuration key/);
  });

  it("rejects invalid watch debounce_ms (must be > 0)", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.watch.debounce_ms = 0;
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it("rejects invalid watch max_batch_delay_ms (must be >= debounce_ms)", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.watch.debounce_ms = 10000;
    bad.watch.max_batch_delay_ms = 5000;
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it("rejects invalid sync interval_seconds (must be >= 60)", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.sync.interval_seconds = 30;
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it("rejects invalid sync pull_timeout_seconds (must be > 0)", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.sync.pull_timeout_seconds = 0;
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it("rejects invalid sync failure_backoff_seconds (must be >= interval_seconds)", () => {
    const bad = structuredClone(DEFAULT_CONFIG);
    bad.sync.interval_seconds = 900;
    bad.sync.failure_backoff_seconds = 100;
    expect(() => configSchema.parse(bad)).toThrow();
  });

  it("masks sync.webhook_secret as a secret key", () => {
    const manager = new ConfigManager();
    expect(manager.isSecretKey("sync.webhook_secret")).toBe(true);
    const result = manager.formatValue("sync.webhook_secret", "super-secret");
    expect(result.set).toBe(true);
    expect(result.value).toBeUndefined();
  });
});

describe("Environment variable overrides", () => {
  const ENV_KEYS = [
    "VAULT_AGENT_WATCH_ENABLED",
    "VAULT_AGENT_WATCH_DEBOUNCE_MS",
    "VAULT_AGENT_WATCH_MAX_BATCH_DELAY_MS",
    "VAULT_AGENT_WATCH_IGNORE_INITIAL",
    "VAULT_AGENT_SYNC_ENABLED",
    "VAULT_AGENT_SYNC_REPO",
    "VAULT_AGENT_SYNC_REMOTE",
    "VAULT_AGENT_SYNC_BRANCH",
    "VAULT_AGENT_SYNC_INTERVAL_SECONDS",
    "VAULT_AGENT_SYNC_WEBHOOK_ENABLED",
    "VAULT_AGENT_SYNC_WEBHOOK_SECRET",
    "VAULT_AGENT_SYNC_PULL_TIMEOUT_SECONDS",
    "VAULT_AGENT_SYNC_FAILURE_BACKOFF_SECONDS",
    "VAULT_AGENT_MCP_ENABLED",
    "VAULT_AGENT_MCP_HTTP_ENDPOINT",
  ];

  function clearEnv(): void {
    for (const k of ENV_KEYS) {
      delete process.env[k];
    }
  }

  beforeEach(() => {
    clearEnv();
  });

  afterEach(() => {
    clearEnv();
  });

  it("VAULT_AGENT_WATCH_ENABLED=true enables watch", async () => {
    process.env.VAULT_AGENT_WATCH_ENABLED = "true";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.watch.enabled).toBe(true);
  });

  it("VAULT_AGENT_WATCH_ENABLED=false disables watch", async () => {
    process.env.VAULT_AGENT_WATCH_ENABLED = "false";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.watch.enabled).toBe(false);
  });

  it("VAULT_AGENT_WATCH_ENABLED=1 parses as true", async () => {
    process.env.VAULT_AGENT_WATCH_ENABLED = "1";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.watch.enabled).toBe(true);
  });

  it("VAULT_AGENT_WATCH_ENABLED=0 parses as false", async () => {
    process.env.VAULT_AGENT_WATCH_ENABLED = "0";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.watch.enabled).toBe(false);
  });

  it("VAULT_AGENT_WATCH_DEBOUNCE_MS sets debounce", async () => {
    process.env.VAULT_AGENT_WATCH_DEBOUNCE_MS = "5000";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.watch.debounce_ms).toBe(5000);
  });

  it("VAULT_AGENT_WATCH_MAX_BATCH_DELAY_MS sets max batch delay", async () => {
    process.env.VAULT_AGENT_WATCH_MAX_BATCH_DELAY_MS = "120000";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.watch.max_batch_delay_ms).toBe(120000);
  });

  it("VAULT_AGENT_WATCH_IGNORE_INITIAL=false is parsed", async () => {
    process.env.VAULT_AGENT_WATCH_IGNORE_INITIAL = "false";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.watch.ignore_initial).toBe(false);
  });

  it("VAULT_AGENT_SYNC_ENABLED=true enables sync", async () => {
    process.env.VAULT_AGENT_SYNC_ENABLED = "true";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.sync.enabled).toBe(true);
  });

  it("VAULT_AGENT_SYNC_REPO sets sync repo", async () => {
    process.env.VAULT_AGENT_SYNC_REPO = "/tmp/myrepo";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.sync.repo).toBe("/tmp/myrepo");
  });

  it("VAULT_AGENT_SYNC_REMOTE sets sync remote", async () => {
    process.env.VAULT_AGENT_SYNC_REMOTE = "upstream";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.sync.remote).toBe("upstream");
  });

  it("VAULT_AGENT_SYNC_BRANCH sets sync branch", async () => {
    process.env.VAULT_AGENT_SYNC_BRANCH = "develop";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.sync.branch).toBe("develop");
  });

  it("VAULT_AGENT_SYNC_INTERVAL_SECONDS sets interval", async () => {
    process.env.VAULT_AGENT_SYNC_INTERVAL_SECONDS = "300";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.sync.interval_seconds).toBe(300);
  });

  it("VAULT_AGENT_SYNC_WEBHOOK_ENABLED sets webhook enabled", async () => {
    process.env.VAULT_AGENT_SYNC_WEBHOOK_ENABLED = "true";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.sync.webhook_enabled).toBe(true);
  });

  it("VAULT_AGENT_SYNC_WEBHOOK_SECRET sets webhook secret", async () => {
    process.env.VAULT_AGENT_SYNC_WEBHOOK_SECRET = "shh-secret";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.sync.webhook_secret).toBe("shh-secret");
  });

  it("VAULT_AGENT_SYNC_PULL_TIMEOUT_SECONDS sets pull timeout", async () => {
    process.env.VAULT_AGENT_SYNC_PULL_TIMEOUT_SECONDS = "60";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.sync.pull_timeout_seconds).toBe(60);
  });

  it("VAULT_AGENT_SYNC_FAILURE_BACKOFF_SECONDS sets backoff", async () => {
    process.env.VAULT_AGENT_SYNC_FAILURE_BACKOFF_SECONDS = "7200";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.sync.failure_backoff_seconds).toBe(7200);
  });

  it("VAULT_AGENT_MCP_ENABLED sets MCP enabled", async () => {
    process.env.VAULT_AGENT_MCP_ENABLED = "true";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.mcp.enabled).toBe(true);
  });

  it("VAULT_AGENT_MCP_HTTP_ENDPOINT sets nested endpoint", async () => {
    process.env.VAULT_AGENT_MCP_HTTP_ENDPOINT = "/agent-mcp";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    const config = applyEnvOverrides(base);
    expect(config.mcp.http.endpoint).toBe("/agent-mcp");
  });

  it("invalid boolean value for VAULT_AGENT_WATCH_ENABLED throws", async () => {
    process.env.VAULT_AGENT_WATCH_ENABLED = "maybe";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    expect(() => applyEnvOverrides(base)).toThrow();
  });

  it("invalid numeric value for VAULT_AGENT_WATCH_DEBOUNCE_MS throws", async () => {
    process.env.VAULT_AGENT_WATCH_DEBOUNCE_MS = "not-a-number";
    const { applyEnvOverrides, DEFAULT_CONFIG: def } =
      await import("../src/config.js");
    const base = structuredClone(def);
    base.vault.root = "/tmp/test-vault";
    expect(() => applyEnvOverrides(base)).toThrow();
  });
});

describe("MCP endpoint validation", () => {
  function baseConfig(endpoint: string): Config {
    const config = structuredClone(DEFAULT_CONFIG);
    config.vault.root = "/tmp/test-vault";
    config.mcp.enabled = true;
    config.mcp.http.endpoint = endpoint;
    return config;
  }

  it("accepts default /mcp endpoint", () => {
    const result = configSchema.safeParse(baseConfig("/mcp"));
    expect(result.success).toBe(true);
  });

  it("rejects endpoint without leading slash", () => {
    const result = configSchema.safeParse(baseConfig("mcp"));
    expect(result.success).toBe(false);
  });

  it("rejects endpoint with path traversal", () => {
    const result = configSchema.safeParse(baseConfig("/mcp/../search"));
    expect(result.success).toBe(false);
  });

  it("rejects endpoint conflicting with reserved path", () => {
    const result = configSchema.safeParse(baseConfig("/search"));
    expect(result.success).toBe(false);
  });

  it("rejects endpoint under reserved path", () => {
    const result = configSchema.safeParse(baseConfig("/notes/mcp"));
    expect(result.success).toBe(false);
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ConfigManager,
  applyEnvOverrides,
  DEFAULT_CONFIG,
} from "../src/config.js";
import { ConfigError } from "../src/errors.js";

describe("applyEnvOverrides", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    const keys = Object.keys(process.env).filter((k) =>
      k.startsWith("VAULT_AGENT_"),
    );
    for (const k of keys) {
      originalEnv[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    const keys = Object.keys(process.env).filter((k) =>
      k.startsWith("VAULT_AGENT_"),
    );
    for (const k of keys) {
      delete process.env[k];
    }
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v !== undefined) process.env[k] = v;
    }
  });

  it("applies VAULT_AGENT_SERVER_PORT with valid integer", () => {
    process.env.VAULT_AGENT_SERVER_PORT = "9090";
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test";
    const result = applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
    expect(result.server.port).toBe(9090);
  });

  it("throws ConfigError for non-numeric VAULT_AGENT_SERVER_PORT", () => {
    process.env.VAULT_AGENT_SERVER_PORT = "not-a-number";
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test";
    expect(() => applyEnvOverrides(structuredClone(DEFAULT_CONFIG))).toThrow();
  });

  it("applies VAULT_AGENT_EMBEDDING_ENABLED with 'true'", () => {
    process.env.VAULT_AGENT_EMBEDDING_ENABLED = "true";
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test";
    const result = applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
    expect(result.embedding.enabled).toBe(true);
  });

  it("applies VAULT_AGENT_EMBEDDING_ENABLED with '1'", () => {
    process.env.VAULT_AGENT_EMBEDDING_ENABLED = "1";
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test";
    const result = applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
    expect(result.embedding.enabled).toBe(true);
  });

  it("applies VAULT_AGENT_EMBEDDING_ENABLED with 'false'", () => {
    process.env.VAULT_AGENT_EMBEDDING_ENABLED = "false";
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test";
    const result = applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
    expect(result.embedding.enabled).toBe(false);
  });

  it("applies VAULT_AGENT_EMBEDDING_ENABLED with '0'", () => {
    process.env.VAULT_AGENT_EMBEDDING_ENABLED = "0";
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test";
    const result = applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
    expect(result.embedding.enabled).toBe(false);
  });

  it("throws ConfigError for invalid boolean value in VAULT_AGENT_EMBEDDING_ENABLED", () => {
    process.env.VAULT_AGENT_EMBEDDING_ENABLED = "yes";
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test";
    expect(() => applyEnvOverrides(structuredClone(DEFAULT_CONFIG))).toThrow();
  });

  it("applies VAULT_AGENT_API_KEY", () => {
    process.env.VAULT_AGENT_API_KEY = "test-api-key";
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test";
    const result = applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
    expect(result.server.apiKey).toBe("test-api-key");
  });

  it("applies VAULT_AGENT_LOG_LEVEL", () => {
    process.env.VAULT_AGENT_LOG_LEVEL = "debug";
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test";
    const result = applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
    expect(result.server.logLevel).toBe("debug");
  });

  it("skips empty string env values", () => {
    process.env.VAULT_AGENT_SERVER_PORT = "";
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test";
    const result = applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
    expect(result.server.port).toBe(DEFAULT_CONFIG.server.port);
  });

  it("applies VAULT_AGENT_VAULT_ROOT", () => {
    process.env.VAULT_AGENT_VAULT_ROOT = "/my/vault/path";
    const result = applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
    expect(result.vault.root).toBe("/my/vault/path");
  });

  it("applies VAULT_AGENT_SERVER_HOST", () => {
    process.env.VAULT_AGENT_SERVER_HOST = "0.0.0.0";
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test";
    const result = applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
    expect(result.server.host).toBe("0.0.0.0");
  });

  it("applies VAULT_AGENT_CORS_ENABLED with 'true'", () => {
    process.env.VAULT_AGENT_CORS_ENABLED = "true";
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test";
    const result = applyEnvOverrides(structuredClone(DEFAULT_CONFIG));
    expect(result.cors.enabled).toBe(true);
  });

  it("throws ConfigError for invalid VAULT_AGENT_CORS_ENABLED", () => {
    process.env.VAULT_AGENT_CORS_ENABLED = "maybe";
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/test";
    expect(() => applyEnvOverrides(structuredClone(DEFAULT_CONFIG))).toThrow();
  });
});

describe("ConfigManager with env overrides", () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-cfg-"));
    const keys = Object.keys(process.env).filter((k) =>
      k.startsWith("VAULT_AGENT_"),
    );
    for (const k of keys) {
      delete process.env[k];
    }
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it("loads config from file and applies env overrides", () => {
    process.env.VAULT_AGENT_VAULT_ROOT = "/tmp/env-vault";
    process.env.VAULT_AGENT_SERVER_PORT = "7777";

    try {
      const configPath = path.join(testDir, "config.toml");
      const manager = new ConfigManager(configPath);
      manager.set("vault.root", "/tmp/file-vault");
      manager.set("server.port", "5555");

      const config = manager.load();
      expect(config.vault.root).toBe("/tmp/env-vault");
      expect(config.server.port).toBe(7777);
    } finally {
      delete process.env.VAULT_AGENT_VAULT_ROOT;
      delete process.env.VAULT_AGENT_SERVER_PORT;
    }
  });
});

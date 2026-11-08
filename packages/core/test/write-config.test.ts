import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { ConfigManager, configSchema, DEFAULT_CONFIG } from "../src/config.js";

describe("opt-in write configuration", () => {
  let directory: string, file: string;
  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-write-config-"),
    );
    file = path.join(directory, "config.toml");
    fs.writeFileSync(file, 'vault.root = "synthetic-vault"\n');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  it("defaults off with existing configs and persists explicit changes in user-local TOML", () => {
    const manager = new ConfigManager(file);
    expect(manager.load().write).toMatchObject({
      enabled: false,
      mode: "review",
    });
    manager.set("write.enabled", "true");
    manager.set("write.mode", "direct");
    manager.set("write.max_file_bytes", "4096");
    expect(manager.load().write).toMatchObject({
      enabled: true,
      mode: "direct",
      max_file_bytes: 4096,
    });
    expect(fs.readFileSync(file, "utf8")).toContain("[write]");
  });
  it.each([
    ["write.mode", "force"],
    ["write.max_file_bytes", "0"],
    ["write.max_batch_operations", "101"],
    ["write.history_retention_days", "7.5"],
    ["write.max_file_bytes", "5abc"],
  ])("rejects invalid %s without overwriting config", (key, value) => {
    const original = fs.readFileSync(file, "utf8");
    expect(() => new ConfigManager(file).set(key!, value)).toThrow();
    expect(fs.readFileSync(file, "utf8")).toBe(original);
  });
  it("uses environment overrides and validates unsupported runtime settings", () => {
    vi.stubEnv("VAULT_AGENT_WRITE_ENABLED", "true");
    vi.stubEnv("VAULT_AGENT_WRITE_MODE", "direct");
    vi.stubEnv("VAULT_AGENT_WRITE_HISTORY_RETENTION_DAYS", "14");
    expect(new ConfigManager(file).load().write).toMatchObject({
      enabled: true,
      mode: "direct",
      history_retention_days: 14,
    });
    vi.stubEnv("VAULT_AGENT_WRITE_MAX_BATCH_BYTES", "20971521");
    expect(() => new ConfigManager(file).load()).toThrow();
    vi.stubEnv("VAULT_AGENT_WRITE_MAX_BATCH_BYTES", "5abc");
    expect(() => new ConfigManager(file).load()).toThrow();
  });
  it("rejects unknown TOML safety fields", () => {
    fs.appendFileSync(file, "[write]\nforce = true\n");
    expect(() => new ConfigManager(file).load()).toThrow();
  });
  it("accepts explicit direct pCloud writes through schema, user config and environment", () => {
    expect(
      configSchema.safeParse({
        ...DEFAULT_CONFIG,
        vault: {
          ...DEFAULT_CONFIG.vault,
          pcloud: {
            region: "us",
            folder_id: "0",
            access_token: "synthetic",
            includes: ["."],
          },
        },
        write: { ...DEFAULT_CONFIG.write, enabled: true, mode: "direct" },
      }).success,
    ).toBe(true);
    fs.writeFileSync(
      file,
      `[vault.pcloud]
region = "us"
folder_id = "1"
access_token = "synthetic"
includes = ["Notes"]
`,
    );
    const manager = new ConfigManager(file);
    expect(manager.load().write).toMatchObject({
      enabled: false,
      mode: "review",
    });
    manager.set("write.enabled", "true");
    expect(manager.load().write.mode).toBe("review");
    manager.set("write.mode", "direct");
    expect(manager.load().write).toMatchObject({
      enabled: true,
      mode: "direct",
    });
    manager.set("write.mode", "review");
    vi.stubEnv("VAULT_AGENT_WRITE_MODE", "direct");
    expect(manager.load().write.mode).toBe("direct");
    vi.stubEnv("VAULT_AGENT_WRITE_MAX_BATCH_BYTES", "20971521");
    expect(() => manager.load()).toThrow();
  });
  it("rejects write-enabled index storage inside the source before runtime I/O", () => {
    const config = {
      ...structuredClone(DEFAULT_CONFIG),
      vault: { root: path.join(directory, "vault"), exclude: [] },
      index: { dir: path.join(directory, "vault", "index") },
      write: { ...DEFAULT_CONFIG.write, enabled: true },
    };
    expect(configSchema.safeParse(config).success).toBe(false);
    expect(fs.existsSync(config.index.dir)).toBe(false);
  });
});

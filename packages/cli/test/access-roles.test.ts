import { afterEach, expect, it, vi } from "vitest";
import { Command } from "commander";
import { ConfigManager, DEFAULT_CONFIG } from "@vault-agent/core";
import { createCliContext } from "../src/context.js";
import { registerSearchCommands } from "../src/commands/search.js";
import { registerIndexingCommands } from "../src/commands/indexing.js";
import { registerSyncCommands } from "../src/commands/sync.js";
import { registerConfigCommands } from "../src/commands/config.js";
import { keys } from "../../core/test/access-cases.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("round-trips role keys, applies environment overrides and redacts config output", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-roles-"));
  const file = path.join(dir, "config.toml");
  try {
    const manager = new ConfigManager(file);
    manager.set("vault.root", "synthetic-vault");
    for (const [name, value] of Object.entries({
      readKey: keys.read,
      readwriteKey: keys.readwrite,
      previousReadwriteKey: keys.oldReadwrite,
      adminKey: keys.admin,
      previousReadKey: keys.oldRead,
      previousAdminKey: keys.oldAdmin,
    })) {
      manager.set(`server.${name}`, value);
      expect(manager.isSecretKey(`server.${name}`)).toBe(true);
      expect(manager.formatValue(`server.${name}`, value)).toEqual({
        set: true,
      });
    }
    expect(manager.load().server.previousAdminKey).toBe(keys.oldAdmin);
    vi.stubEnv("VAULT_AGENT_READWRITE_KEY", keys.readwrite);
    vi.stubEnv("VAULT_AGENT_PREVIOUS_READWRITE_KEY", "");
    expect(manager.load().server.readwriteKey).toBe(keys.readwrite);
    expect(manager.load().server.previousReadwriteKey).toBe("");
    vi.stubEnv("VAULT_AGENT_READ_KEY", keys.revoked);
    vi.stubEnv("VAULT_AGENT_PREVIOUS_READ_KEY", "");
    expect(manager.load().server.readKey).toBe(keys.revoked);
    expect(manager.load().server.previousReadKey).toBe("");
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const args of [
      ["config", "get", "--json"],
      ["config", "get", "server", "--json"],
      ["config", "get", "server.adminKey", "--json"],
      ["config", "get"],
    ]) {
      const program = new Command().option("--config <path>");
      registerConfigCommands(program, createCliContext(program));
      await program.parseAsync(["--config", file, ...args], { from: "user" });
    }
    const text = JSON.stringify(output.mock.calls);
    for (const value of Object.values(keys)) expect(text).not.toContain(value);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
it.each([
  { args: ["search", "synthetic", "--json"], key: keys.read },
  { args: ["index", "--json"], key: keys.admin },
  { args: ["reindex", "--json"], key: keys.admin },
  { args: ["sync", "status", "--json"], key: keys.read },
  { args: ["sync", "pull", "--json"], key: keys.admin },
])("selects the role credential for $args", async ({ args, key }) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cli-roles-"));
  const file = path.join(dir, "config.toml");
  try {
    const manager = new ConfigManager(file);
    manager.set("vault.root", "synthetic-vault");
    manager.set("server.readKey", keys.read);
    manager.set("server.adminKey", keys.admin);
    const fetch = vi.fn(async () =>
      Response.json({
        data: { results: [], state: "completed" },
        warnings: [],
      }),
    );
    vi.stubGlobal("fetch", fetch);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    for (const override of [false, true]) {
      const program = new Command()
        .option("--config <path>")
        .option("--api-key <key>");
      const context = createCliContext(program);
      registerSearchCommands(program, context);
      registerIndexingCommands(program, context);
      registerSyncCommands(program, context);
      await program.parseAsync(
        [
          "--config",
          file,
          ...(override ? ["--api-key", keys.oldAdmin] : []),
          ...args,
        ],
        { from: "user" },
      );
      expect(
        new Headers(
          (fetch.mock.calls.at(-1) as unknown as [string, RequestInit])[1]
            .headers,
        ).get("Authorization"),
      ).toBe(`Bearer ${override ? keys.oldAdmin : key}`);
    }
    expect(JSON.stringify(output.mock.calls)).not.toContain(key);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("never falls back to an admin credential for a read-only client or mixed config", () => {
  const program = new Command().option("--api-key <key>");
  const context = createCliContext(program);
  const c = structuredClone(DEFAULT_CONFIG);
  c.server.adminKey = keys.admin;
  expect(context.resolveApiKey(c)).toBe("");
  c.server.adminKey = "";
  c.server.readKey = keys.read;
  expect(context.resolveApiKey(c, "admin")).toBe("");
  c.server.apiKey = keys.admin;
  expect(() => context.resolveApiKey(c)).toThrow("CONFIG_INVALID");
});

it("uses an editing client's key for reads and edits without admin fallback", () => {
  const context = createCliContext(new Command());
  const c = structuredClone(DEFAULT_CONFIG);
  c.server.readwriteKey = keys.readwrite;
  expect(context.resolveApiKey(c)).toBe(keys.readwrite);
  expect(context.resolveApiKey(c, "readwrite")).toBe(keys.readwrite);
  expect(context.resolveApiKey(c, "admin")).toBe("");
  c.server.readwriteKey = undefined;
  c.server.adminKey = keys.admin;
  expect(context.resolveApiKey(c, "readwrite")).toBe("");
  c.server.adminKey = undefined;
  c.server.apiKey = keys.admin;
  expect(context.resolveApiKey(c, "readwrite")).toBe("");
});

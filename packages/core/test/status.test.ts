import { describe, it, expect } from "vitest";
import { buildStatus } from "../src/status.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { FreshnessMachine, VaultWatcher, GitSync } from "../src/index.js";

describe("buildStatus", () => {
  it("returns a full status object with default config", () => {
    const status = buildStatus(DEFAULT_CONFIG);
    expect(status.server.running).toBe(true);
    expect(status.server.host).toBe("127.0.0.1");
    expect(status.server.port).toBe(8787);
    expect(status.index.freshness.state).toBe("unknown");
    expect(status.watch.enabled).toBe(true);
    expect(status.sync.enabled).toBe(false);
    expect("warnings" in status).toBe(false);
  });

  it("includes apiKeyRequired when an api key is configured", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.server.apiKey = "test-key";
    const status = buildStatus(config);
    expect(status.server.apiKeyRequired).toBe(true);
  });

  it("reflects real index freshness when overrides are provided", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const freshnessMachine = new FreshnessMachine("fresh");
    const status = buildStatus(config, {
      index: { freshness: freshnessMachine.info },
    });
    expect(status.index.freshness.state).toBe("fresh");
  });

  it("reflects watcher running state when overrides are provided", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const watcher = new VaultWatcher("/tmp/vault", []);
    const status = buildStatus(config, {
      watch: watcher.status,
    });
    expect(status.watch.state).toBe("starting");
    watcher.destroy();
  });

  it("reflects sync running state when overrides are provided", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const sync = new GitSync({
      repo: "",
      remote: "origin",
      branch: "",
      enabled: true,
    });
    const status = buildStatus(config, {
      sync: sync.status,
    });
    expect(status.sync.enabled).toBe(true);
    expect(status.sync.state).toBe("idle");
  });

  it("does not expose secret values in status output", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.server.apiKey = "super-secret-key";
    const status = buildStatus(config);
    expect(status.server.apiKeyRequired).toBe(true);
    const statusStr = JSON.stringify(status);
    expect(statusStr).not.toContain("super-secret-key");
  });

  it("does not include private absolute paths by default", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    config.vault.root = "/home/user/vault";
    const status = buildStatus(config);
    const statusStr = JSON.stringify(status);
    expect(statusStr).not.toContain("/home/user");
  });

  it("includes sync failure counts and last-success timestamps", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const sync = new GitSync({
      repo: "",
      remote: "origin",
      branch: "",
    });
    sync.setOnSyncComplete(() => {});
    const status = buildStatus(config, {
      sync: sync.status,
    });
    expect(status.sync.consecutiveFailures).toBe(0);
    expect(status.sync.lastSuccessfulSyncAt).toBeNull();
  });

  it("includes reindex-required reasons when index is incompatible", () => {
    const config = structuredClone(DEFAULT_CONFIG);
    const freshnessMachine = new FreshnessMachine("incompatible");
    freshnessMachine.markReindexRequired(["Schema version mismatch"]);
    const status = buildStatus(config, {
      index: { freshness: freshnessMachine.info },
    });
    expect(status.index.freshness.reindexRequired).toBe(true);
    expect(status.index.freshness.reindexReasons).toContain(
      "Schema version mismatch",
    );
  });
});

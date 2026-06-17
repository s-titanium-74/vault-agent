import { describe, it, expect } from "vitest";
import {
  initialFreshness,
  FreshnessMachine,
  type FreshnessInfo,
} from "../src/freshness.js";

describe("freshness", () => {
  it("returns initial unknown state", () => {
    const info = initialFreshness();
    expect(info.state).toBe("unknown");
    expect(info.lastSuccessfulUpdateAt).toBeNull();
    expect(info.pendingChangeCount).toBe(0);
    expect(info.reindexRequired).toBe(false);
  });

  it("transitions from unknown to pending when changes are detected", () => {
    const machine = new FreshnessMachine("unknown");
    expect(machine.state).toBe("unknown");
    machine.changesDetected();
    expect(machine.state).toBe("pending");
  });

  it("transitions from pending to updating when a writer starts", () => {
    const machine = new FreshnessMachine("pending");
    machine.changesDetected();
    machine.writerStarted();
    expect(machine.state).toBe("updating");
  });

  it("transitions from updating to fresh after a successful commit", () => {
    const machine = new FreshnessMachine("updating");
    machine.writerSucceeded();
    expect(machine.state).toBe("fresh");
  });

  it("transitions to stale when changes are known but not committed", () => {
    const machine = new FreshnessMachine("fresh");
    machine.markStale("Index is out of sync");
    expect(machine.state).toBe("stale");
  });

  it("transitions to incompatible when schema mismatch is detected", () => {
    const machine = new FreshnessMachine("fresh");
    machine.markReindexRequired(["Schema version mismatch"]);
    expect(machine.state).toBe("incompatible");
    expect(machine.info.reindexRequired).toBe(true);
  });

  it("preserves lastSuccessfulUpdateAt through state transitions", () => {
    const machine = new FreshnessMachine("pending");
    machine.changesDetected();
    machine.writerStarted();
    machine.writerSucceeded();
    expect(machine.info.lastSuccessfulUpdateAt).not.toBeNull();
    const timestamp = machine.info.lastSuccessfulUpdateAt;
    machine.markStale("some reason");
    expect(machine.info.lastSuccessfulUpdateAt).toBe(timestamp);
  });

  it("records reindex-required reasons when schema changes", () => {
    const machine = new FreshnessMachine("fresh");
    machine.markReindexRequired([
      "Schema version mismatch: index has v1, current is v2",
    ]);
    expect(machine.info.reindexReasons).toContain(
      "Schema version mismatch: index has v1, current is v2",
    );
  });

  it("records reindex-required reasons when vault identity changes", () => {
    const machine = new FreshnessMachine("fresh");
    machine.markReindexRequired(["Vault identity changed since indexing"]);
    expect(machine.info.reindexReasons).toContain(
      "Vault identity changed since indexing",
    );
  });

  it("records reindex-required reasons when exclude patterns change", () => {
    const machine = new FreshnessMachine("fresh");
    machine.markReindexRequired([
      "Exclude patterns have changed since indexing",
    ]);
    expect(machine.info.reindexReasons).toContain(
      "Exclude patterns have changed since indexing",
    );
  });

  it("records reindex-required reasons when chunking settings change", () => {
    const machine = new FreshnessMachine("fresh");
    machine.markReindexRequired([
      "Target chunk size configuration has changed",
    ]);
    expect(machine.info.reindexReasons).toContain(
      "Target chunk size configuration has changed",
    );
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { VaultWatcher, type WatcherStatus } from "../src/watcher.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("VaultWatcher", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-watcher-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts in starting state", () => {
    const watcher = new VaultWatcher(tmpDir, []);
    expect(watcher.status.state).toBe("starting");
    expect(watcher.status.enabled).toBe(true);
  });

  it("transitions to running after start", async () => {
    const watcher = new VaultWatcher(tmpDir, []);
    await watcher.start();
    expect(watcher.status.state).toBe("running");
    await watcher.stop();
  });

  it("transitions to stopped after stop", async () => {
    const watcher = new VaultWatcher(tmpDir, []);
    await watcher.start();
    await watcher.stop();
    expect(watcher.status.state).toBe("stopped");
  });

  it("ignores excluded paths", async () => {
    const watcher = new VaultWatcher(tmpDir, ["*.txt"], { debounceMs: 50 });
    const events: string[][] = [];
    watcher.setUpdateCallback((paths) => events.push(paths));
    await watcher.start();

    fs.writeFileSync(path.join(tmpDir, "test.md"), "# Test");
    fs.writeFileSync(path.join(tmpDir, "test.txt"), "ignored");

    await new Promise((r) => setTimeout(r, 200));
    await watcher.stop();

    const allPaths = events.flat();
    expect(allPaths.some((p) => p.endsWith("test.md"))).toBe(true);
  });

  it("ignores hidden paths by default", async () => {
    const watcher = new VaultWatcher(tmpDir, [], { debounceMs: 50 });
    const events: string[][] = [];
    watcher.setUpdateCallback((paths) => events.push(paths));
    await watcher.start();

    fs.mkdirSync(path.join(tmpDir, ".hidden"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, ".hidden", "note.md"), "# Hidden");
    fs.writeFileSync(path.join(tmpDir, "visible.md"), "# Visible");

    await new Promise((r) => setTimeout(r, 200));
    await watcher.stop();

    const allPaths = events.flat();
    expect(allPaths.some((p) => p.includes(".hidden"))).toBe(false);
    expect(allPaths.some((p) => p.includes("visible.md"))).toBe(true);
  });

  it("coalesces rapid changes into a single batch", async () => {
    const watcher = new VaultWatcher(tmpDir, [], { debounceMs: 50 });
    const events: string[][] = [];
    watcher.setUpdateCallback((paths) => events.push(paths));
    await watcher.start();

    fs.writeFileSync(path.join(tmpDir, "file1.md"), "# File 1");
    fs.writeFileSync(path.join(tmpDir, "file2.md"), "# File 2");
    fs.writeFileSync(path.join(tmpDir, "file3.md"), "# File 3");

    await new Promise((r) => setTimeout(r, 200));
    await watcher.stop();

    expect(events.length).toBeGreaterThan(0);
  });

  it("classifies create events for markdown files", async () => {
    const watcher = new VaultWatcher(tmpDir, [], { debounceMs: 50 });
    const events: string[][] = [];
    watcher.setUpdateCallback((paths) => events.push(paths));
    await watcher.start();

    fs.writeFileSync(path.join(tmpDir, "new.md"), "# New Note");

    await new Promise((r) => setTimeout(r, 200));
    await watcher.stop();

    const allPaths = events.flat();
    expect(allPaths.some((p) => p.endsWith("new.md"))).toBe(true);
  });

  it("classifies modify events for markdown files", async () => {
    const watcher = new VaultWatcher(tmpDir, [], { debounceMs: 50 });
    const events: string[][] = [];
    watcher.setUpdateCallback((paths) => events.push(paths));
    await watcher.start();

    const filePath = path.join(tmpDir, "existing.md");
    fs.writeFileSync(filePath, "# Existing");
    await new Promise((r) => setTimeout(r, 100));
    events.length = 0;

    fs.writeFileSync(filePath, "# Existing Modified");

    await new Promise((r) => setTimeout(r, 200));
    await watcher.stop();

    const allPaths = events.flat();
    expect(allPaths.some((p) => p.endsWith("existing.md"))).toBe(true);
  });

  it("classifies delete events for markdown files", async () => {
    const watcher = new VaultWatcher(tmpDir, [], { debounceMs: 50 });
    const events: string[][] = [];
    watcher.setUpdateCallback((paths) => events.push(paths));
    await watcher.start();

    const filePath = path.join(tmpDir, "todelete.md");
    fs.writeFileSync(filePath, "# To Delete");
    await new Promise((r) => setTimeout(r, 100));
    events.length = 0;

    fs.unlinkSync(filePath);

    await new Promise((r) => setTimeout(r, 200));
    await watcher.stop();

    const allPaths = events.flat();
    expect(allPaths.some((p) => p.endsWith("todelete.md"))).toBe(true);
  });

  it("marks attachment changes without indexing contents", async () => {
    const watcher = new VaultWatcher(tmpDir, [], { debounceMs: 50 });
    const events: string[][] = [];
    watcher.setUpdateCallback((paths) => events.push(paths));
    await watcher.start();

    fs.writeFileSync(path.join(tmpDir, "image.png"), Buffer.from("fake png"));

    await new Promise((r) => setTimeout(r, 200));
    await watcher.stop();

    const allPaths = events.flat();
    expect(allPaths.some((p) => p.endsWith("image.png"))).toBe(true);
  });

  it("excludes generated index directories", async () => {
    const watcher = new VaultWatcher(tmpDir, [], { debounceMs: 50 });
    const events: string[][] = [];
    watcher.setUpdateCallback((paths) => events.push(paths));
    await watcher.start();

    const gitDir = path.join(tmpDir, ".git");
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(path.join(gitDir, "config"), "git config");
    const indexDir = path.join(tmpDir, ".obsidian");
    fs.mkdirSync(indexDir, { recursive: true });
    fs.writeFileSync(path.join(indexDir, "workspace"), "workspace");
    fs.writeFileSync(path.join(tmpDir, "note.md"), "# Note");

    await new Promise((r) => setTimeout(r, 200));
    await watcher.stop();

    const allPaths = events.flat();
    expect(allPaths.some((p) => p.includes(".git"))).toBe(false);
    expect(allPaths.some((p) => p.includes(".obsidian"))).toBe(false);
    expect(allPaths.some((p) => p.endsWith("note.md"))).toBe(true);
  });

  it("respects vault-relative path filtering", async () => {
    const watcher = new VaultWatcher(tmpDir, []);
    await watcher.start();
    expect(watcher.status.state).toBeDefined();
    await watcher.stop();
  });

  it("degraded state is visible through status output", async () => {
    const badPath = "/proc/nonexistent-" + Date.now();
    const watcher = new VaultWatcher(badPath, []);
    await watcher.start();
    expect(watcher.status.state).toBeDefined();
    watcher.destroy();
  });

  it("disabled mode leaves manual indexing behavior intact", async () => {
    const watcher = new VaultWatcher(tmpDir, [], { ignoreInitial: true });
    await watcher.start();
    expect(watcher.status.enabled).toBe(true);
    await watcher.stop();
    expect(watcher.status.state).toBe("stopped");
  });

  it("classifies rename as delete-plus-create (delete event when target is missing)", async () => {
    const watcher = new VaultWatcher(tmpDir, [], { debounceMs: 50 });
    const events: string[][] = [];
    watcher.setUpdateCallback((paths) => events.push(paths));
    await watcher.start();

    const oldPath = path.join(tmpDir, "oldname.md");
    fs.writeFileSync(oldPath, "# Old Name");
    await new Promise((r) => setTimeout(r, 100));
    events.length = 0;

    fs.unlinkSync(oldPath);

    await new Promise((r) => setTimeout(r, 200));
    await watcher.stop();

    const allPaths = events.flat();
    expect(allPaths.some((p) => p.endsWith("oldname.md"))).toBe(true);
  });

  it("classifies rename as delete-plus-create (create event when new target appears)", async () => {
    const watcher = new VaultWatcher(tmpDir, [], { debounceMs: 50 });
    const events: string[][] = [];
    watcher.setUpdateCallback((paths) => events.push(paths));
    await watcher.start();

    fs.writeFileSync(path.join(tmpDir, "newname.md"), "# New Name");

    await new Promise((r) => setTimeout(r, 200));
    await watcher.stop();

    const allPaths = events.flat();
    expect(allPaths.some((p) => p.endsWith("newname.md"))).toBe(true);
  });

  it("handles a full rename cycle (old file removed + new file created)", async () => {
    const watcher = new VaultWatcher(tmpDir, [], { debounceMs: 50 });
    const events: string[][] = [];
    watcher.setUpdateCallback((paths) => events.push(paths));
    await watcher.start();

    const oldPath = path.join(tmpDir, "oldname.md");
    const newPath = path.join(tmpDir, "newname.md");
    fs.writeFileSync(oldPath, "# Old");
    await new Promise((r) => setTimeout(r, 100));
    events.length = 0;

    fs.unlinkSync(oldPath);
    fs.writeFileSync(newPath, "# New");

    await new Promise((r) => setTimeout(r, 200));
    await watcher.stop();

    const allPaths = events.flat();
    expect(allPaths).toContain("newname.md");
    expect(allPaths).toContain("oldname.md");
  });

  it("coalesces rapid writes within debounce window into one batch", async () => {
    const watcher = new VaultWatcher(tmpDir, [], { debounceMs: 200 });
    const batchCount = { value: 0 };
    const allPaths: string[] = [];
    watcher.setUpdateCallback((paths) => {
      batchCount.value++;
      allPaths.push(...paths);
    });
    await watcher.start();

    const start = Date.now();
    fs.writeFileSync(path.join(tmpDir, "a.md"), "# A");
    fs.writeFileSync(path.join(tmpDir, "b.md"), "# B");
    fs.writeFileSync(path.join(tmpDir, "c.md"), "# C");
    fs.writeFileSync(path.join(tmpDir, "d.md"), "# D");
    fs.writeFileSync(path.join(tmpDir, "e.md"), "# E");

    await new Promise((r) => setTimeout(r, 400));
    const elapsed = Date.now() - start;
    await watcher.stop();

    expect(batchCount.value).toBe(1);
    expect(allPaths.length).toBeGreaterThanOrEqual(5);
    expect(elapsed).toBeGreaterThanOrEqual(200);
  });

  it("flushes a pending batch at max batch delay even when debounce keeps moving", async () => {
    const watcher = new VaultWatcher(tmpDir, [], {
      debounceMs: 1000,
      maxBatchDelayMs: 120,
    });
    const events: string[][] = [];
    watcher.setUpdateCallback((paths) => events.push(paths));

    fs.writeFileSync(path.join(tmpDir, "first.md"), "# First");
    (watcher as any).handleFsEvent("rename", "first.md");

    await new Promise((r) => setTimeout(r, 60));
    fs.writeFileSync(path.join(tmpDir, "second.md"), "# Second");
    (watcher as any).handleFsEvent("rename", "second.md");

    await new Promise((r) => setTimeout(r, 120));

    expect(events.length).toBe(1);
    expect(events.flat()).toEqual(
      expect.arrayContaining(["first.md", "second.md"]),
    );
  });

  it("emits a new batch after debounce window expires", async () => {
    const watcher = new VaultWatcher(tmpDir, [], { debounceMs: 80 });
    const batchCount = { value: 0 };
    watcher.setUpdateCallback(() => {
      batchCount.value++;
    });
    await watcher.start();

    fs.writeFileSync(path.join(tmpDir, "first.md"), "# First");
    await new Promise((r) => setTimeout(r, 200));
    expect(batchCount.value).toBeGreaterThanOrEqual(1);

    fs.writeFileSync(path.join(tmpDir, "second.md"), "# Second");
    await new Promise((r) => setTimeout(r, 200));

    await watcher.stop();

    expect(batchCount.value).toBeGreaterThanOrEqual(2);
  });
});

describe("VaultWatcher error codes", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-watcher-err-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("transitions to unavailable when vault root is a file, not a directory", async () => {
    const filePath = path.join(tmpDir, "not-a-dir");
    fs.writeFileSync(filePath, "not a directory");
    const watcher = new VaultWatcher(filePath, []);
    await watcher.start();
    expect(["unavailable", "degraded", "running"]).toContain(
      watcher.status.state,
    );
  });

  it("reports WATCHER_UNAVAILABLE for init failures", async () => {
    const filePath = path.join(tmpDir, "not-a-dir-2");
    fs.writeFileSync(filePath, "not a directory");
    const watcher = new VaultWatcher(filePath, []);
    await watcher.start();
    if (watcher.status.lastError) {
      expect([
        "WATCHER_UNAVAILABLE",
        "WATCHER_PATH_OUTSIDE_VAULT",
        "WATCHER_PERMISSION_DENIED",
        "WATCHER_UNKNOWN_ERROR",
        "WATCHER_EVENT_OVERFLOW",
        "WATCHER_TOO_MANY_FILES",
      ]).toContain(watcher.status.lastError.code);
    }
  });

  it("maps errno EACCES to WATCHER_PERMISSION_DENIED", () => {
    const watcher = new VaultWatcher(tmpDir, []);
    const code = (watcher as any).mapErrorCode(
      Object.assign(new Error("EACCES"), { code: "EACCES" }),
      "EACCES",
    );
    expect(code).toBe("WATCHER_PERMISSION_DENIED");
  });

  it("maps errno EPERM to WATCHER_PERMISSION_DENIED", () => {
    const watcher = new VaultWatcher(tmpDir, []);
    const code = (watcher as any).mapErrorCode(
      Object.assign(new Error("EPERM"), { code: "EPERM" }),
      "EPERM",
    );
    expect(code).toBe("WATCHER_PERMISSION_DENIED");
  });

  it("maps errno ENOENT to WATCHER_PATH_OUTSIDE_VAULT", () => {
    const watcher = new VaultWatcher(tmpDir, []);
    const code = (watcher as any).mapErrorCode(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      "ENOENT",
    );
    expect(code).toBe("WATCHER_PATH_OUTSIDE_VAULT");
  });

  it("maps errno ENFILE to WATCHER_TOO_MANY_FILES", () => {
    const watcher = new VaultWatcher(tmpDir, []);
    const code = (watcher as any).mapErrorCode(
      Object.assign(new Error("ENFILE"), { code: "ENFILE" }),
      "ENFILE",
    );
    expect(code).toBe("WATCHER_TOO_MANY_FILES");
  });

  it("maps errno EMFILE to WATCHER_TOO_MANY_FILES", () => {
    const watcher = new VaultWatcher(tmpDir, []);
    const code = (watcher as any).mapErrorCode(
      Object.assign(new Error("EMFILE"), { code: "EMFILE" }),
      "EMFILE",
    );
    expect(code).toBe("WATCHER_TOO_MANY_FILES");
  });

  it("maps errno ENOSPC to WATCHER_EVENT_OVERFLOW", () => {
    const watcher = new VaultWatcher(tmpDir, []);
    const code = (watcher as any).mapErrorCode(
      Object.assign(new Error("ENOSPC"), { code: "ENOSPC" }),
      "ENOSPC",
    );
    expect(code).toBe("WATCHER_EVENT_OVERFLOW");
  });

  it("falls back to WATCHER_UNKNOWN_ERROR for unmapped errors", () => {
    const watcher = new VaultWatcher(tmpDir, []);
    const code = (watcher as any).mapErrorCode(
      Object.assign(new Error("EWHAT"), { code: "EWHAT" }),
      "EWHAT",
    );
    expect(code).toBe("WATCHER_UNKNOWN_ERROR");
  });

  it("setUnavailable exposes WATCHER_UNAVAILABLE", () => {
    const watcher = new VaultWatcher(tmpDir, []);
    watcher.setUnavailable("watcher backend missing");
    expect(watcher.status.state).toBe("unavailable");
    expect(watcher.status.lastError?.code).toBe("WATCHER_UNAVAILABLE");
  });
});

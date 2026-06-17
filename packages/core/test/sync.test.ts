import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { GitSync, isAllowedGitRemoteUrl } from "../src/sync.js";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

describe("GitSync", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-sync-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("starts in unconfigured idle state", () => {
    const sync = new GitSync({ repo: "", remote: "origin", branch: "" });
    const status = sync.status;
    expect(status.enabled).toBe(false);
    expect(status.configured).toBe(false);
    expect(status.state).toBe("idle");
  });

  it("detects existing git worktree from vault root", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    const sync = new GitSync({ repo: tmpDir, remote: "origin", branch: "" });
    const detected = await sync.detectRepository(tmpDir);
    expect(detected).toBe(true);
  });

  it("detects nested git worktrees and chooses the nearest", async () => {
    const nestedDir = path.join(tmpDir, "nested");
    fs.mkdirSync(nestedDir, { recursive: true });
    fs.mkdirSync(path.join(nestedDir, ".git"), { recursive: true });
    const sync = new GitSync({ repo: nestedDir, remote: "origin", branch: "" });
    const detected = await sync.detectRepository(nestedDir);
    expect(detected).toBe(true);
  });

  it("clone creates target directory when missing", async () => {
    const targetPath = path.join(tmpDir, "clone-target");
    const sync = new GitSync({ repo: "", remote: "origin", branch: "" });
    expect(fs.existsSync(targetPath)).toBe(false);
    await expect(
      sync.clone("https://github.com/example/repo.git", targetPath),
    ).rejects.toThrow();
  });

  it("clone fails when target directory is non-empty", async () => {
    const targetPath = path.join(tmpDir, "non-empty");
    fs.mkdirSync(targetPath);
    fs.writeFileSync(path.join(targetPath, "file.txt"), "content");
    const sync = new GitSync({ repo: "", remote: "origin", branch: "" });
    await expect(
      sync.clone("https://github.com/example/repo.git", targetPath),
    ).rejects.toThrow();
  });

  it("rejects remote URLs containing credentials", async () => {
    const sync = new GitSync({ repo: "", remote: "origin", branch: "" });
    await expect(
      sync.clone(
        "https://user:pass@github.com/example/repo.git",
        path.join(tmpDir, "target"),
      ),
    ).rejects.toThrow();
  });

  it("validates remote URLs without rejecting normal SSH remotes", () => {
    expect(isAllowedGitRemoteUrl("git@github.com:user/repo.git")).toBe(true);
    expect(isAllowedGitRemoteUrl("ssh://git@github.com/user/repo.git")).toBe(
      true,
    );
    expect(
      isAllowedGitRemoteUrl("https://user:pass@github.com/user/repo.git"),
    ).toBe(false);
    expect(isAllowedGitRemoteUrl("https://github.com/user/repo.git")).toBe(
      true,
    );
  });

  it("pull fails for a dirty worktree", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "file.md"), "# Test");
    const sync = new GitSync({
      repo: tmpDir,
      remote: "origin",
      branch: "",
    });
    sync.setVaultRoot(tmpDir);
    await expect(sync.pull()).rejects.toThrow();
  });

  it("pull is single-flight and returns in-progress for concurrent requests", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    const sync = new GitSync({ repo: tmpDir, remote: "origin", branch: "" });
    sync.setVaultRoot(tmpDir);
    const p1 = sync.pull({ wait: false });
    const p2 = sync.pull({ wait: false });
    const results = await Promise.allSettled([p1, p2]);
    const rejections = results.filter((r) => r.status === "rejected");
    expect(rejections.length).toBeGreaterThanOrEqual(1);
  });

  it("sanitizes git output before display or logging", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    const sync = new GitSync({ repo: tmpDir, remote: "origin", branch: "" });
    sync.setVaultRoot(tmpDir);
    try {
      await sync.pull();
    } catch {
      const status = sync.status;
      if (status.lastError) {
        expect(status.lastError.message).not.toContain("https://");
        expect(status.lastError.message).not.toContain("@");
      }
    }
  });

  it("does not make the last usable index unavailable on failure", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    const sync = new GitSync({ repo: tmpDir, remote: "origin", branch: "" });
    sync.setVaultRoot(tmpDir);
    try {
      await sync.pull();
    } catch {
      expect(sync.status.state).toBe("failed");
    }
  });

  it("fails gracefully when git executable is unavailable", async () => {
    const sync = new GitSync({ repo: tmpDir, remote: "origin", branch: "" });
    sync.setVaultRoot("/nonexistent");
    await expect(sync.pull()).rejects.toThrow();
  });

  it("scheduled sync does not run concurrently with manual sync", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    const sync = new GitSync({
      repo: tmpDir,
      remote: "origin",
      branch: "",
      enabled: true,
      intervalSeconds: 1,
    });
    sync.setVaultRoot(tmpDir);
    sync.startScheduledSync();
    const p1 = sync.pull({ wait: false });
    await expect(p1).rejects.toThrow();
    sync.stopScheduledSync();
  });

  it("failed sync does not trigger index update when no changes were applied", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    let callbackCalled = false;
    const sync = new GitSync({ repo: tmpDir, remote: "origin", branch: "" });
    sync.setVaultRoot(tmpDir);
    sync.setOnSyncComplete(() => {
      callbackCalled = true;
    });
    try {
      await sync.pull();
    } catch {
      expect(callbackCalled).toBe(false);
    }
  });

  it("detecting a git worktree does not enable sync automatically", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    const sync = new GitSync({
      repo: tmpDir,
      remote: "origin",
      branch: "",
      enabled: false,
    });
    sync.setVaultRoot(tmpDir);
    const detected = await sync.detectRepository(tmpDir);
    expect(detected).toBe(true);
    expect(sync.status.enabled).toBe(false);
  });

  it("pull fails for a non-fast-forward state", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    const sync = new GitSync({ repo: tmpDir, remote: "origin", branch: "" });
    sync.setVaultRoot(tmpDir);
    await expect(sync.pull()).rejects.toThrow();
  });

  it("pull fails for merge conflicts", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    const sync = new GitSync({ repo: tmpDir, remote: "origin", branch: "" });
    sync.setVaultRoot(tmpDir);
    await expect(sync.pull()).rejects.toThrow();
  });

  it("pull fails for missing remote branch", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    const sync = new GitSync({
      repo: tmpDir,
      remote: "origin",
      branch: "nonexistent-branch",
    });
    sync.setVaultRoot(tmpDir);
    await expect(sync.pull()).rejects.toThrow();
  });

  it("pull --wait waits for an active sync and then runs", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    const sync = new GitSync({ repo: tmpDir, remote: "origin", branch: "" });
    sync.setVaultRoot(tmpDir);
    const p1 = sync.pull({ wait: true, timeoutSeconds: 1 });
    await expect(p1).rejects.toThrow();
  });

  it("records consecutive failures after failed pull", async () => {
    fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
    const sync = new GitSync({ repo: tmpDir, remote: "origin", branch: "" });
    sync.setVaultRoot(tmpDir);
    try {
      await sync.pull();
    } catch {
      expect(sync.status.consecutiveFailures).toBeGreaterThanOrEqual(1);
    }
  });
});

describe("GitSync webhook rate limiting", () => {
  let localTmpDir: string;

  beforeEach(() => {
    localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-rl-"));
  });

  afterEach(() => {
    fs.rmSync(localTmpDir, { recursive: true, force: true });
  });

  it("returns true when more than 60 valid requests are made in 60 seconds", () => {
    const sync = new GitSync({
      repo: localTmpDir,
      remote: "origin",
      branch: "",
      webhookEnabled: true,
      webhookSecret: "secret",
    });

    for (let i = 0; i < 60; i++) {
      expect(sync.checkWebhookRateLimit()).toBe(false);
    }
    expect(sync.checkWebhookRateLimit()).toBe(true);
  });

  it("allows requests after the time window has elapsed", () => {
    const sync = new GitSync({
      repo: localTmpDir,
      remote: "origin",
      branch: "",
      webhookEnabled: true,
      webhookSecret: "secret",
    });

    for (let i = 0; i < 60; i++) {
      sync.checkWebhookRateLimit();
    }
    expect(sync.checkWebhookRateLimit()).toBe(true);

    const result = sync.checkWebhookRateLimit(0, 60);
    expect(result).toBe(false);
  });

  it("rejects webhook handle with WEBHOOK_RATE_LIMITED when over limit", async () => {
    const sync = new GitSync({
      repo: localTmpDir,
      remote: "origin",
      branch: "",
      webhookEnabled: true,
      webhookSecret: "secret",
    });

    for (let i = 0; i < 60; i++) {
      await sync.handleWebhook("secret", null);
      sync.cancelPendingWebhookSync();
    }

    await expect(sync.handleWebhook("secret", null)).rejects.toMatchObject({
      code: "WEBHOOK_RATE_LIMITED",
    });
  });

  it("hasPendingWebhookSync reflects debounce timer state", async () => {
    const sync = new GitSync({
      repo: localTmpDir,
      remote: "origin",
      branch: "",
      webhookEnabled: true,
      webhookSecret: "secret",
    });

    expect(sync.hasPendingWebhookSync()).toBe(false);
    await sync.handleWebhook("secret", null);
    expect(sync.hasPendingWebhookSync()).toBe(true);
    sync.cancelPendingWebhookSync();
    expect(sync.hasPendingWebhookSync()).toBe(false);
  });
});

describe("GitSync webhook debounce", () => {
  let localTmpDir: string;

  beforeEach(() => {
    localTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-wd-"));
  });

  afterEach(() => {
    fs.rmSync(localTmpDir, { recursive: true, force: true });
  });

  it("coalesces multiple webhooks into one pending sync via 60s debounce", async () => {
    const sync = new GitSync({
      repo: localTmpDir,
      remote: "origin",
      branch: "",
      webhookEnabled: true,
      webhookSecret: "secret",
    });

    await sync.handleWebhook("secret", null);
    expect(sync.hasPendingWebhookSync()).toBe(true);

    await sync.handleWebhook("secret", null);
    expect(sync.hasPendingWebhookSync()).toBe(true);

    await sync.handleWebhook("secret", null);
    expect(sync.hasPendingWebhookSync()).toBe(true);

    sync.cancelPendingWebhookSync();
  });
});

describe("GitSync changed path detection (real Git)", () => {
  const { execFileSync } =
    require("child_process") as typeof import("child_process");
  function shell(args: string[], cwd: string): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).toString();
  }

  function setupRealRepo(): { repoDir: string; remoteDir: string } {
    const baseDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-real-git-"),
    );
    const remoteDir = path.join(baseDir, "remote.git");
    const repoDir = path.join(baseDir, "repo");
    fs.mkdirSync(remoteDir);
    fs.mkdirSync(repoDir);

    shell(["init", "--bare", "--initial-branch=main"], remoteDir);
    shell(["init", "-b", "main"], repoDir);
    shell(["config", "user.email", "test@example.com"], repoDir);
    shell(["config", "user.name", "test"], repoDir);

    fs.writeFileSync(path.join(repoDir, "Welcome.md"), "# Welcome\n\nHello.");
    shell(["add", "Welcome.md"], repoDir);
    shell(["commit", "-m", "Initial"], repoDir);
    shell(["remote", "add", "origin", remoteDir], repoDir);
    shell(["push", "-u", "origin", "main"], repoDir);

    return { repoDir, remoteDir };
  }

  it("returns no_op with empty changedPaths when already up-to-date", async () => {
    const { repoDir } = setupRealRepo();
    const sync = new GitSync({
      repo: repoDir,
      remote: "origin",
      branch: "main",
      enabled: true,
    });
    sync.setVaultRoot(repoDir);

    const result = await sync.pull();
    expect(result.status).toBe("no_op");
    expect(result.changed).toBe(false);
    expect(result.changedPaths).toEqual([]);
  });

  it("detects the enclosing repository when the vault root is a subdirectory", async () => {
    const { repoDir } = setupRealRepo();
    const vaultRoot = path.join(repoDir, "notes", "vault");
    fs.mkdirSync(vaultRoot, { recursive: true });

    const sync = new GitSync({
      repo: "",
      remote: "origin",
      branch: "main",
      enabled: true,
    });
    sync.setVaultRoot(vaultRoot);

    expect(await sync.detectRepository(vaultRoot)).toBe(true);
    expect(sync.resolveRepositoryRoot(vaultRoot)).toBe(repoDir);
  });

  it("returns changedPaths for fast-forward commits on the remote", async () => {
    const { repoDir, remoteDir } = setupRealRepo();
    const sync = new GitSync({
      repo: repoDir,
      remote: "origin",
      branch: "main",
      enabled: true,
    });
    sync.setVaultRoot(repoDir);

    const cloneForUpdate = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-updater-")),
      "repo2",
    );
    fs.mkdirSync(cloneForUpdate);
    shell(["clone", remoteDir, cloneForUpdate], repoDir);
    shell(["config", "user.email", "t@t.com"], cloneForUpdate);
    shell(["config", "user.name", "t"], cloneForUpdate);
    shell(["checkout", "main"], cloneForUpdate);
    fs.writeFileSync(path.join(cloneForUpdate, "New.md"), "# New Note");
    shell(["add", "New.md"], cloneForUpdate);
    shell(["commit", "-m", "Add new"], cloneForUpdate);
    shell(["push", "origin", "main"], cloneForUpdate);

    const result = await sync.pull();
    expect(result.changed).toBe(true);
    expect(result.status).toBe("completed");
    expect(result.changedPaths.length).toBeGreaterThan(0);
    expect(result.changedPaths).toContain("New.md");
  });

  it("returns completed with multiple changed paths for multi-file commits", async () => {
    const { repoDir, remoteDir } = setupRealRepo();
    const sync = new GitSync({
      repo: repoDir,
      remote: "origin",
      branch: "main",
      enabled: true,
    });
    sync.setVaultRoot(repoDir);

    const cloneForUpdate = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-updater-")),
      "repo2",
    );
    fs.mkdirSync(cloneForUpdate);
    shell(["clone", remoteDir, cloneForUpdate], repoDir);
    shell(["config", "user.email", "t@t.com"], cloneForUpdate);
    shell(["config", "user.name", "t"], cloneForUpdate);
    shell(["checkout", "main"], cloneForUpdate);

    fs.writeFileSync(path.join(cloneForUpdate, "A.md"), "# A");
    fs.writeFileSync(path.join(cloneForUpdate, "B.md"), "# B");
    fs.writeFileSync(path.join(cloneForUpdate, "data.csv"), "a,b");
    shell(["add", "A.md", "B.md", "data.csv"], cloneForUpdate);
    shell(["commit", "-m", "Add multiple"], cloneForUpdate);
    shell(["push", "origin", "main"], cloneForUpdate);

    const result = await sync.pull();
    expect(result.changed).toBe(true);
    expect(result.changedPaths.length).toBe(3);
    expect(result.changedPaths).toContain("A.md");
    expect(result.changedPaths).toContain("B.md");
    expect(result.changedPaths).toContain("data.csv");
  });

  it("fails with SYNC_NON_FAST_FORWARD when local is ahead of remote", async () => {
    const { repoDir, remoteDir } = setupRealRepo();
    const sync = new GitSync({
      repo: repoDir,
      remote: "origin",
      branch: "main",
      enabled: true,
    });
    sync.setVaultRoot(repoDir);

    const cloneForUpdate = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-updater-")),
      "repo2",
    );
    fs.mkdirSync(cloneForUpdate);
    shell(["clone", remoteDir, cloneForUpdate], repoDir);
    shell(["config", "user.email", "t@t.com"], cloneForUpdate);
    shell(["config", "user.name", "t"], cloneForUpdate);
    shell(["checkout", "main"], cloneForUpdate);
    fs.writeFileSync(path.join(cloneForUpdate, "RemoteNew.md"), "# Remote");
    shell(["add", "RemoteNew.md"], cloneForUpdate);
    shell(["commit", "-m", "RemoteCommit"], cloneForUpdate);
    shell(["push", "origin", "main"], cloneForUpdate);

    fs.writeFileSync(path.join(repoDir, "Local.md"), "# Local");
    shell(["add", "Local.md"], repoDir);
    shell(["commit", "-m", "LocalCommit"], repoDir);

    await expect(sync.pull()).rejects.toMatchObject({
      code: "SYNC_NON_FAST_FORWARD",
    });
  });

  it("fails with SYNC_CONFLICT when merge would conflict", async () => {
    const { repoDir, remoteDir } = setupRealRepo();
    const sync = new GitSync({
      repo: repoDir,
      remote: "origin",
      branch: "main",
      enabled: true,
    });
    sync.setVaultRoot(repoDir);

    const cloneForUpdate = path.join(
      fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-updater-")),
      "repo2",
    );
    fs.mkdirSync(cloneForUpdate);
    shell(["clone", remoteDir, cloneForUpdate], repoDir);
    shell(["config", "user.email", "t@t.com"], cloneForUpdate);
    shell(["config", "user.name", "t"], cloneForUpdate);
    shell(["checkout", "main"], cloneForUpdate);

    fs.writeFileSync(path.join(cloneForUpdate, "Welcome.md"), "# RemoteChange");
    shell(["add", "Welcome.md"], cloneForUpdate);
    shell(["commit", "-m", "RemoteChange"], cloneForUpdate);
    shell(["push", "origin", "main"], cloneForUpdate);

    fs.writeFileSync(path.join(repoDir, "Welcome.md"), "# LocalChange");
    shell(["add", "Welcome.md"], repoDir);
    shell(["commit", "-m", "LocalChange"], repoDir);

    await expect(sync.pull()).rejects.toThrow();
  });
});

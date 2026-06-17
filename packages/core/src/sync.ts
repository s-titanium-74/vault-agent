import { Config } from "./config.js";
import { execFileSync } from "child_process";
import fs from "node:fs";
import path from "node:path";
import { constantTimeEqual } from "./constant-time.js";

export type SyncRunState = "idle" | "running" | "pending" | "failed";

export interface SyncStatus {
  enabled: boolean;
  configured: boolean;
  state: SyncRunState;
  pending: boolean;
  lastSuccessfulSyncAt: number | null;
  consecutiveFailures: number;
  lastError: { code: string; message: string } | null;
}

export interface SyncPullResult {
  status: "completed" | "no_op";
  changed: boolean;
  changedPaths: string[];
  startedAt: number;
  finishedAt: number;
}

export interface SyncCloneOptions {
  branch?: string;
  enableSync?: boolean;
  indexAfterClone?: boolean;
}

export interface GitSyncConfig {
  repo: string;
  remote: string;
  branch: string;
  enabled?: boolean;
  intervalSeconds?: number;
  webhookEnabled?: boolean;
  webhookSecret?: string;
  pullTimeoutSeconds?: number;
  failureBackoffSeconds?: number;
}

export class GitSync {
  private config: {
    repo: string;
    remote: string;
    branch: string;
    enabled: boolean;
    intervalSeconds: number;
    webhookEnabled: boolean;
    webhookSecret: string;
    pullTimeoutSeconds: number;
    failureBackoffSeconds: number;
  };
  private _status: SyncStatus;
  private _vaultRoot: string = "";
  private syncLock: boolean = false;
  private scheduledTimer: ReturnType<typeof setTimeout> | null = null;
  private webhookDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private webhookRequestTimestamps: number[] = [];
  private onSyncComplete: ((changed: boolean) => void) | null = null;
  private _webhookSecret: string = "";

  constructor(config: Config | GitSyncConfig) {
    let syncConfig: GitSyncConfig;
    if ("sync" in config) {
      syncConfig = {
        repo: config.sync.repo,
        remote: config.sync.remote,
        branch: config.sync.branch,
        enabled: config.sync.enabled,
        intervalSeconds: config.sync.interval_seconds,
        webhookEnabled: config.sync.webhook_enabled,
        webhookSecret: config.sync.webhook_secret,
        pullTimeoutSeconds: config.sync.pull_timeout_seconds,
        failureBackoffSeconds: config.sync.failure_backoff_seconds,
      };
    } else {
      syncConfig = config;
    }

    this.config = {
      repo: syncConfig.repo,
      remote: syncConfig.remote,
      branch: syncConfig.branch,
      enabled: syncConfig.enabled ?? false,
      intervalSeconds: syncConfig.intervalSeconds ?? 900,
      webhookEnabled: syncConfig.webhookEnabled ?? false,
      webhookSecret: syncConfig.webhookSecret ?? "",
      pullTimeoutSeconds: syncConfig.pullTimeoutSeconds ?? 120,
      failureBackoffSeconds: syncConfig.failureBackoffSeconds ?? 3600,
    };
    this._status = {
      enabled: this.config.enabled,
      configured: Boolean(this.config.repo),
      state: "idle",
      pending: false,
      lastSuccessfulSyncAt: null,
      consecutiveFailures: 0,
      lastError: null,
    };
    this._webhookSecret = this.config.webhookSecret;
  }

  get status(): SyncStatus {
    return { ...this._status };
  }

  setVaultRoot(vaultRoot: string): void {
    this._vaultRoot = vaultRoot;
  }

  setOnSyncComplete(callback: (changed: boolean) => void): void {
    this.onSyncComplete = callback;
  }

  async detectRepository(vaultRoot: string): Promise<boolean> {
    return this.resolveRepositoryRoot(vaultRoot) !== null;
  }

  resolveRepositoryRoot(startPath?: string): string | null {
    const cwd = path.resolve(startPath || this.config.repo || this._vaultRoot);
    if (!cwd) return null;

    try {
      const stdout = execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      const repoRoot = stdout.trim();
      return repoRoot.length > 0 ? repoRoot : null;
    } catch {
      try {
        const gitDir = path.join(cwd, ".git");
        const worktreeDir = path.join(cwd, ".git", "worktrees");

        if (fs.existsSync(gitDir)) {
          const stat = fs.statSync(gitDir);
          if (stat.isFile()) {
            const content = fs.readFileSync(gitDir, "utf-8");
            if (content.startsWith("gitdir:")) {
              const worktreePath = content.slice(7).trim();
              return fs.existsSync(worktreePath) ? cwd : null;
            }
          }
          return fs.existsSync(gitDir) ? cwd : null;
        }

        if (fs.existsSync(worktreeDir)) {
          return cwd;
        }
      } catch {
        return null;
      }
      return null;
    }
  }

  async pull(
    options: {
      wait?: boolean;
      timeoutSeconds?: number;
    } = {},
  ): Promise<SyncPullResult> {
    const startedAt = Date.now();
    const timeoutSeconds =
      options.timeoutSeconds ?? this.config.pullTimeoutSeconds;

    if (this.syncLock) {
      if (options.wait) {
        const maxWait = timeoutSeconds * 1000;
        const waitStart = Date.now();
        while (this.syncLock && Date.now() - waitStart < maxWait) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        if (this.syncLock) {
          throw new SyncError(
            "SYNC_IN_PROGRESS",
            "Another sync operation is already in progress",
          );
        }
      } else {
        throw new SyncError(
          "SYNC_IN_PROGRESS",
          "Another sync operation is already in progress",
        );
      }
    }

    this.syncLock = true;
    this._status.state = "running";

    try {
      const repoRoot = this.resolveRepositoryRoot(
        this.config.repo || this._vaultRoot,
      );
      if (!repoRoot) {
        throw new SyncError(
          "SYNC_WORKTREE_DIRTY",
          "Vault root is not a Git worktree",
        );
      }
      this.config.repo = repoRoot;

      const isDirty = await this.isWorktreeDirty();
      if (isDirty) {
        throw new SyncError(
          "SYNC_WORKTREE_DIRTY",
          "Cannot pull: working tree has uncommitted changes",
        );
      }

      const result = await this.performPull(timeoutSeconds * 1000);
      const finishedAt = Date.now();

      if (result.changed) {
        this._status.consecutiveFailures = 0;
        this._status.lastSuccessfulSyncAt = Date.now();
      }

      return {
        status: result.changed ? "completed" : "no_op",
        changed: result.changed,
        changedPaths: result.changedPaths,
        startedAt,
        finishedAt,
      };
    } catch (err) {
      if (err instanceof SyncError) {
        this._status.lastError = {
          code: err.code,
          message: err.message,
        };
      } else {
        this._status.lastError = {
          code: "SYNC_GIT_FAILED",
          message: (err as Error).message,
        };
      }
      this._status.consecutiveFailures++;

      this._status.state = "failed";
      throw err;
    } finally {
      this.syncLock = false;
      if (this._status.state !== "failed") {
        this._status.state = "idle";
      }
    }
  }

  private async performPull(
    timeoutMs: number,
  ): Promise<{ changed: boolean; changedPaths: string[] }> {
    try {
      const remote = this.config.remote || "origin";
      const branch = this.config.branch || this.getCurrentBranch();

      if (!branch) {
        throw new SyncError(
          "SYNC_DETACHED_HEAD",
          "Cannot pull in detached HEAD state",
        );
      }

      const fetchResult = this.gitCommand(["fetch", remote, branch], timeoutMs);
      if (fetchResult.exitCode !== 0) {
        throw new SyncError(
          "SYNC_NETWORK_FAILED",
          `Git fetch failed: ${this.sanitizeOutput(fetchResult.stderr)}`,
        );
      }

      const localCommit = this.gitCommand(
        ["rev-parse", branch],
        timeoutMs,
      ).stdout.trim();
      const remoteCommit = this.gitCommand(
        ["rev-parse", `${remote}/${branch}`],
        timeoutMs,
      ).stdout.trim();

      if (localCommit === remoteCommit) {
        return { changed: false, changedPaths: [] };
      }

      const mergeBase = this.gitCommand(
        ["merge-base", branch, `${remote}/${branch}`],
        timeoutMs,
      ).stdout.trim();
      const diffResult = this.gitCommand(
        ["diff", "--name-only", mergeBase, `${remote}/${branch}`],
        timeoutMs,
      );
      const changedPaths = diffResult.stdout
        .split("\n")
        .map((p) => p.trim())
        .filter((p) => p.length > 0);

      const mergeResult = this.gitCommand(
        ["merge", "--ff-only", `${remote}/${branch}`],
        timeoutMs,
      );

      if (mergeResult.exitCode !== 0) {
        const mergeMsg = this.sanitizeOutput(mergeResult.stderr);
        if (
          mergeResult.stderr.includes("CONFLICT") ||
          mergeResult.stderr.includes("merge conflict")
        ) {
          throw new SyncError("SYNC_CONFLICT", `Merge conflict: ${mergeMsg}`);
        }
        if (
          mergeResult.stderr.includes("non-fast-forward") ||
          mergeResult.stderr.includes("Not possible to fast-forward") ||
          mergeResult.stderr.includes("Diverging") ||
          mergeResult.stderr.includes("diverged")
        ) {
          throw new SyncError(
            "SYNC_NON_FAST_FORWARD",
            `Non-fast-forward update rejected: ${mergeMsg}`,
          );
        }
        throw new SyncError("SYNC_GIT_FAILED", `Merge failed: ${mergeMsg}`);
      }

      if (this.onSyncComplete) {
        this.onSyncComplete(true);
      }

      return { changed: true, changedPaths };
    } catch (err) {
      if (err instanceof SyncError) throw err;
      throw new SyncError(
        "SYNC_GIT_FAILED",
        `Git operation failed: ${(err as Error).message}`,
      );
    }
  }

  private async isWorktreeDirty(): Promise<boolean> {
    try {
      const result = this.gitCommand(["status", "--porcelain"], 10000);
      return result.stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private getCurrentBranch(): string | null {
    try {
      const result = this.gitCommand(["branch", "--show-current"], 5000);
      return result.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private gitCommand(
    args: string[],
    timeoutMs: number,
  ): { exitCode: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync("git", args, {
        cwd: this.config.repo || this._vaultRoot,
        timeout: timeoutMs,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (err: unknown) {
      if (err instanceof Error) {
        const nodeErr = err as Error & {
          status?: number;
          stdout?: Buffer | string;
          stderr?: Buffer | string;
        };
        const stderr = nodeErr.stderr
          ? Buffer.isBuffer(nodeErr.stderr)
            ? nodeErr.stderr.toString("utf-8")
            : String(nodeErr.stderr)
          : nodeErr.message;
        return {
          exitCode: nodeErr.status ?? 1,
          stdout: "",
          stderr,
        };
      }
      throw err;
    }
  }

  private sanitizeOutput(output: string): string {
    return output
      .replace(/https?:\/\/[^\s]+/g, "<redacted-url>")
      .replace(
        /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
        "<redacted-email>",
      )
      .split("\n")
      .slice(0, 5)
      .join("\n");
  }

  async clone(remoteUrl: string, targetPath: string): Promise<void> {
    const resolvedTarget = path.resolve(targetPath);
    if (!isAllowedGitRemoteUrl(remoteUrl)) {
      throw new SyncError(
        "SYNC_REMOTE_URL_CONTAINS_CREDENTIALS",
        "Remote URL is invalid or contains credentials",
      );
    }

    if (fs.existsSync(targetPath)) {
      const entries = fs.readdirSync(targetPath);
      if (entries.length > 0) {
        throw new SyncError(
          "SYNC_INVALID_REMOTE_URL",
          `Target directory is not empty: ${targetPath}`,
        );
      }
    } else {
      fs.mkdirSync(targetPath, { recursive: true });
    }

    try {
      const args = ["clone"];
      if (this.config.branch) {
        args.push("--branch", this.config.branch);
      }
      args.push(remoteUrl, resolvedTarget);

      const result = this.gitCommandInCwd(
        args,
        path.dirname(resolvedTarget),
        300000,
      );
      if (result.exitCode !== 0) {
        throw new SyncError(
          "SYNC_GIT_FAILED",
          `Clone failed: ${this.sanitizeOutput(result.stderr) || "unknown error"}`,
        );
      }
    } catch (err) {
      if (err instanceof SyncError) throw err;
      throw new SyncError(
        "SYNC_GIT_FAILED",
        `Clone failed: ${(err as Error).message}`,
      );
    }
  }

  private gitCommandInCwd(
    args: string[],
    cwd: string,
    timeoutMs: number,
  ): { exitCode: number; stdout: string; stderr: string } {
    try {
      const stdout = execFileSync("git", args, {
        cwd,
        timeout: timeoutMs,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { exitCode: 0, stdout, stderr: "" };
    } catch (err: unknown) {
      if (err instanceof Error) {
        const nodeErr = err as Error & {
          status?: number;
          stdout?: Buffer | string;
          stderr?: Buffer | string;
        };
        const stderr = nodeErr.stderr
          ? Buffer.isBuffer(nodeErr.stderr)
            ? nodeErr.stderr.toString("utf-8")
            : String(nodeErr.stderr)
          : nodeErr.message;
        return {
          exitCode: nodeErr.status ?? 1,
          stdout: "",
          stderr,
        };
      }
      throw err;
    }
  }

  startScheduledSync(): void {
    if (!this.config.enabled || !this.config.repo) return;
    if (this.scheduledTimer) return;

    const scheduleNext = () => {
      const intervalMs = this.config.intervalSeconds * 1000;
      this.scheduledTimer = setTimeout(async () => {
        if (this.syncLock) return;
        try {
          await this.pull();
        } catch {
          // Error already recorded in status
        }
        scheduleNext();
      }, intervalMs);
    };

    scheduleNext();
  }

  stopScheduledSync(): void {
    if (this.scheduledTimer) {
      clearTimeout(this.scheduledTimer);
      this.scheduledTimer = null;
    }
  }

  async handleWebhook(
    secret: string,
    _body: unknown,
    options: { debounceMs?: number } = {},
  ): Promise<void> {
    if (!this.config.webhookEnabled) {
      throw new SyncError("WEBHOOK_DISABLED", "Webhook is not enabled");
    }

    if (!this._webhookSecret) {
      throw new SyncError(
        "WEBHOOK_SECRET_NOT_CONFIGURED",
        "Webhook secret is not configured",
      );
    }

    if (!constantTimeEqual(secret, this._webhookSecret)) {
      throw new SyncError(
        "WEBHOOK_SECRET_INVALID",
        "Webhook secret is invalid",
      );
    }

    if (this.checkWebhookRateLimit()) {
      throw new SyncError(
        "WEBHOOK_RATE_LIMITED",
        "Webhook rate limit exceeded",
      );
    }

    if (this.webhookDebounceTimer) {
      clearTimeout(this.webhookDebounceTimer);
    }

    const debounceMs = options.debounceMs ?? 60000;
    this.webhookDebounceTimer = setTimeout(async () => {
      this.webhookDebounceTimer = null;
      try {
        await this.pull();
      } catch {
        // Error already recorded in status
      }
    }, debounceMs);
  }

  checkWebhookRateLimit(windowMs: number = 60000, max: number = 60): boolean {
    const now = Date.now();
    this.webhookRequestTimestamps = this.webhookRequestTimestamps.filter(
      (t) => now - t < windowMs,
    );
    if (this.webhookRequestTimestamps.length >= max) {
      return true;
    }
    this.webhookRequestTimestamps.push(now);
    return false;
  }

  hasPendingWebhookSync(): boolean {
    return this.webhookDebounceTimer !== null;
  }

  cancelPendingWebhookSync(): void {
    if (this.webhookDebounceTimer) {
      clearTimeout(this.webhookDebounceTimer);
      this.webhookDebounceTimer = null;
    }
  }

  validateWebhookSecret(secret: string): boolean {
    if (!this._webhookSecret) return false;
    return constantTimeEqual(secret, this._webhookSecret);
  }

  updateConfig(config: Config): void {
    this.config = {
      repo: config.sync.repo,
      remote: config.sync.remote,
      branch: config.sync.branch,
      enabled: config.sync.enabled,
      intervalSeconds: config.sync.interval_seconds,
      webhookEnabled: config.sync.webhook_enabled,
      webhookSecret: config.sync.webhook_secret,
      pullTimeoutSeconds: config.sync.pull_timeout_seconds,
      failureBackoffSeconds: config.sync.failure_backoff_seconds,
    };
    this._status.enabled = this.config.enabled;
    this._status.configured = Boolean(this.config.repo);
    this._webhookSecret = this.config.webhookSecret;
  }
}

export function isAllowedGitRemoteUrl(remoteUrl: string): boolean {
  if (!remoteUrl) return false;

  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:.+$/.test(remoteUrl)) {
    return true;
  }

  if (!remoteUrl.includes("://")) {
    return false;
  }

  let parsed: URL;
  try {
    parsed = new URL(remoteUrl);
  } catch {
    return false;
  }

  if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) {
    return false;
  }

  if (parsed.protocol === "http:" || parsed.protocol === "https:") {
    return parsed.username === "" && parsed.password === "";
  }

  return parsed.password === "";
}

export class SyncError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "SyncError";
  }
}

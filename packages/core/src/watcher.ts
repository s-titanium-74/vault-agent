import { DEFAULT_EXCLUDE_PATTERNS, INDEXED_EXTENSIONS } from "./schemas.js";
import { toVaultRelative } from "./pathsafety.js";
import path from "node:path";
import fs from "node:fs";
import ignore from "ignore";

export type WatcherState =
  | "disabled"
  | "starting"
  | "running"
  | "degraded"
  | "stopped"
  | "unavailable";

export interface WatcherStatus {
  enabled: boolean;
  state: WatcherState;
  lastEventAt: number | null;
  pending: boolean;
  lastError: { code: string; message: string } | null;
}

export type WatchEventType = "create" | "modify" | "delete" | "rename";

export interface WatcherEvent {
  type: WatchEventType;
  vaultRelativePath: string;
  isAttachment: boolean;
  isExcluded: boolean;
}

export class VaultWatcher {
  private vaultRoot: string;
  private excludePatterns: string[];
  private ig: ReturnType<typeof ignore>;
  private _status: WatcherStatus;
  private watcher: fs.FSWatcher | null = null;
  private watchedDirs: Set<string> = new Set();
  private pendingEvents: Map<string, WatcherEvent> = new Map();
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxBatchTimer: ReturnType<typeof setTimeout> | null = null;
  private onUpdate: ((paths: string[]) => void) | null = null;
  private debounceMs: number;
  private maxBatchDelayMs: number;
  private ignoreInitial: boolean;
  private initialScanDone: boolean = false;
  private destroyed: boolean = false;

  constructor(
    vaultRoot: string,
    excludePatterns: string[] = [],
    options?: {
      debounceMs?: number;
      maxBatchDelayMs?: number;
      ignoreInitial?: boolean;
    },
  ) {
    this.vaultRoot = path.resolve(vaultRoot);
    this.excludePatterns = [...DEFAULT_EXCLUDE_PATTERNS, ...excludePatterns];
    this.ig = ignore().add(this.excludePatterns);
    this.debounceMs = options?.debounceMs ?? 10000;
    this.maxBatchDelayMs = options?.maxBatchDelayMs ?? 60000;
    this.ignoreInitial = options?.ignoreInitial ?? true;
    this._status = {
      enabled: true,
      state: "starting",
      lastEventAt: null,
      pending: false,
      lastError: null,
    };
  }

  get status(): WatcherStatus {
    return { ...this._status };
  }

  setUpdateCallback(callback: (paths: string[]) => void): void {
    this.onUpdate = callback;
  }

  async start(): Promise<void> {
    if (this.destroyed) {
      throw new Error("Watcher has been destroyed");
    }
    try {
      this._status.state = "starting";
      await this.initWatcher();
      this._status.state = "running";
      this.initialScanDone = true;
    } catch (err) {
      this._status.state = "unavailable";
      const errMessage = (err as Error).message;
      const errCode = (err as NodeJS.ErrnoException).code;
      const isErrno = errCode !== undefined;
      this._status.lastError = {
        code: isErrno
          ? this.mapErrorCode(err as NodeJS.ErrnoException, errCode)
          : "WATCHER_UNAVAILABLE",
        message: errMessage,
      };
    }
  }

  private async initWatcher(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.watcher = fs.watch(
          this.vaultRoot,
          { recursive: true },
          (eventType, filename) => {
            if (!filename) return;
            this.handleFsEvent(eventType, filename);
          },
        );

        this.watcher.on("error", (err) => {
          this.handleWatcherError(err as NodeJS.ErrnoException);
        });

        this.watcher.on("close", () => {
          if (!this.destroyed) {
            this._status.state = "unavailable";
            this._status.lastError = {
              code: "WATCHER_UNKNOWN_ERROR",
              message: "Watcher closed unexpectedly",
            };
          }
        });

        this.scheduleDirScan();
        resolve();
      } catch (err) {
        reject(err);
      }
    });
  }

  private scheduleDirScan(): void {
    const scanDirs = (dir: string) => {
      if (this.watchedDirs.has(dir)) return;
      this.watchedDirs.add(dir);

      try {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            scanDirs(fullPath);
          }
        }
      } catch {
        // Directory may not be accessible
      }
    };

    scanDirs(this.vaultRoot);
  }

  private handleFsEvent(
    eventType: fs.WatchEventType,
    rawFilename: string,
  ): void {
    if (this._status.state === "disabled") return;

    const vaultRelativePath = toVaultRelative(
      path.join(this.vaultRoot, rawFilename),
      this.vaultRoot,
    );

    if (!vaultRelativePath || vaultRelativePath === ".") return;

    const event = this.classifyEvent(eventType, vaultRelativePath, rawFilename);
    if (!event) return;

    this.pendingEvents.set(vaultRelativePath, event);
    this.scheduleFlush();
  }

  private classifyEvent(
    eventType: fs.WatchEventType,
    vaultRelativePath: string,
    _rawFilename: string,
  ): WatcherEvent | null {
    let type: WatchEventType;

    if (eventType === "rename") {
      const absolutePath = path.join(this.vaultRoot, vaultRelativePath);
      type = fs.existsSync(absolutePath) ? "create" : "delete";
    } else {
      type = "modify";
    }

    const ext = path.extname(vaultRelativePath).toLowerCase();
    const isAttachment = !INDEXED_EXTENSIONS.includes(ext);

    const basename = path.basename(vaultRelativePath);
    if (basename.startsWith(".")) {
      return null;
    }

    const pathSegments = vaultRelativePath.split("/");
    if (pathSegments.some((seg) => seg.startsWith("."))) {
      return null;
    }

    if (this.ig.ignores(vaultRelativePath)) {
      return null;
    }

    const isExcluded =
      DEFAULT_EXCLUDE_PATTERNS.some((p) => {
        if (p.endsWith("/")) {
          return (
            vaultRelativePath.startsWith(p) ||
            vaultRelativePath.includes("/" + p)
          );
        }
        return vaultRelativePath === p || vaultRelativePath.endsWith("/" + p);
      }) ||
      this.excludePatterns.some((p) => {
        if (p.endsWith("/")) {
          return (
            vaultRelativePath.startsWith(p) ||
            vaultRelativePath.includes("/" + p)
          );
        }
        return vaultRelativePath === p || vaultRelativePath.endsWith("/" + p);
      });

    return {
      type,
      vaultRelativePath,
      isAttachment,
      isExcluded,
    };
  }

  private scheduleFlush(): void {
    const isNewBatch = this.pendingEvents.size === 1 && !this.maxBatchTimer;

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }

    this._status.pending = true;

    if (isNewBatch) {
      this.maxBatchTimer = setTimeout(() => {
        this.flushPending();
      }, this.maxBatchDelayMs);
    }

    this.debounceTimer = setTimeout(() => {
      this.flushPending();
    }, this.debounceMs);
  }

  private flushPending(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.maxBatchTimer) {
      clearTimeout(this.maxBatchTimer);
      this.maxBatchTimer = null;
    }

    if (this.pendingEvents.size === 0) {
      this._status.pending = false;
      return;
    }

    const paths: string[] = [];
    for (const [vaultRelativePath, event] of this.pendingEvents) {
      if (!event.isExcluded) {
        paths.push(vaultRelativePath);
      }
    }

    this.pendingEvents.clear();
    this._status.pending = false;
    this._status.lastEventAt = Date.now();

    if (this.onUpdate && paths.length > 0) {
      try {
        this.onUpdate(paths);
      } catch {
        // Silently ignore callback errors
      }
    }
  }

  private handleWatcherError(err: NodeJS.ErrnoException): void {
    if (this._status.state === "disabled") return;

    const code = this.mapErrorCode(err, err.code);
    this._status.state = "degraded";
    this._status.lastError = {
      code,
      message: err.message,
    };
  }

  private mapErrorCode(
    _err: NodeJS.ErrnoException | Error,
    errCode?: string,
  ): string {
    if (errCode === "EACCES" || errCode === "EPERM") {
      return "WATCHER_PERMISSION_DENIED";
    }
    if (errCode === "ENOENT") {
      return "WATCHER_PATH_OUTSIDE_VAULT";
    }
    if (errCode === "EFBIG" || errCode === "ENFILE" || errCode === "EMFILE") {
      return "WATCHER_TOO_MANY_FILES";
    }
    if (
      errCode === "ENOSPC" ||
      errCode === "ENOMEM" ||
      errCode === "WATCHER_EVENT_OVERFLOW"
    ) {
      return "WATCHER_EVENT_OVERFLOW";
    }
    return "WATCHER_UNKNOWN_ERROR";
  }

  setUnavailable(reason: string): void {
    this._status.state = "unavailable";
    this._status.lastError = {
      code: "WATCHER_UNAVAILABLE",
      message: reason,
    };
  }

  async stop(): Promise<void> {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    this.watchedDirs.clear();
    this.pendingEvents.clear();
    this._status.state = "stopped";
    this._status.pending = false;
  }

  destroy(): void {
    this.destroyed = true;
    this.stop();
  }
}

export type FreshnessState =
  | "fresh"
  | "pending"
  | "updating"
  | "stale"
  | "incompatible"
  | "unknown";

export interface FreshnessInfo {
  state: FreshnessState;
  lastSuccessfulUpdateAt: number | null;
  pendingChangeCount: number;
  reindexRequired: boolean;
  reindexReasons: string[];
}

export interface FreshnessTransition {
  from: FreshnessState;
  to: FreshnessState;
  reason?: string;
}

export class FreshnessMachine {
  private _state: FreshnessState;
  private _lastSuccessfulUpdateAt: number | null;
  private _pendingChangeCount: number;
  private _reindexRequired: boolean;
  private _reindexReasons: string[];
  private _transitions: FreshnessTransition[] = [];

  constructor(initialState?: FreshnessState) {
    this._state = initialState ?? "unknown";
    this._lastSuccessfulUpdateAt = null;
    this._pendingChangeCount = 0;
    this._reindexRequired = false;
    this._reindexReasons = [];
  }

  get state(): FreshnessState {
    return this._state;
  }

  get info(): FreshnessInfo {
    return {
      state: this._state,
      lastSuccessfulUpdateAt: this._lastSuccessfulUpdateAt,
      pendingChangeCount: this._pendingChangeCount,
      reindexRequired: this._reindexRequired,
      reindexReasons: [...this._reindexReasons],
    };
  }

  get transitions(): FreshnessTransition[] {
    return [...this._transitions];
  }

  transition(to: FreshnessState, reason?: string): void {
    const from = this._state;
    if (from === to) return;

    this._transitions.push({ from, to, reason });
    this._state = to;

    if (to === "fresh") {
      this._lastSuccessfulUpdateAt = Date.now();
      this._pendingChangeCount = 0;
      this._reindexRequired = false;
      this._reindexReasons = [];
    }
  }

  changesDetected(count: number = 1): void {
    if (this._state === "unknown") {
      this.transition("pending", "Initial changes detected");
    } else if (this._state === "fresh") {
      this.transition("pending", `${count} change(s) detected`);
    }
    this._pendingChangeCount += count;
  }

  writerStarted(): void {
    if (this._state === "pending") {
      this.transition("updating", "Index writer started");
    } else if (this._state === "stale") {
      this.transition("updating", "Index writer started (recovery)");
    }
  }

  writerSucceeded(): void {
    if (this._state === "updating") {
      this.transition("fresh", "Index committed successfully");
    }
  }

  writerFailed(error?: string): void {
    if (this._state === "updating") {
      if (error) {
        this._reindexReasons.push(`Writer failed: ${error}`);
      }
      this.transition("stale", `Index update failed: ${error ?? "unknown"}`);
    }
  }

  markReindexRequired(reasons: string[]): void {
    this._reindexRequired = true;
    for (const reason of reasons) {
      if (!this._reindexReasons.includes(reason)) {
        this._reindexReasons.push(reason);
      }
    }
    if (this._state === "fresh" || this._state === "stale") {
      this.transition("incompatible", "Reindex required");
    }
  }

  markStale(reason: string): void {
    if (this._state === "fresh") {
      this._reindexReasons.push(reason);
      this.transition("stale", reason);
    } else if (!this._reindexReasons.includes(reason)) {
      this._reindexReasons.push(reason);
    }
  }

  clearPendingChanges(): void {
    this._pendingChangeCount = 0;
    if (this._state === "pending") {
      this.transition("fresh", "All changes processed");
    }
  }

  checkStaleness(params: {
    manifestSchemaVersion?: number;
    currentSchemaVersion?: number;
    manifestVaultIdentity?: string;
    currentVaultIdentity?: string;
    manifestExcludePatterns?: string[];
    currentExcludePatterns?: string[];
    manifestTargetChunkSize?: number;
    currentTargetChunkSize?: number;
    manifestMaxChunkSize?: number;
    currentMaxChunkSize?: number;
    manifestEmbeddingModel?: string | null;
    currentEmbeddingModel?: string | null;
    manifestEmbeddingDimension?: number | null;
    currentEmbeddingDimension?: number | null;
  }): { isIncompatible: boolean; isStale: boolean; reasons: string[] } {
    const reasons: string[] = [];

    if (
      params.manifestSchemaVersion !== undefined &&
      params.currentSchemaVersion !== undefined &&
      params.manifestSchemaVersion !== params.currentSchemaVersion
    ) {
      reasons.push(
        `Schema version mismatch: index has v${params.manifestSchemaVersion}, current is v${params.currentSchemaVersion}`,
      );
    }

    if (
      params.manifestVaultIdentity !== undefined &&
      params.currentVaultIdentity !== undefined &&
      params.manifestVaultIdentity !== params.currentVaultIdentity
    ) {
      reasons.push("Vault identity changed since indexing");
    }

    if (
      params.manifestExcludePatterns !== undefined &&
      params.currentExcludePatterns !== undefined
    ) {
      const sortedIndexed = [...params.manifestExcludePatterns].sort();
      const sortedCurrent = [...params.currentExcludePatterns].sort();
      if (JSON.stringify(sortedIndexed) !== JSON.stringify(sortedCurrent)) {
        reasons.push("Exclude patterns have changed since indexing");
      }
    }

    if (
      params.manifestTargetChunkSize !== undefined &&
      params.currentTargetChunkSize !== undefined &&
      params.manifestTargetChunkSize !== params.currentTargetChunkSize
    ) {
      reasons.push("Target chunk size configuration has changed");
    }

    if (
      params.manifestMaxChunkSize !== undefined &&
      params.currentMaxChunkSize !== undefined &&
      params.manifestMaxChunkSize !== params.currentMaxChunkSize
    ) {
      reasons.push("Max chunk size configuration has changed");
    }

    if (
      params.manifestEmbeddingModel !== undefined &&
      params.currentEmbeddingModel !== undefined &&
      params.manifestEmbeddingModel !== params.currentEmbeddingModel
    ) {
      reasons.push("Embedding model configuration has changed");
    }

    if (
      params.manifestEmbeddingDimension !== undefined &&
      params.currentEmbeddingDimension !== undefined &&
      params.manifestEmbeddingDimension !== params.currentEmbeddingDimension
    ) {
      reasons.push("Embedding dimension mismatch");
    }

    const isIncompatible =
      reasons.length > 0 &&
      (reasons.some((r) => r.includes("Schema version")) ||
        reasons.some((r) => r.includes("Vault identity")) ||
        reasons.some((r) => r.includes("dimension mismatch")));

    const isStale = reasons.length > 0 && !isIncompatible;

    return { isIncompatible, isStale, reasons };
  }
}

export function initialFreshness(): FreshnessInfo {
  return {
    state: "unknown",
    lastSuccessfulUpdateAt: null,
    pendingChangeCount: 0,
    reindexRequired: false,
    reindexReasons: [],
  };
}

export function createFreshnessMachine(
  initialState?: FreshnessState,
): FreshnessMachine {
  return new FreshnessMachine(initialState);
}

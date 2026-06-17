import { Config } from "./config.js";
import { FreshnessInfo } from "./freshness.js";
import { WatcherStatus } from "./watcher.js";
import { SyncStatus } from "./sync.js";

export interface ServerStatusInfo {
  running: boolean;
  host: string;
  port: number;
  apiKeyRequired: boolean;
}

export interface IndexStatusInfo {
  freshness: FreshnessInfo;
  embeddingState:
    | "disabled"
    | "ready"
    | "unavailable"
    | "stale"
    | "incompatible";
}

export interface FullStatus {
  server: ServerStatusInfo;
  index: IndexStatusInfo;
  watch: WatcherStatus;
  sync: SyncStatus;
}

export function buildStatus(
  config: Config,
  overrides?: {
    server?: Partial<ServerStatusInfo>;
    index?: Partial<IndexStatusInfo>;
    watch?: Partial<WatcherStatus>;
    sync?: Partial<SyncStatus>;
  },
): FullStatus {
  // Phase 2: build real status from runtime state.
  const server: ServerStatusInfo = {
    running: true,
    host: config.server.host,
    port: config.server.port,
    apiKeyRequired: Boolean(config.server.apiKey),
    ...overrides?.server,
  };

  const index: IndexStatusInfo = {
    freshness: {
      state: "unknown",
      lastSuccessfulUpdateAt: null,
      pendingChangeCount: 0,
      reindexRequired: false,
      reindexReasons: [],
    },
    embeddingState: config.embedding.enabled ? "ready" : "disabled",
    ...overrides?.index,
  };

  const watch: WatcherStatus = {
    enabled: config.watch.enabled,
    state: config.watch.enabled ? "starting" : "disabled",
    lastEventAt: null,
    pending: false,
    lastError: null,
    ...overrides?.watch,
  };

  const sync: SyncStatus = {
    enabled: config.sync.enabled,
    configured: Boolean(config.sync.repo),
    state: "idle",
    pending: false,
    lastSuccessfulSyncAt: null,
    consecutiveFailures: 0,
    lastError: null,
    ...overrides?.sync,
  };

  return {
    server,
    index,
    watch,
    sync,
  };
}

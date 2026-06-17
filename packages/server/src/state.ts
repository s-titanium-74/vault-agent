import {
  Config,
  EmbeddingProvider,
  IndexStore,
  VaultWatcher,
  GitSync,
  FreshnessMachine,
} from "@vault-agent/core";

let store: IndexStore | null = null;
let config: Config | null = null;
let embeddingProvider: EmbeddingProvider | null = null;
let watcher: VaultWatcher | null = null;
let gitSync: GitSync | null = null;
let freshnessMachine: FreshnessMachine | null = null;

export function initApp(
  appStore: IndexStore,
  appConfig: Config,
  appWatcher?: VaultWatcher,
  appGitSync?: GitSync,
  appFreshnessMachine?: FreshnessMachine,
): void {
  store = appStore;
  config = appConfig;
  if (appConfig.embedding.enabled && appConfig.embedding.model) {
    embeddingProvider = new EmbeddingProvider(appConfig);
  } else {
    embeddingProvider = null;
  }
  watcher = appWatcher ?? null;
  gitSync = appGitSync ?? null;
  freshnessMachine = appFreshnessMachine ?? null;
}

export function resetApp(): void {
  store = null;
  config = null;
  embeddingProvider = null;
  if (watcher) {
    watcher.destroy();
    watcher = null;
  }
  if (gitSync) {
    gitSync.stopScheduledSync();
    gitSync = null;
  }
  freshnessMachine = null;
}

export function getAppState(): {
  store: IndexStore | null;
  config: Config | null;
  embeddingProvider: EmbeddingProvider | null;
  watcher: VaultWatcher | null;
  gitSync: GitSync | null;
  freshnessMachine: FreshnessMachine | null;
} {
  return {
    store,
    config,
    embeddingProvider,
    watcher,
    gitSync,
    freshnessMachine,
  };
}

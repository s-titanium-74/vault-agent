import { Config, EmbeddingProvider, IndexStore } from "@vault-agent/core";

let store: IndexStore | null = null;
let config: Config | null = null;
let embeddingProvider: EmbeddingProvider | null = null;

export function initApp(appStore: IndexStore, appConfig: Config): void {
  store = appStore;
  config = appConfig;
  if (appConfig.embedding.enabled && appConfig.embedding.model) {
    embeddingProvider = new EmbeddingProvider(appConfig);
  } else {
    embeddingProvider = null;
  }
}

export function resetApp(): void {
  store = null;
  config = null;
  embeddingProvider = null;
}

export function getAppState(): {
  store: IndexStore | null;
  config: Config | null;
  embeddingProvider: EmbeddingProvider | null;
} {
  return { store, config, embeddingProvider };
}

export {
  loadConfig,
  resolveConfig,
  ConfigManager,
  configSchema,
  DEFAULT_CONFIG,
  type Config,
  type ServerConfig,
  type VaultConfig,
  type IndexConfig,
  type EmbeddingConfig,
  type CorsConfig,
  type WatchConfig,
  type SyncConfig,
} from "./config.js";
export { envPaths, defaultConfigPath, defaultIndexDir } from "./paths.js";
export { vaultIdentity, noteIdFromPath } from "./identifiers.js";
export {
  validateVaultPath,
  isPathInsideVault,
  resolveVaultRelativePath,
} from "./pathsafety.js";
export type {
  SearchMode,
  SearchResult,
  SearchResultItem,
  RelatedResult,
  NoteRetrieveResult,
  ChunkRetrieveResult,
  AttachmentMetadataResult,
  WarningItem,
} from "./schemas.js";
export {
  searchModeSchema,
  searchRequestSchema,
  relatedRequestSchema,
  noteRetrieveQuerySchema,
  chunkRetrieveQuerySchema,
  attachmentRetrieveQuerySchema,
  DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT,
} from "./schemas.js";
export { IndexStore, getIndexPath } from "./index-store.js";
export { indexVault, reindexVault, type IndexOptions } from "./indexer.js";
export { search } from "./search.js";
export { getRelated } from "./related.js";
export {
  getNote,
  getChunk,
  getAttachmentMetadata,
  getAttachmentBytes,
} from "./retrieval.js";
export type { Note, Chunk, IndexManifest } from "./types.js";
export { VaultDiscovery } from "./discovery.js";
export {
  parseMarkdown,
  extractFrontmatter,
  extractWikilinks,
  extractAttachmentReferences,
} from "./markdown.js";
export { chunkNote } from "./chunking.js";
export {
  IndexError,
  SearchError,
  RetrievalError,
  RetrievalSizeError,
  ConfigError,
} from "./errors.js";
export { InvalidPathError } from "./retrieval.js";
export { PathSafetyError } from "./pathsafety.js";
export {
  EmbeddingProvider,
  EmbeddingProviderError,
  validateEmbeddingEndpoint,
} from "./embedding.js";
export type { FreshnessState, FreshnessInfo } from "./freshness.js";
export {
  initialFreshness,
  createFreshnessMachine,
  FreshnessMachine,
} from "./freshness.js";
export type { WatcherState, WatcherStatus, WatcherEvent } from "./watcher.js";
export { VaultWatcher } from "./watcher.js";
export type { IncrementalIndexOptions } from "./incremental-indexer.js";
export { incrementalIndexUpdate } from "./incremental-indexer.js";
export type { SyncRunState, SyncStatus, SyncPullResult } from "./sync.js";
export { GitSync, SyncError, isAllowedGitRemoteUrl } from "./sync.js";
export type {
  ServerStatusInfo,
  IndexStatusInfo,
  FullStatus,
} from "./status.js";
export { buildStatus } from "./status.js";

export { FilesystemSource } from "./filesystem.js";
export {
  SqliteMetadataStore,
  SqliteVectorStore,
  localRetrievalContext,
} from "./sqlite.js";
export { EmbeddingProvider as OllamaEmbeddingProvider } from "../embedding.js";

export { configuredVaultIdentity, pcloudSource } from "./source.js";
export {
  LocalMutationService,
  LocalMutationError,
  type LocalMutationOptions,
  type MutationResult,
} from "./mutations.js";

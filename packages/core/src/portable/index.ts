export type * from "./contracts.js";
export {
  escapeFTSQuery,
  textToTrigrams,
  matchFallbackNotes,
} from "../index-store-fts.js";
export {
  SourceError,
  canonicalSourcePath,
  sourcePolicy,
  guidanceKind,
} from "./source-policy.js";
export {
  contentRevision,
  noteIdFromPath,
  createVaultId,
} from "./identifiers.js";
export { isValidNoteId, parseChunkId } from "./id-validation.js";
export { chunkNote } from "./chunking.js";
export * from "../markdown-shared.js";
export * from "../schemas.js";
export * from "../search-filters.js";
export * from "../errors.js";
export * from "../freshness.js";
export * from "../result-shared.js";
export { search, fuseResults } from "./search.js";
export { getRelated } from "./related.js";
export { getNote, getChunk } from "./retrieval.js";
export { EmbeddingProviderError } from "./embedding.js";
export type {
  Chunk,
  Frontmatter,
  WikilinkInfo,
  IndexManifest,
} from "../types.js";
export {
  getOverview,
  getTree,
  getTags,
  getFacets,
} from "../orientation-shared.js";
export {
  getNoteLinks,
  getBacklinks,
  getBrokenLinks,
  getOrphanNotes,
  getLinkSummary,
} from "../link-graph-shared.js";
export { getMetadataProfile, getStyleProfile } from "../profile-shared.js";

export { prepareSourceNote, uploadKind, uploadLimit } from "./ingestion.js";
export {
  prepareIndexRows,
  createIndexLinkResolver,
  indexLinkInputs,
  type IndexNote,
} from "./index-data.js";
export {
  planSourceChanges,
  prepareNoteUpdate,
  prepareEmbeddingBatch,
  embeddingInputKey,
  indexRowsEqual,
  prepareIndexDelta,
  type IndexedSource,
  type SourceObservation,
  type SourceChange,
  type IndexEmbeddingInput,
  type IndexEmbeddingCache,
  type PreparedEmbedding,
} from "./index-updates.js";

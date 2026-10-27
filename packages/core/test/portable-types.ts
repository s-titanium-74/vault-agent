// Checked separately with DOM/ES libraries and types: [], without @types/node.
import {
  chunkNote,
  noteIdFromPath,
  search,
  getNote,
  getMetadataProfile,
  type VaultSource,
  type RetrievalContext,
  type EmbeddingProviderContract,
} from "../dist/portable/index.js";
declare const source: VaultSource;
declare const context: RetrievalContext;
declare const provider: EmbeddingProviderContract;
const id: Promise<string> = noteIdFromPath("Notes/Example.md");
const result = search(context, "synthetic", "lexical", 10);
const note = id.then((value) => getNote(context.metadata, source, value));
const descriptor = provider.describe();
void [result, note, descriptor, chunkNote, getMetadataProfile];

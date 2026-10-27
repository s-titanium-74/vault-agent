import type { MetadataLexicalStore } from "./contracts.js";
import { chunkRowToResultItem } from "../result-shared.js";
export { noteRowToResultItem } from "../result-shared.js";
export async function chunkToResultItem(
  store: MetadataLexicalStore,
  id: string,
  score: number,
  reason: string,
) {
  const chunk = await store.getChunkById(id);
  const note = chunk ? await store.getNote(chunk.note_id as string) : null;
  if (!chunk || !note) return null;
  return chunkRowToResultItem(chunk, note, id, score, reason);
}

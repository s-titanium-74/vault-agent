import type { IndexStore } from "./index-store.js";
import { chunkRowToResultItem } from "./result-shared.js";
export * from "./result-shared.js";
export function chunkToResultItem(
  store: IndexStore,
  chunkId: string,
  score: number,
  reason: string,
) {
  const chunk = store.getChunkById(chunkId);
  const note = chunk ? store.getNote(chunk.note_id as string) : null;
  return chunkRowToResultItem(chunk, note, chunkId, score, reason);
}

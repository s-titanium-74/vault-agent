import { chunkNoteWithHash } from "../chunking-shared.js";
import { contentRevision } from "./identifiers.js";
export async function chunkNote(
  params: Parameters<typeof chunkNoteWithHash>[0],
) {
  const result = chunkNoteWithHash(params, () => "");
  for (const chunk of result.chunks)
    chunk.contentHash = (await contentRevision(chunk.content)).slice(0, 32);
  return result;
}

import crypto from "node:crypto";
import { chunkNoteWithHash } from "./chunking-shared.js";
export type { ChunkingResult } from "./chunking-shared.js";
export function chunkNote(params: Parameters<typeof chunkNoteWithHash>[0]) {
  return chunkNoteWithHash(params, (text) =>
    crypto.createHash("sha256").update(text).digest("hex").slice(0, 32),
  );
}

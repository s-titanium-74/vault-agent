export * from "./markdown-shared.js";
import { createWikilinkResolver } from "./markdown-shared.js";
import { noteIdFromPath } from "./identifiers.js";

export function resolveWikilinks(
  notes: Parameters<typeof createWikilinkResolver>[0],
) {
  return createWikilinkResolver(notes, noteIdFromPath);
}

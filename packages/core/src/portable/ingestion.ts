import { guidanceKind } from "./source-policy.js";
import { parseMarkdown } from "../markdown-shared.js";
import { chunkNote } from "./chunking.js";
import { noteIdFromPath } from "./identifiers.js";
import type { SourceEntry } from "./contracts.js";
import { prepareIndexRows, type IndexNote } from "./index-data.js";

/** Shared deterministic preparation; runtime adapters own source admission and publication. */
export async function prepareSourceNote(
  entry: SourceEntry,
  text: string,
  options: { noteId?: string; mtimeMs?: number } = {},
) {
  const id = options.noteId ?? (await noteIdFromPath(entry.path));
  const md = parseMarkdown(text);
  const result = await chunkNote({
    noteId: id,
    vaultRelativePath: entry.path,
    title: md.title,
    headingPath: [],
    body: md.body,
    fileSize: entry.size,
  });
  const domain: IndexNote = {
    noteId: id,
    vaultRelativePath: entry.path,
    title: md.title,
    frontmatter: md.frontmatter,
    frontmatterDegraded: md.frontmatterDegraded,
    size: entry.size,
    contentHash: entry.revision,
    mtimeMs: options.mtimeMs ?? Date.parse(entry.updated),
    chunks: result.chunks,
    links: md.wikilinks,
    attachmentReferences: md.attachmentReferences,
  };
  return {
    ...prepareIndexRows(domain, md.wikilinks),
    domain,
    oversized: result.oversized,
    frontmatterDegraded: md.frontmatterDegraded,
  };
}
export function uploadKind(path: string): SourceEntry["kind"] | null {
  if (guidanceKind(path)) return "guidance";
  if (/\.(md|markdown)$/i.test(path)) return "note";
  return /\.(pdf|png|jpe?g|gif|webp|svg|avif)$/i.test(path)
    ? "attachment"
    : null;
}
export function uploadLimit(kind: SourceEntry["kind"]): number {
  return (kind === "attachment" ? 20 : 2) * 1024 * 1024;
}

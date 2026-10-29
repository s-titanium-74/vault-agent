import { guidanceKind } from "./source-policy.js";
import { parseMarkdown } from "../markdown-shared.js";
import { chunkNote } from "./chunking.js";
import { noteIdFromPath } from "./identifiers.js";
import {
  generateLexicalIndexText,
  generateEmbeddingInputText,
} from "../markdown-shared.js";
import type { IndexRow, SourceEntry } from "./contracts.js";

/** Shared deterministic parsing; storage adapters own staging and publication. */
export async function prepareSourceNote(entry: SourceEntry, text: string) {
  const id = await noteIdFromPath(entry.path);
  const md = parseMarkdown(text);
  const result = await chunkNote({
    noteId: id,
    vaultRelativePath: entry.path,
    title: md.title,
    headingPath: [],
    body: md.body,
    fileSize: entry.size,
  });
  const fm = md.frontmatter;
  const note: IndexRow = {
    note_id: id,
    path: entry.path,
    title: md.title,
    file_size: entry.size,
    content_hash: entry.revision,
    mtime_ms: Date.parse(entry.updated),
    frontmatter_title: fm?.title ?? null,
    aliases_json: JSON.stringify(md.aliases),
    tags_json: JSON.stringify(md.tags),
    date_value: fm?.date ?? null,
    created_value: fm?.created ?? null,
    updated_value: fm?.updated ?? null,
    has_frontmatter: fm ? 1 : 0,
    frontmatter_degraded: md.frontmatterDegraded ? 1 : 0,
    frontmatter_fields_json: JSON.stringify(fm ?? {}),
    links_json: "[]",
    wikilinks_json: JSON.stringify(md.wikilinks),
    attachment_refs_json: JSON.stringify(md.attachmentReferences),
    body_text: result.chunks.map((c) => c.content).join("\n"),
    oversized: result.oversized ? 1 : 0,
    empty: result.empty ? 1 : 0,
  };
  const chunks: IndexRow[] = result.chunks.map((c) => ({
    chunk_id: `${id}:${c.chunkIndex}`,
    note_id: id,
    chunk_index: c.chunkIndex,
    path: entry.path,
    title: c.title,
    heading: c.heading,
    heading_path_json: JSON.stringify(c.headingPath),
    content: c.content,
    content_hash: c.contentHash,
    char_start: c.charStart,
    char_end: c.charEnd,
    lexical_text: generateLexicalIndexText({
      title: c.title,
      aliases: md.aliases,
      tags: md.tags,
      headingPath: c.headingPath,
      content: c.content,
    }),
    embedding_input_text: generateEmbeddingInputText({
      title: c.title,
      headingPath: c.headingPath,
      content: c.content,
    }),
  }));
  return { note, chunks };
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

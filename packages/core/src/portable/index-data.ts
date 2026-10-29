import type { Note, WikilinkInfo } from "../types.js";
import type { IndexRow } from "./contracts.js";
import {
  createWikilinkResolver,
  generateEmbeddingInputText,
  generateLexicalIndexText,
} from "../markdown-shared.js";
import { MAX_MARKDOWN_SIZE_FOR_INDEXING } from "../schemas.js";

export type IndexNote = Omit<Note, "filePath">;
const knownFields = new Set([
  "title",
  "aliases",
  "tags",
  "date",
  "created",
  "updated",
]);

/** Recover original resolution inputs from legacy rows that only stored resolved links. */
export function indexLinkInputs(row: IndexRow): WikilinkInfo[] {
  if (typeof row.wikilinks_json === "string")
    return JSON.parse(row.wikilinks_json);
  return (JSON.parse(String(row.links_json ?? "[]")) as WikilinkInfo[]).map(
    (link) =>
      link.kind === "markdown" && link.resolved && link.targetPath
        ? { ...link, targetPath: "/" + link.targetPath.replace(/^\//, "") }
        : { ...link, resolved: null },
  );
}
export function prepareIndexRows(
  note: IndexNote,
  rawLinks?: readonly WikilinkInfo[],
) {
  const fm = note.frontmatter;
  const extra = Object.fromEntries(
    Object.entries(fm ?? {}).filter(([key]) => !knownFields.has(key)),
  );
  const oversized = note.size > MAX_MARKDOWN_SIZE_FOR_INDEXING;
  const row: IndexRow = {
    note_id: note.noteId,
    path: note.vaultRelativePath,
    title: note.title,
    file_size: note.size,
    content_hash: note.contentHash,
    mtime_ms: note.mtimeMs,
    frontmatter_title: fm?.title ?? null,
    aliases_json: JSON.stringify(fm?.aliases ?? []),
    tags_json: JSON.stringify(fm?.tags ?? []),
    date_value: fm?.date ?? null,
    created_value: fm?.created ?? null,
    updated_value: fm?.updated ?? null,
    has_frontmatter: fm ? 1 : 0,
    frontmatter_degraded: note.frontmatterDegraded ? 1 : 0,
    frontmatter_fields_json: Object.keys(extra).length
      ? JSON.stringify(extra)
      : null,
    links_json: JSON.stringify(note.links),
    wikilinks_json: JSON.stringify(
      rawLinks ?? indexLinkInputs({ links_json: JSON.stringify(note.links) }),
    ),
    attachment_refs_json: JSON.stringify(note.attachmentReferences),
    body_text: note.chunks.map((c) => c.content).join("\n"),
    oversized: oversized ? 1 : 0,
    empty: !oversized && !note.chunks.length ? 1 : 0,
  };
  const chunks: IndexRow[] = note.chunks.map((c) => ({
    chunk_id: `${c.noteId}:${c.chunkIndex}`,
    note_id: c.noteId,
    chunk_index: c.chunkIndex,
    path: c.vaultRelativePath,
    title: c.title,
    heading: c.heading,
    heading_path_json: JSON.stringify(c.headingPath),
    content: c.content,
    content_hash: c.contentHash,
    char_start: c.charStart,
    char_end: c.charEnd,
    lexical_text: generateLexicalIndexText({
      title: c.title,
      aliases: fm?.aliases ?? [],
      tags: fm?.tags ?? [],
      headingPath: c.headingPath,
      content: c.content,
    }),
    embedding_input_text: generateEmbeddingInputText({
      title: c.title,
      headingPath: c.headingPath,
      content: c.content,
    }),
  }));
  return { note: row, chunks };
}

/** Resolve against final membership, including unchanged sources and removed targets. */
export function createIndexLinkResolver(rows: Iterable<IndexRow>) {
  const paths = new Map<string, string>();
  const stems = new Map<
    string,
    { noteId: string; title: string | null; aliases: string[] }[]
  >();
  for (const row of rows) {
    const path = String(row.path),
      noteId = String(row.note_id);
    paths.set(path, noteId);
    const stem = path
      .split("/")
      .at(-1)!
      .replace(/\.(md|markdown)$/i, "");
    stems.set(stem, [
      ...(stems.get(stem) ?? []),
      {
        noteId,
        title: row.title as string | null,
        aliases: JSON.parse(String(row.aliases_json ?? "[]")),
      },
    ]);
  }
  const resolve = createWikilinkResolver(
    stems,
    (path) => paths.get(path) ?? "",
  );
  return (row: IndexRow) => {
    const raw = indexLinkInputs(row);
    return {
      ...row,
      wikilinks_json: JSON.stringify(raw),
      links_json: JSON.stringify(
        raw.map((link) => resolve(link, String(row.path))),
      ),
    };
  };
}

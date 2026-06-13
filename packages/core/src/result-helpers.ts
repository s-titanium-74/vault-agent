import { IndexStore } from "./index-store.js";
import { MAX_SNIPPET_LENGTH, SearchResultItem } from "./schemas.js";

export function truncateSnippet(content: string): string {
  const trimmed = content.trim();
  if (trimmed.length <= MAX_SNIPPET_LENGTH) {
    return "";
  }
  return trimmed.slice(0, MAX_SNIPPET_LENGTH) + "...";
}

export function chunkMetadataFromNote(
  note: Record<string, unknown> | null,
): SearchResultItem["metadata"] {
  return {
    aliases: JSON.parse((note?.aliases_json as string) ?? "[]") as string[],
    tags: JSON.parse((note?.tags_json as string) ?? "[]") as string[],
    date: (note?.date_value as string) ?? null,
    created: (note?.created_value as string) ?? null,
    updated: (note?.updated_value as string) ?? null,
    attachmentCount: JSON.parse((note?.attachment_refs_json as string) ?? "[]")
      .length as number,
  };
}

export function chunkToResultItem(
  store: IndexStore,
  chunkId: string,
  score: number,
  reason: string,
): SearchResultItem {
  const chunk = store.getChunkById(chunkId);
  if (!chunk) {
    return {
      id: chunkId,
      type: "chunk",
      noteId: chunkId.split(":")[0] ?? "",
      chunkIndex: parseInt(chunkId.split(":")[1] ?? "0"),
      path: "",
      title: null,
      heading: null,
      headingPath: [],
      snippet: "",
      score,
      reason,
      metadata: {
        aliases: [],
        tags: [],
        date: null,
        created: null,
        updated: null,
        attachmentCount: 0,
      },
    };
  }

  const note = store.getNote(chunk.note_id as string);
  const content = (chunk.content as string) ?? "";
  const snippet = truncateSnippet(content);

  return {
    id: chunkId,
    type: "chunk",
    noteId: chunk.note_id as string,
    chunkIndex: chunk.chunk_index as number,
    path: chunk.path as string,
    title: (chunk.title as string) ?? null,
    heading: (chunk.heading as string) ?? null,
    headingPath: JSON.parse(
      (chunk.heading_path_json as string) ?? "[]",
    ) as string[],
    snippet,
    score,
    reason,
    metadata: chunkMetadataFromNote(note),
  };
}

export function noteRowToResultItem(
  row: Record<string, unknown>,
  reason: string,
): SearchResultItem {
  return {
    id: row.note_id as string,
    type: "note" as const,
    noteId: row.note_id as string,
    chunkIndex: null as number | null,
    path: row.path as string,
    title: (row.title as string) ?? null,
    heading: null as string | null,
    headingPath: [] as string[],
    snippet: "",
    score: 0,
    reason,
    metadata: chunkMetadataFromNote(row),
  };
}

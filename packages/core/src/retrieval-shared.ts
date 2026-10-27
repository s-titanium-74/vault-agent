import type { NoteRetrieveResult, ChunkRetrieveResult } from "./schemas.js";
export function noteFromRow(
  noteId: string,
  note: Record<string, unknown>,
  content: string,
  size: number,
): NoteRetrieveResult {
  const vrp = note.path as string;
  const linksJson = note.links_json as string | null;
  const attachmentRefsJson = note.attachment_refs_json as string | null;

  let links: { resolved: string[]; unresolved: string[] } | undefined;
  let attachments: string[] | undefined;

  if (linksJson) {
    try {
      const parsed = JSON.parse(linksJson);
      links = {
        resolved: parsed
          .filter((l: { resolved: string | null }) => l.resolved !== null)
          .map((l: { resolved: string }) => l.resolved),
        unresolved: parsed
          .filter((l: { resolved: string | null }) => l.resolved === null)
          .map((l: { target: string }) => l.target),
      };
    } catch {
      links = undefined;
    }
  }

  if (attachmentRefsJson) {
    try {
      attachments = JSON.parse(attachmentRefsJson);
    } catch {
      attachments = undefined;
    }
  }

  return {
    id: noteId,
    path: vrp,
    title: note.frontmatter_title as string | null,
    metadata: {
      aliases: JSON.parse((note.aliases_json as string) ?? "[]"),
      tags: JSON.parse((note.tags_json as string) ?? "[]"),
      date: note.date_value as string | null,
      created: note.created_value as string | null,
      updated: note.updated_value as string | null,
      attachmentCount: JSON.parse((note.attachment_refs_json as string) ?? "[]")
        .length as number,
    },
    content,
    contentType: "text/markdown; charset=utf-8",
    size,
    links,
    attachments,
  };
}

export function chunkFromRows(
  noteId: string,
  chunkIndex: number,
  chunk: Record<string, unknown>,
  note: Record<string, unknown> | null,
): ChunkRetrieveResult {
  return {
    id: `${noteId}:${chunkIndex}`,
    noteId,
    chunkIndex,
    path: chunk.path as string,
    title: (chunk.title as string) ?? null,
    heading: (chunk.heading as string) ?? null,
    headingPath: JSON.parse((chunk.heading_path_json as string) ?? "[]"),
    metadata: {
      aliases: JSON.parse((note?.aliases_json as string) ?? "[]"),
      tags: JSON.parse((note?.tags_json as string) ?? "[]"),
      date: (note?.date_value as string) ?? null,
      created: (note?.created_value as string) ?? null,
      updated: (note?.updated_value as string) ?? null,
      attachmentCount: JSON.parse(
        (note?.attachment_refs_json as string) ?? "[]",
      ).length as number,
    },
    content: chunk.content as string,
    contentType: "text/markdown; charset=utf-8",
    size: (chunk.content as string).length,
  };
}

import * as core from "../../core/src/portable/index.js";

export const VAULT_ID = "00000000-0000-4000-8000-000000000001";
export const files: Record<string, string> = {
  "Guide/Orchard.md":
    "---\ntitle: Orchard Guide\ntags: [garden, fruit]\ntype: guide\nstatus: active\n---\n# Orchard\nPlant apple trees in the orchard. [[Seasons]] ![[images/chart.png]]\n",
  "Guide/Seasons.md":
    "---\ntitle: Seasons\ntags: [garden]\ntype: reference\nstatus: draft\n---\n# Seasons\nApple trees need winter rest. 日本語の果樹園と季節について。 [[Missing]]\n",
  "Archive/Orchard.md":
    "---\ntitle: Archived Orchard\ntags: [archive]\n---\n# Orchard\nAn apple orchard archive.\n",
  "Guide/Empty.md": "---\ntitle: Empty orchard\ntags: [garden]\n---\n",
  "AGENTS.md": "# Vault context\nUse the orchard guide for gardening tasks.\n",
  "images/chart.png": "synthetic-image-placeholder",
};
const quote = (value: unknown) => `'${String(value).replace(/'/g, "''")}'`;
export async function fixture(extra: Record<string, string> = {}) {
  const content = { ...files, ...extra };
  const revision = await core.contentRevision(JSON.stringify(content));
  const notes: core.IndexRow[] = [];
  const chunks: core.IndexRow[] = [];
  const entries: core.SourceEntry[] = [];
  const objects: { key: string; content: string }[] = [];
  const parsed: {
    path: string;
    id: string;
    markdown: ReturnType<typeof core.parseMarkdown>;
  }[] = [];
  for (const [path, text] of Object.entries(content).sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    if (!core.sourcePolicy(["."])(path))
      throw new Error("Excluded fixture path");
    const kind = core.guidanceKind(path)
      ? "guidance"
      : /\.(md|markdown)$/.test(path)
        ? "note"
        : "attachment";
    const size = new TextEncoder().encode(text).length;
    const digest = await core.contentRevision(text);
    entries.push({
      path,
      kind,
      size,
      revision: digest,
      updated: "2026-01-01T00:00:00.000Z",
    });
    objects.push({ key: `${VAULT_ID}/${revision}/${path}`, content: text });
    if (kind !== "note") continue;
    const id = await core.noteIdFromPath(path);
    const md = core.parseMarkdown(text);
    parsed.push({ path, id, markdown: md });
    const result = await core.chunkNote({
      noteId: id,
      vaultRelativePath: path,
      title: md.title,
      headingPath: [],
      body: md.body,
      fileSize: size,
    });
    const fm = md.frontmatter;
    notes.push({
      note_id: id,
      path,
      title: md.title,
      file_size: size,
      content_hash: digest,
      mtime_ms: Date.parse("2026-01-01"),
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
      attachment_refs_json: JSON.stringify(md.attachmentReferences),
      body_text: result.chunks.map((c) => c.content).join("\n"),
      oversized: result.oversized ? 1 : 0,
      empty: result.empty ? 1 : 0,
    });
    for (const c of result.chunks) {
      const lexical = core.generateLexicalIndexText({
        title: c.title,
        aliases: md.aliases,
        tags: md.tags,
        headingPath: c.headingPath,
        content: c.content,
      });
      chunks.push({
        chunk_id: `${id}:${c.chunkIndex}`,
        note_id: id,
        chunk_index: c.chunkIndex,
        path,
        title: c.title,
        heading: c.heading,
        heading_path_json: JSON.stringify(c.headingPath),
        content: c.content,
        content_hash: c.contentHash,
        char_start: c.charStart,
        char_end: c.charEnd,
        lexical_text: lexical,
        embedding_input_text: core.generateEmbeddingInputText({
          title: c.title,
          headingPath: c.headingPath,
          content: c.content,
        }),
      });
    }
  }
  const stems = new Map<
    string,
    { noteId: string; title: string | null; aliases: string[] }[]
  >();
  const ids = new Map(parsed.map((p) => [p.path, p.id]));
  for (const p of parsed) {
    const stem = p.path
      .split("/")
      .at(-1)!
      .replace(/\.(md|markdown)$/, "");
    stems.set(stem, [
      ...(stems.get(stem) ?? []),
      { noteId: p.id, title: p.markdown.title, aliases: p.markdown.aliases },
    ]);
  }
  const resolve = core.createWikilinkResolver(
    stems,
    (path) => ids.get(path) ?? "",
  );
  for (const p of parsed)
    notes.find((n) => n.note_id === p.id)!.links_json = JSON.stringify(
      p.markdown.wikilinks.map((l) => resolve(l, p.path)),
    );
  const manifest: core.IndexManifest = {
    schemaVersion: core.INDEX_SCHEMA_VERSION,
    vaultIdentity: VAULT_ID,
    indexedFileExtensions: [".md", ".markdown"],
    effectiveExcludePatterns: core.DEFAULT_EXCLUDE_PATTERNS,
    targetChunkSize: core.TARGET_CHUNK_SIZE,
    maxChunkSize: core.MAX_CHUNK_SIZE,
    embeddingModel: null,
    embeddingDimension: null,
    noteCount: notes.length,
    chunkCount: chunks.length,
    indexedAt: Date.parse("2026-01-01"),
  };
  const statements: string[] = [];
  const add = (sql: string) => statements.push(sql);
  add(
    `INSERT INTO snapshots VALUES(${quote(revision)},${quote(VAULT_ID)},${quote(JSON.stringify(manifest))},${notes.length},${chunks.length},${entries.length},${new TextEncoder().encode(JSON.stringify([...notes, ...chunks])).length})`,
  );
  add(
    `CREATE VIRTUAL TABLE fts_${revision} USING fts5(chunk_id UNINDEXED,lexical_text,tokenize='unicode61')`,
  );
  for (const e of entries)
    add(
      `INSERT INTO sources VALUES(${quote(revision)},${quote(e.path)},${quote(e.kind)},${e.size},${quote(e.revision)},${quote(e.updated)})`,
    );
  for (const n of notes)
    add(
      `INSERT INTO notes VALUES(${quote(revision)},${quote(n.note_id)},${quote(n.path)},${quote(JSON.stringify(n))})`,
    );
  for (const c of chunks) {
    add(
      `INSERT INTO chunks VALUES(${quote(revision)},${quote(c.chunk_id)},${quote(c.note_id)},${c.chunk_index},${quote(JSON.stringify(c))})`,
    );
    add(
      `INSERT INTO fts_${revision}(chunk_id,lexical_text) VALUES(${quote(c.chunk_id)},${quote(c.lexical_text)})`,
    );
    for (const gram of core.textToTrigrams(String(c.lexical_text)))
      add(
        `INSERT INTO grams VALUES(${quote(revision)},${quote(c.chunk_id)},${quote(gram)})`,
      );
  }
  add(`INSERT OR REPLACE INTO deployment VALUES(1,${quote(revision)})`);
  return { revision, statements, objects, notes, chunks, manifest, entries };
}

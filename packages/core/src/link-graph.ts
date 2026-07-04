import { Config } from "./config.js";
import { SearchError } from "./errors.js";
import { FreshnessMachine, type FreshnessState } from "./freshness.js";
import { IndexStore } from "./index-store.js";
import { normalizePathFilter } from "./search-filters.js";
import {
  BacklinksResult,
  BrokenLinksResult,
  DEFAULT_LINK_RESULT_LIMIT,
  DEFAULT_LINK_SUMMARY_LIMIT,
  LinkEdge,
  LinkNoteResult,
  LinkSummaryResult,
  LinkedNoteSummary,
  MAX_LINK_RESULT_LIMIT,
  MAX_LINK_SUMMARY_LIMIT,
  OrphanNotesResult,
  WarningItem,
} from "./schemas.js";
import type { WikilinkInfo } from "./types.js";

export interface LinkGraphContext {
  store: IndexStore;
  config: Config;
  freshnessMachine?: FreshnessMachine | null;
}

export interface LinkGraphParams {
  limit?: number;
  pathPrefix?: string;
}

interface LinkGraphOutput<T> {
  data: T;
  warnings: WarningItem[];
}

interface NoteInfo {
  noteId: string;
  path: string;
  title: string | null;
  links: WikilinkInfo[];
}

function resolveFreshnessState(ctx: LinkGraphContext): FreshnessState {
  if (ctx.freshnessMachine) {
    return ctx.freshnessMachine.state;
  }
  const staleness = ctx.store.checkStaleness(ctx.config);
  if (staleness.incompatible) return "incompatible";
  if (staleness.stale) return "stale";
  return "fresh";
}

function assertUsableIndex(ctx: LinkGraphContext): void {
  const manifest = ctx.store.getManifest();
  if (!manifest) {
    throw new SearchError(
      "INDEX_NOT_FOUND",
      "No usable index found. Run `vault-agent index` or `vault-agent reindex`.",
    );
  }

  const staleness = ctx.store.checkStaleness(ctx.config);
  if (staleness.incompatible) {
    throw new SearchError(
      "INDEX_INCOMPATIBLE",
      `Index is incompatible and must be rebuilt. ${staleness.details}`,
    );
  }
}

function freshnessWarning(state: FreshnessState): WarningItem | null {
  switch (state) {
    case "stale":
      return {
        code: "INDEX_STALE",
        message: "Index may be outdated. Run `vault-agent index` to refresh.",
      };
    case "pending":
      return {
        code: "INDEX_PENDING",
        message: "Index update is pending.",
      };
    case "updating":
      return {
        code: "INDEX_UPDATING",
        message: "Index update is in progress.",
      };
    case "unknown":
      return {
        code: "INDEX_UNKNOWN",
        message: "Index freshness is unknown.",
      };
    case "fresh":
    case "incompatible":
      return null;
  }
}

export function getNoteLinks(
  ctx: LinkGraphContext,
  noteId: string,
): LinkGraphOutput<LinkNoteResult> {
  assertUsableIndex(ctx);
  const graph = buildGraph(ctx.store);
  const note = graph.notesById.get(noteId);
  if (!note) {
    throw new SearchError("NOTE_NOT_FOUND", "Note not found.");
  }

  const freshness = resolveFreshnessState(ctx);
  const warnings = warningsForFreshness(freshness);
  return {
    data: {
      noteId: note.noteId,
      path: note.path,
      title: note.title,
      outlinks: graph.outlinksByNoteId.get(noteId) ?? [],
      backlinks: graph.backlinksByNoteId.get(noteId) ?? [],
      indexFreshness: freshness,
    },
    warnings,
  };
}

export function getBacklinks(
  ctx: LinkGraphContext,
  noteId: string,
): LinkGraphOutput<BacklinksResult> {
  assertUsableIndex(ctx);
  const graph = buildGraph(ctx.store);
  const note = graph.notesById.get(noteId);
  if (!note) {
    throw new SearchError("NOTE_NOT_FOUND", "Note not found.");
  }

  const freshness = resolveFreshnessState(ctx);
  return {
    data: {
      noteId: note.noteId,
      path: note.path,
      title: note.title,
      backlinks: graph.backlinksByNoteId.get(noteId) ?? [],
      indexFreshness: freshness,
    },
    warnings: warningsForFreshness(freshness),
  };
}

export function getBrokenLinks(
  ctx: LinkGraphContext,
  params: LinkGraphParams = {},
): LinkGraphOutput<BrokenLinksResult> {
  assertUsableIndex(ctx);
  const limit = clampLimit(
    params.limit,
    DEFAULT_LINK_RESULT_LIMIT,
    MAX_LINK_RESULT_LIMIT,
  );
  const graph = buildGraph(ctx.store);
  const freshness = resolveFreshnessState(ctx);
  const links = graph.edges.filter((edge) => !edge.resolved).sort(compareEdges);

  return {
    data: {
      links: links.slice(0, limit),
      limit,
      total: links.length,
      indexFreshness: freshness,
    },
    warnings: [
      ...truncationWarning("BROKEN_LINKS_TRUNCATED", links.length, limit),
      ...warningsForFreshness(freshness),
    ],
  };
}

export function getOrphanNotes(
  ctx: LinkGraphContext,
  params: LinkGraphParams = {},
): LinkGraphOutput<OrphanNotesResult> {
  assertUsableIndex(ctx);
  const limit = clampLimit(
    params.limit,
    DEFAULT_LINK_RESULT_LIMIT,
    MAX_LINK_RESULT_LIMIT,
  );
  const graph = buildGraph(ctx.store);
  const freshness = resolveFreshnessState(ctx);
  const notes = getOrphans(graph).sort(compareLinkedNotes);

  return {
    data: {
      notes: notes.slice(0, limit),
      limit,
      total: notes.length,
      indexFreshness: freshness,
    },
    warnings: [
      ...truncationWarning("ORPHAN_NOTES_TRUNCATED", notes.length, limit),
      ...warningsForFreshness(freshness),
    ],
  };
}

export function getLinkSummary(
  ctx: LinkGraphContext,
  params: LinkGraphParams = {},
): LinkGraphOutput<LinkSummaryResult> {
  assertUsableIndex(ctx);
  const limit = clampLimit(
    params.limit,
    DEFAULT_LINK_SUMMARY_LIMIT,
    MAX_LINK_SUMMARY_LIMIT,
  );
  const graph = buildGraph(ctx.store);
  const freshness = resolveFreshnessState(ctx);
  const pathPrefix = normalizePathPrefix(params.pathPrefix);
  const scopedNotes = pathPrefix
    ? Array.from(graph.notesById.values()).filter((note) =>
        isUnderPathPrefix(note.path, pathPrefix),
      )
    : Array.from(graph.notesById.values());
  const scopedNoteIds = new Set(scopedNotes.map((note) => note.noteId));
  const scopedEdges = graph.edges.filter((edge) =>
    scopedNoteIds.has(edge.sourceNoteId),
  );

  const summaries = scopedNotes.map((note) =>
    makeLinkedNoteSummary(note, graph),
  );
  const topLinkedNotes = summaries
    .filter((note) => note.inboundCount > 0 || note.outboundCount > 0)
    .sort((a, b) => {
      const aTotal = a.inboundCount + a.outboundCount;
      const bTotal = b.inboundCount + b.outboundCount;
      if (bTotal !== aTotal) return bTotal - aTotal;
      return a.path.localeCompare(b.path);
    });

  return {
    data: {
      noteCount: scopedNotes.length,
      resolvedLinkCount: scopedEdges.filter((edge) => edge.resolved).length,
      unresolvedLinkCount: scopedEdges.filter((edge) => !edge.resolved).length,
      orphanNoteCount: summaries.filter(
        (note) => note.inboundCount === 0 && note.outboundCount === 0,
      ).length,
      topLinkedNotes: topLinkedNotes.slice(0, limit),
      limit,
      pathPrefix,
      indexFreshness: freshness,
    },
    warnings: [
      ...truncationWarning(
        "TOP_LINKED_NOTES_TRUNCATED",
        topLinkedNotes.length,
        limit,
      ),
      ...warningsForFreshness(freshness),
    ],
  };
}

function buildGraph(store: IndexStore): {
  notesById: Map<string, NoteInfo>;
  edges: LinkEdge[];
  outlinksByNoteId: Map<string, LinkEdge[]>;
  backlinksByNoteId: Map<string, LinkEdge[]>;
} {
  const notesById = new Map<string, NoteInfo>();
  for (const row of store.getAllNotes()) {
    const note = noteInfoFromRow(row);
    notesById.set(note.noteId, note);
  }

  const edges: LinkEdge[] = [];
  const outlinksByNoteId = new Map<string, LinkEdge[]>();
  const backlinksByNoteId = new Map<string, LinkEdge[]>();

  for (const source of notesById.values()) {
    for (const link of source.links) {
      const target = link.resolved ? notesById.get(link.resolved) : undefined;
      const edge: LinkEdge = {
        sourceNoteId: source.noteId,
        sourcePath: source.path,
        sourceTitle: source.title,
        targetNoteId: target?.noteId ?? null,
        targetPath: target?.path ?? null,
        targetTitle: target?.title ?? null,
        rawTarget: link.target,
        targetHeading: link.heading,
        display: link.display,
        kind: link.kind === "markdown" ? "markdown" : "wiki",
        resolved: Boolean(target),
      };
      edges.push(edge);
      pushMap(outlinksByNoteId, source.noteId, edge);
      if (target) {
        pushMap(backlinksByNoteId, target.noteId, edge);
      }
    }
  }

  for (const links of outlinksByNoteId.values()) links.sort(compareEdges);
  for (const links of backlinksByNoteId.values()) links.sort(compareEdges);

  return { notesById, edges, outlinksByNoteId, backlinksByNoteId };
}

function noteInfoFromRow(row: Record<string, unknown>): NoteInfo {
  return {
    noteId: row.note_id as string,
    path: row.path as string,
    title: (row.title as string) ?? null,
    links: parseLinks(row.links_json),
  };
}

function parseLinks(linksJson: unknown): WikilinkInfo[] {
  if (!linksJson) return [];
  try {
    const parsed = JSON.parse(linksJson as string) as unknown;
    if (!Array.isArray(parsed)) return [];
    const links: WikilinkInfo[] = parsed
      .filter((item): item is Partial<WikilinkInfo> => {
        return typeof item === "object" && item !== null;
      })
      .map((item) => {
        const kind: WikilinkInfo["kind"] =
          item.kind === "markdown" ? "markdown" : "wiki";
        return {
          target: typeof item.target === "string" ? item.target : "",
          heading: typeof item.heading === "string" ? item.heading : null,
          display: typeof item.display === "string" ? item.display : null,
          resolved: typeof item.resolved === "string" ? item.resolved : null,
          kind,
        };
      })
      .filter((item) => item.target.length > 0);
    return links;
  } catch {
    return [];
  }
}

function getOrphans(graph: ReturnType<typeof buildGraph>): LinkedNoteSummary[] {
  return Array.from(graph.notesById.values())
    .map((note) => makeLinkedNoteSummary(note, graph))
    .filter((note) => note.inboundCount === 0 && note.outboundCount === 0);
}

function makeLinkedNoteSummary(
  note: NoteInfo,
  graph: ReturnType<typeof buildGraph>,
): LinkedNoteSummary {
  return {
    noteId: note.noteId,
    path: note.path,
    title: note.title,
    inboundCount: graph.backlinksByNoteId.get(note.noteId)?.length ?? 0,
    outboundCount:
      graph.outlinksByNoteId.get(note.noteId)?.filter((edge) => edge.resolved)
        .length ?? 0,
  };
}

function pushMap(
  map: Map<string, LinkEdge[]>,
  key: string,
  edge: LinkEdge,
): void {
  const values = map.get(key) ?? [];
  values.push(edge);
  map.set(key, values);
}

function clampLimit(
  limit: number | undefined,
  fallback: number,
  max: number,
): number {
  if (limit === undefined) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(limit)));
}

function warningsForFreshness(state: FreshnessState): WarningItem[] {
  const warning = freshnessWarning(state);
  return warning ? [warning] : [];
}

function truncationWarning(
  code: string,
  total: number,
  limit: number,
): WarningItem[] {
  if (total <= limit) return [];
  return [
    {
      code,
      message: `Result was truncated to ${limit} entries.`,
      details: { total, limit },
    },
  ];
}

function compareEdges(a: LinkEdge, b: LinkEdge): number {
  const source = a.sourcePath.localeCompare(b.sourcePath);
  if (source !== 0) return source;
  return a.rawTarget.localeCompare(b.rawTarget);
}

function compareLinkedNotes(
  a: LinkedNoteSummary,
  b: LinkedNoteSummary,
): number {
  return a.path.localeCompare(b.path);
}

function normalizePathPrefix(value: string | undefined): string | null {
  if (!value) return null;
  return normalizePathFilter(value);
}

function isUnderPathPrefix(notePath: string, prefix: string): boolean {
  return notePath === prefix || notePath.startsWith(`${prefix}/`);
}

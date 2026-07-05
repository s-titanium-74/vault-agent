import { Config } from "./config.js";
import { SearchError } from "./errors.js";
import { FreshnessMachine, type FreshnessState } from "./freshness.js";
import { IndexStore } from "./index-store.js";
import { extractAttachmentReferences } from "./markdown.js";
import { normalizePathFilter } from "./search-filters.js";
import {
  DEFAULT_PROFILE_LIMIT,
  FACET_VALUE_ALLOWLIST,
  MAX_PROFILE_LIMIT,
  MetadataProfileField,
  MetadataProfileResult,
  ProfileExampleSelection,
  ProfileExample,
  ProfileParams,
  ProfileScopeFilters,
  StyleProfileResult,
  WarningItem,
} from "./schemas.js";
import type { WikilinkInfo } from "./types.js";

export interface ProfileContext {
  store: IndexStore;
  config: Config;
  freshnessMachine?: FreshnessMachine | null;
}

interface ProfileOutput<T> {
  data: T;
  warnings: WarningItem[];
}

const valueAllowlist = new Set<string>(FACET_VALUE_ALLOWLIST);
const defaultExampleSelection: ProfileExampleSelection = "path";

export function getMetadataProfile(
  ctx: ProfileContext,
  params: ProfileParams = {},
): ProfileOutput<MetadataProfileResult> {
  assertUsableIndex(ctx);
  const limit = clampLimit(params.limit);
  const filters = normalizeProfileFilters(params);
  const pathPrefix = filters.pathPrefix?.[0] ?? null;
  const exampleSelection = params.exampleSelection ?? defaultExampleSelection;
  const notes = scopedNotes(ctx.store, filters);
  const freshness = resolveFreshnessState(ctx);

  const fieldCounts = new Map<string, number>();
  const valueCounts = new Map<string, Map<string, number>>();
  const tagCounts = new Map<string, number>();
  let degradedFrontmatterNoteCount = 0;
  const profileValueAllowlist = configuredProfileValueAllowlist(ctx.config);

  for (const note of notes) {
    if (note.frontmatter_degraded) degradedFrontmatterNoteCount += 1;
    countFrontmatterFields(
      note,
      fieldCounts,
      valueCounts,
      profileValueAllowlist,
    );

    const seenTags = new Set<string>();
    for (const tag of parseStringArray(note.tags_json)) {
      const normalized = normalizeTag(tag);
      if (!normalized || seenTags.has(normalized)) continue;
      seenTags.add(normalized);
      tagCounts.set(normalized, (tagCounts.get(normalized) ?? 0) + 1);
    }
  }

  const frontmatterKeys: MetadataProfileField[] = sortCounted(
    Array.from(fieldCounts.entries()).map(([name, noteCount]) => {
      const values = valueCounts.get(name);
      return {
        name,
        noteCount,
        ...(values
          ? {
              values: sortCounted(
                Array.from(values.entries()).map(([value, count]) => ({
                  value,
                  noteCount: count,
                })),
                "value",
              ).slice(0, limit),
            }
          : {}),
      };
    }),
    "name",
  ).slice(0, limit);

  const tags = sortCounted(
    Array.from(tagCounts.entries()).map(([tag, noteCount]) => ({
      tag,
      noteCount,
    })),
    "tag",
  ).slice(0, limit);

  return {
    data: {
      scope: { pathPrefix, noteCount: notes.length, filters, exampleSelection },
      frontmatterKeys,
      tags,
      degradedFrontmatterNoteCount,
      examples: examplesFromNotes(notes, limit, exampleSelection),
      limit,
      indexFreshness: freshness,
    },
    warnings: [
      ...truncationWarning(
        "PROFILE_FRONTMATTER_KEYS_TRUNCATED",
        fieldCounts.size,
        limit,
      ),
      ...truncationWarning("PROFILE_TAGS_TRUNCATED", tagCounts.size, limit),
      ...warningsForFreshness(freshness),
    ],
  };
}

export function getStyleProfile(
  ctx: ProfileContext,
  params: ProfileParams = {},
): ProfileOutput<StyleProfileResult> {
  assertUsableIndex(ctx);
  const limit = clampLimit(params.limit);
  const filters = normalizeProfileFilters(params);
  const pathPrefix = filters.pathPrefix?.[0] ?? null;
  const exampleSelection = params.exampleSelection ?? defaultExampleSelection;
  const notes = scopedNotes(ctx.store, filters);
  const freshness = resolveFreshnessState(ctx);

  const headingLevelNotes = new Map<number, Set<string>>();
  const headingLevelCounts = new Map<number, number>();
  const headingNameNotes = new Map<string, Set<string>>();
  let h1MatchesTitleCount = 0;
  const chunkHeadingPaths = getChunkHeadingPathsByNote(ctx.store);

  let wikiLinkNoteCount = 0;
  let markdownLinkNoteCount = 0;
  let wikiLinkCount = 0;
  let markdownLinkCount = 0;

  let noteCountWithAttachments = 0;
  let totalAttachmentReferences = 0;
  let maxAttachmentReferencesInNote = 0;

  const namingPatternCounts = new Map<string, number>();

  for (const note of notes) {
    const noteId = String(note.note_id);
    const body = typeof note.body_text === "string" ? note.body_text : "";
    const noteHeadingPaths = chunkHeadingPaths.get(noteId) ?? [];
    const seenHeadings = new Set<string>();
    for (const headingPath of noteHeadingPaths) {
      for (let index = 0; index < headingPath.length; index += 1) {
        const level = index + 1;
        const headingText = headingPath[index]!;
        const headingKey = `${level}:${headingPath.slice(0, level).join("/")}`;
        if (seenHeadings.has(headingKey)) continue;
        seenHeadings.add(headingKey);

        const levelNotes = headingLevelNotes.get(level) ?? new Set<string>();
        levelNotes.add(noteId);
        headingLevelNotes.set(level, levelNotes);
        headingLevelCounts.set(level, (headingLevelCounts.get(level) ?? 0) + 1);

        const normalizedHeading = normalizeHeadingName(headingText);
        if (normalizedHeading) {
          const notesWithHeading =
            headingNameNotes.get(normalizedHeading) ?? new Set<string>();
          notesWithHeading.add(noteId);
          headingNameNotes.set(normalizedHeading, notesWithHeading);
        }
      }
    }

    const firstH1 = noteHeadingPaths
      .map((headingPath) => headingPath[0])
      .find((heading): heading is string => typeof heading === "string");
    if (firstH1 && titlesMatch(firstH1, note)) {
      h1MatchesTitleCount += 1;
    }

    const links = parseLinks(note.links_json);
    let noteHasWikiLink = false;
    let noteHasMarkdownLink = false;
    for (const link of links) {
      if (link.kind === "markdown") {
        markdownLinkCount += 1;
        noteHasMarkdownLink = true;
      } else {
        wikiLinkCount += 1;
        noteHasWikiLink = true;
      }
    }
    if (noteHasWikiLink) wikiLinkNoteCount += 1;
    if (noteHasMarkdownLink) markdownLinkNoteCount += 1;

    const attachments = parseStringArray(note.attachment_refs_json);
    const embeddedAttachmentCount = extractAttachmentReferences(body).length;
    const attachmentCount = Math.max(
      attachments.length,
      embeddedAttachmentCount,
    );
    if (attachmentCount > 0) {
      noteCountWithAttachments += 1;
      totalAttachmentReferences += attachmentCount;
      maxAttachmentReferencesInNote = Math.max(
        maxAttachmentReferencesInNote,
        attachmentCount,
      );
    }

    const namingPattern = detectNamingPattern(String(note.path));
    namingPatternCounts.set(
      namingPattern,
      (namingPatternCounts.get(namingPattern) ?? 0) + 1,
    );
  }

  const levelDistribution = Array.from(headingLevelCounts.entries())
    .map(([level, headingCount]) => ({
      level,
      headingCount,
      noteCount: headingLevelNotes.get(level)?.size ?? 0,
    }))
    .sort((a, b) => a.level - b.level);

  const commonHeadingNames = sortCounted(
    Array.from(headingNameNotes.entries()).map(([heading, noteIds]) => ({
      heading,
      noteCount: noteIds.size,
    })),
    "heading",
  ).slice(0, limit);

  const namingPatterns = sortCounted(
    Array.from(namingPatternCounts.entries()).map(([pattern, noteCount]) => ({
      pattern,
      noteCount,
    })),
    "pattern",
  );

  return {
    data: {
      scope: { pathPrefix, noteCount: notes.length, filters, exampleSelection },
      headings: {
        levelDistribution,
        commonHeadingNames,
        h1MatchesTitleCount,
      },
      links: {
        wikiLinkNoteCount,
        markdownLinkNoteCount,
        wikiLinkCount,
        markdownLinkCount,
      },
      attachments: {
        noteCountWithAttachments,
        totalAttachmentReferences,
        maxAttachmentReferencesInNote,
      },
      namingPatterns,
      examples: examplesFromNotes(notes, limit, exampleSelection),
      limit,
      indexFreshness: freshness,
    },
    warnings: [
      ...truncationWarning(
        "PROFILE_COMMON_HEADINGS_TRUNCATED",
        headingNameNotes.size,
        limit,
      ),
      ...warningsForFreshness(freshness),
    ],
  };
}

function assertUsableIndex(ctx: ProfileContext): void {
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

function resolveFreshnessState(ctx: ProfileContext): FreshnessState {
  if (ctx.freshnessMachine) return ctx.freshnessMachine.state;
  const staleness = ctx.store.checkStaleness(ctx.config);
  if (staleness.incompatible) return "incompatible";
  if (staleness.stale) return "stale";
  return "fresh";
}

function warningsForFreshness(state: FreshnessState): WarningItem[] {
  switch (state) {
    case "stale":
      return [
        {
          code: "INDEX_STALE",
          message: "Index may be outdated. Run `vault-agent index` to refresh.",
        },
      ];
    case "pending":
    case "updating":
    case "unknown":
      return [
        { code: `INDEX_${state.toUpperCase()}`, message: `Index is ${state}.` },
      ];
    case "fresh":
    case "incompatible":
      return [];
  }
}

function scopedNotes(
  store: IndexStore,
  filters: ProfileScopeFilters,
): Array<Record<string, unknown>> {
  const notes = store
    .getAllNotes()
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));
  return notes.filter((note) => noteMatchesProfileFilters(note, filters));
}

function normalizeProfileFilters(params: ProfileParams): ProfileScopeFilters {
  const filters: ProfileScopeFilters = {};
  const pathPrefixes = [
    ...(params.pathPrefix ? [params.pathPrefix] : []),
    ...(params.filters?.pathPrefix ?? []),
  ];
  if (pathPrefixes.length > 0) {
    filters.pathPrefix = dedupe(pathPrefixes.map(normalizePathFilter));
  }

  const tags = params.filters?.tags ?? [];
  if (tags.length > 0) {
    filters.tags = dedupe(
      tags.map((tag) => {
        const normalized = tag.trim().replace(/^#/, "");
        if (!normalized) {
          throw new SearchError("INVALID_TAG_FILTER", "Tag filter is empty.");
        }
        return normalized;
      }),
    );
  }

  const noteIds = [
    ...(params.noteIds ?? []),
    ...(params.filters?.noteIds ?? []),
  ];
  if (noteIds.length > 0) {
    filters.noteIds = dedupe(
      noteIds.map((noteId) => {
        if (!/^[0-9a-f]{32}$/.test(noteId)) {
          throw new SearchError("INVALID_ID", "Invalid note ID format.");
        }
        return noteId;
      }),
    );
  }

  if (params.filters?.frontmatter) {
    const frontmatter: NonNullable<ProfileScopeFilters["frontmatter"]> = {};
    if (params.filters.frontmatter.type) {
      frontmatter.type = normalizeFilterValues(params.filters.frontmatter.type);
    }
    if (params.filters.frontmatter.status) {
      frontmatter.status = normalizeFilterValues(
        params.filters.frontmatter.status,
      );
    }
    if (frontmatter.type || frontmatter.status) {
      filters.frontmatter = frontmatter;
    }
  }

  return filters;
}

function pathMatchesPrefix(notePath: string, prefix: string): boolean {
  return notePath === prefix || notePath.startsWith(`${prefix}/`);
}

function noteMatchesProfileFilters(
  note: Record<string, unknown>,
  filters: ProfileScopeFilters,
): boolean {
  const path = String(note.path ?? "");
  if (
    filters.pathPrefix &&
    !filters.pathPrefix.some((prefix) => pathMatchesPrefix(path, prefix))
  ) {
    return false;
  }

  if (filters.noteIds && !filters.noteIds.includes(String(note.note_id))) {
    return false;
  }

  if (filters.tags) {
    const noteTags = new Set(
      parseStringArray(note.tags_json)
        .map((tag) => normalizeTag(tag))
        .filter((tag): tag is string => tag !== null),
    );
    if (!filters.tags.some((tag) => noteTags.has(tag))) return false;
  }

  if (filters.frontmatter) {
    const fields = parseFrontmatterFields(note.frontmatter_fields_json);
    const typeValues = valuesForFilter(fields.type);
    const statusValues = valuesForFilter(fields.status);
    if (
      filters.frontmatter.type &&
      !filters.frontmatter.type.some((value) => typeValues.has(value))
    ) {
      return false;
    }
    if (
      filters.frontmatter.status &&
      !filters.frontmatter.status.some((value) => statusValues.has(value))
    ) {
      return false;
    }
  }

  return true;
}

function normalizeFilterValues(values: string[]): string[] {
  return dedupe(
    values.map((value) => {
      const normalized = value.trim();
      if (!normalized) {
        throw new SearchError(
          "INVALID_FRONTMATTER_FILTER",
          "Frontmatter filter value is empty.",
        );
      }
      return normalized;
    }),
  );
}

function valuesForFilter(value: unknown): Set<string> {
  const values = Array.isArray(value) ? value : [value];
  return new Set(
    values
      .map((item) => normalizeFrontmatterValue(item))
      .filter((item): item is string => item !== null),
  );
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PROFILE_LIMIT;
  return Math.min(Math.max(limit, 1), MAX_PROFILE_LIMIT);
}

function parseStringArray(json: unknown): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(String(json)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function parseFrontmatterFields(json: unknown): Record<string, unknown> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(String(json)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseLinks(json: unknown): WikilinkInfo[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(String(json)) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is WikilinkInfo =>
        Boolean(item) && typeof item === "object" && "target" in item,
    );
  } catch {
    return [];
  }
}

function getChunkHeadingPathsByNote(
  store: IndexStore,
): Map<string, string[][]> {
  const pathsByNote = new Map<string, string[][]>();
  for (const chunkId of store.getAllChunkIds()) {
    const chunk = store.getChunkById(chunkId);
    if (!chunk) continue;
    const noteId = String(chunk.note_id);
    const headingPath = parseStringArray(chunk.heading_path_json);
    if (headingPath.length === 0) continue;
    const paths = pathsByNote.get(noteId) ?? [];
    paths.push(headingPath);
    pathsByNote.set(noteId, paths);
  }
  return pathsByNote;
}

function countFrontmatterFields(
  note: Record<string, unknown>,
  fieldCounts: Map<string, number>,
  valueCounts: Map<string, Map<string, number>>,
  configuredValueAllowlist: Set<string>,
): void {
  if (!note.has_frontmatter) return;

  const fields = parseFrontmatterFields(note.frontmatter_fields_json);
  if (note.frontmatter_title !== null && note.frontmatter_title !== undefined) {
    fields.title = note.frontmatter_title;
  }
  const aliases = parseStringArray(note.aliases_json);
  if (aliases.length > 0) fields.aliases = aliases;
  const tags = parseStringArray(note.tags_json);
  if (tags.length > 0) fields.tags = tags;
  if (note.date_value) fields.date = note.date_value;
  if (note.created_value) fields.created = note.created_value;
  if (note.updated_value) fields.updated = note.updated_value;

  for (const [name, rawValue] of Object.entries(fields)) {
    fieldCounts.set(name, (fieldCounts.get(name) ?? 0) + 1);
    if (!configuredValueAllowlist.has(name)) continue;
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    const seen = new Set<string>();
    for (const value of values) {
      const normalized = normalizeFrontmatterValue(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      const counts = valueCounts.get(name) ?? new Map<string, number>();
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
      valueCounts.set(name, counts);
    }
  }
}

function configuredProfileValueAllowlist(config: Config): Set<string> {
  return new Set([
    ...valueAllowlist,
    ...config.profiles.frontmatter_value_allowlist
      .map((field) => field.trim())
      .filter((field) => field.length > 0),
  ]);
}

function normalizeFrontmatterValue(value: unknown): string | null {
  if (typeof value === "string") return value.length > 0 ? value : null;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function normalizeTag(value: string): string | null {
  const normalized = value.startsWith("#") ? value.slice(1) : value;
  return normalized.length > 0 ? normalized : null;
}

function normalizeHeadingName(value: string): string | null {
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function titlesMatch(h1: string, note: Record<string, unknown>): boolean {
  const normalizedH1 = comparableTitle(h1);
  const title = typeof note.title === "string" ? note.title : null;
  if (title && comparableTitle(title) === normalizedH1) return true;

  const fileName = String(note.path).split("/").pop() ?? String(note.path);
  const stem = fileName.replace(/\.(md|markdown)$/i, "");
  return comparableTitle(stem) === normalizedH1;
}

function comparableTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function detectNamingPattern(path: string): string {
  const fileName = path.split("/").pop() ?? path;
  const stem = fileName.replace(/\.(md|markdown)$/i, "");
  if (/^\d{4}-\d{2}-\d{2}(?:\b|[-_ ])/.test(stem)) return "date-prefix";
  if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(stem)) return "kebab-case";
  if (/^[a-z0-9]+(?:_[a-z0-9]+)+$/.test(stem)) return "snake_case";
  if (/^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+$/.test(stem)) return "PascalCase";
  if (/^[A-Z0-9 _-]+$/.test(stem) && /[A-Z]/.test(stem)) return "uppercase";
  if (stem.includes(" ")) return "space-separated";
  return "other";
}

function examplesFromNotes(
  notes: Array<Record<string, unknown>>,
  limit: number,
  selection: ProfileExampleSelection,
): ProfileExample[] {
  const ranked =
    selection === "representative" ? rankRepresentativeExamples(notes) : notes;
  return ranked.slice(0, limit).map((note) => ({
    noteId: String(note.note_id),
    path: String(note.path),
    title: typeof note.title === "string" ? note.title : null,
  }));
}

function rankRepresentativeExamples(
  notes: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  return [...notes].sort((a, b) => {
    const scoreDelta = representativeScore(b) - representativeScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    return String(a.path).localeCompare(String(b.path));
  });
}

function representativeScore(note: Record<string, unknown>): number {
  const frontmatterFields = Object.keys(
    parseFrontmatterFields(note.frontmatter_fields_json),
  ).length;
  const tagCount = parseStringArray(note.tags_json).length;
  const linkCount = parseLinks(note.links_json).length;
  const attachmentCount = parseStringArray(note.attachment_refs_json).length;
  return frontmatterFields + tagCount + linkCount + attachmentCount;
}

function sortCounted<T extends { noteCount: number }>(
  items: T[],
  nameKey: keyof T,
): T[] {
  return items.sort((a, b) => {
    if (b.noteCount !== a.noteCount) return b.noteCount - a.noteCount;
    return String(a[nameKey] ?? "").localeCompare(String(b[nameKey] ?? ""));
  });
}

function truncationWarning(
  code: string,
  count: number,
  limit: number,
): WarningItem[] {
  if (count <= limit) return [];
  return [
    {
      code,
      message: `Profile list was truncated to ${limit} entries.`,
    },
  ];
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

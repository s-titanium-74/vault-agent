import type {
  AggregateIndexView,
  IndexCompatibility,
} from "./portable/contracts.js";
import { SearchError } from "./errors.js";
import {
  DEFAULT_OVERVIEW_TOP_FOLDERS_LIMIT,
  DEFAULT_OVERVIEW_TOP_TAGS_LIMIT,
  DEFAULT_OVERVIEW_FRONTMATTER_FIELDS_LIMIT,
  DEFAULT_TREE_DEPTH,
  DEFAULT_TREE_LIMIT,
  DEFAULT_TAGS_LIMIT,
  DEFAULT_FACETS_LIMIT,
  FACET_VALUE_ALLOWLIST,
  FacetField,
  FolderNode,
  FrontmatterFieldEntry,
  OverviewResult,
  TagEntry,
  TopLevelFolderEntry,
  TreeResult,
  TagsResult,
  FacetsResult,
  OrientationParams,
  WarningItem,
} from "./schemas.js";
import { FreshnessMachine, type FreshnessState } from "./freshness.js";

const facetValueAllowlistSet = new Set<string>(FACET_VALUE_ALLOWLIST);

export interface OrientationContext {
  store: AggregateIndexView;
  compatibility: IndexCompatibility;
  config: { profiles: { frontmatter_value_allowlist: string[] } };
  freshnessMachine?: FreshnessMachine | null;
}

export interface OrientationOutput<T> {
  data: T;
  warnings: WarningItem[];
}

function resolveFreshnessState(ctx: OrientationContext): FreshnessState {
  if (ctx.freshnessMachine) {
    return ctx.freshnessMachine.state;
  }
  const staleness = ctx.compatibility;
  if (staleness.incompatible) return "incompatible";
  if (staleness.stale) return "stale";
  return "fresh";
}

function assertUsableIndex(ctx: OrientationContext): void {
  const manifest = ctx.store.getManifest();
  if (!manifest) {
    throw new SearchError(
      "INDEX_NOT_FOUND",
      "No usable index found. Run `vault-agent index` or `vault-agent reindex`.",
    );
  }

  const staleness = ctx.compatibility;
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

function normalizeTag(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.startsWith("#") ? value.slice(1) : value;
}

function normalizeFacetValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    return value.length === 0 ? null : value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function parseTagsJson(tagsJson: unknown): string[] {
  if (!tagsJson) return [];
  try {
    const parsed = JSON.parse(tagsJson as string) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map(normalizeTag)
      .filter((t): t is string => t !== null && t.length > 0);
  } catch {
    return [];
  }
}

function parseFrontmatterFieldsJson(
  fieldsJson: unknown,
): Record<string, unknown> {
  if (!fieldsJson) return {};
  try {
    const parsed = JSON.parse(fieldsJson as string) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseAliasesJson(aliasesJson: unknown): string[] {
  if (!aliasesJson) return [];
  try {
    const parsed = JSON.parse(aliasesJson as string) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

interface FieldCounts {
  fieldCounts: Map<string, number>;
  valueCounts: Map<string, Map<string, number>>;
}

function countFrontmatterFields(
  note: Record<string, unknown>,
  counts: FieldCounts,
): void {
  if (!note.has_frontmatter) return;

  const extraFields = parseFrontmatterFieldsJson(note.frontmatter_fields_json);
  for (const [name, rawValue] of Object.entries(extraFields)) {
    incrementFieldCount(name, rawValue, counts);
  }

  if (note.frontmatter_title !== null && note.frontmatter_title !== undefined) {
    incrementFieldCount("title", note.frontmatter_title, counts);
  }

  const aliases = parseAliasesJson(note.aliases_json);
  if (aliases.length > 0) {
    incrementFieldCount("aliases", aliases, counts);
  }

  const tags = parseTagsJson(note.tags_json);
  if (tags.length > 0) {
    incrementFieldCount("tags", tags, counts);
  }

  if (note.date_value) {
    incrementFieldCount("date", note.date_value, counts);
  }
  if (note.created_value) {
    incrementFieldCount("created", note.created_value, counts);
  }
  if (note.updated_value) {
    incrementFieldCount("updated", note.updated_value, counts);
  }
}

function incrementFieldCount(
  name: string,
  rawValue: unknown,
  counts: FieldCounts,
): void {
  counts.fieldCounts.set(name, (counts.fieldCounts.get(name) ?? 0) + 1);

  if (!facetValueAllowlistSet.has(name)) return;

  let values: unknown[];
  if (Array.isArray(rawValue)) {
    values = rawValue;
  } else {
    values = [rawValue];
  }

  const seenValues = new Set<string>();
  for (const v of values) {
    const normalized = normalizeFacetValue(v);
    if (normalized === null) continue;
    if (seenValues.has(normalized)) continue;
    seenValues.add(normalized);

    const fieldMap = counts.valueCounts.get(name) ?? new Map<string, number>();
    fieldMap.set(normalized, (fieldMap.get(normalized) ?? 0) + 1);
    counts.valueCounts.set(name, fieldMap);
  }
}

function sortByCountThenName<T extends { noteCount: number }>(
  items: T[],
  nameKey: keyof T,
): T[] {
  return items.sort((a, b) => {
    if (b.noteCount !== a.noteCount) {
      return b.noteCount - a.noteCount;
    }
    const aName = String(a[nameKey] ?? "");
    const bName = String(b[nameKey] ?? "");
    return aName.localeCompare(bName);
  });
}

export function getOverview(
  ctx: OrientationContext,
): OrientationOutput<OverviewResult> {
  assertUsableIndex(ctx);

  const notes = ctx.store.getAllNotes();
  const manifest = ctx.store.getManifest();
  const noteCount = notes.length;
  const chunkCount = manifest?.chunkCount ?? ctx.store.getAllChunkIds().length;

  const folderCounts = new Map<string, number>();
  const tagCounts = new Map<string, number>();
  const fieldCounts = new Map<string, number>();

  for (const note of notes) {
    const path = note.path as string;

    const firstSlash = path.indexOf("/");
    if (firstSlash > 0) {
      const topFolder = path.slice(0, firstSlash);
      folderCounts.set(topFolder, (folderCounts.get(topFolder) ?? 0) + 1);
    }

    const tags = parseTagsJson(note.tags_json);
    const seenTags = new Set<string>();
    for (const tag of tags) {
      if (!seenTags.has(tag)) {
        seenTags.add(tag);
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }

    countFrontmatterFields(note, { fieldCounts, valueCounts: new Map() });
  }

  const topLevelFolders: TopLevelFolderEntry[] = sortByCountThenName(
    Array.from(folderCounts.entries()).map(([path, noteCount]) => ({
      path,
      noteCount,
    })),
    "path",
  ).slice(0, DEFAULT_OVERVIEW_TOP_FOLDERS_LIMIT);

  const topTags: TagEntry[] = sortByCountThenName(
    Array.from(tagCounts.entries()).map(([tag, noteCount]) => ({
      tag,
      noteCount,
    })),
    "tag",
  ).slice(0, DEFAULT_OVERVIEW_TOP_TAGS_LIMIT);

  const frontmatterFields: FrontmatterFieldEntry[] = sortByCountThenName(
    Array.from(fieldCounts.entries()).map(([name, noteCount]) => ({
      name,
      noteCount,
    })),
    "name",
  ).slice(0, DEFAULT_OVERVIEW_FRONTMATTER_FIELDS_LIMIT);

  const warnings: WarningItem[] = [];
  if (topLevelFolders.length < folderCounts.size) {
    warnings.push({
      code: "TOP_LEVEL_FOLDERS_TRUNCATED",
      message: `Top-level folders list was truncated to ${DEFAULT_OVERVIEW_TOP_FOLDERS_LIMIT} entries.`,
    });
  }
  if (topTags.length < tagCounts.size) {
    warnings.push({
      code: "TOP_TAGS_TRUNCATED",
      message: `Top tags list was truncated to ${DEFAULT_OVERVIEW_TOP_TAGS_LIMIT} entries.`,
    });
  }
  if (frontmatterFields.length < fieldCounts.size) {
    warnings.push({
      code: "FRONTMATTER_FIELDS_TRUNCATED",
      message: `Frontmatter fields list was truncated to ${DEFAULT_OVERVIEW_FRONTMATTER_FIELDS_LIMIT} entries.`,
    });
  }

  const freshness = resolveFreshnessState(ctx);
  const fw = freshnessWarning(freshness);
  if (fw) warnings.push(fw);

  return {
    data: {
      noteCount,
      chunkCount,
      topLevelFolders,
      topTags,
      frontmatterFields,
      indexFreshness: freshness,
    },
    warnings,
  };
}

export function getTree(
  ctx: OrientationContext,
  params: OrientationParams,
): OrientationOutput<TreeResult> {
  assertUsableIndex(ctx);

  const depth = params.depth ?? DEFAULT_TREE_DEPTH;
  const limit = params.limit ?? DEFAULT_TREE_LIMIT;
  const directOnly = params.directOnly ?? false;

  const notes = ctx.store.getAllNotes();
  const paths = notes.map((n) => n.path as string).sort();

  const allFolders = new Set<string>();
  for (const p of paths) {
    let slash = p.indexOf("/");
    while (slash > 0) {
      allFolders.add(p.slice(0, slash));
      slash = p.indexOf("/", slash + 1);
    }
  }

  const directNoteCounts = new Map<string, number>();
  for (const p of paths) {
    const folder = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    directNoteCounts.set(folder, (directNoteCounts.get(folder) ?? 0) + 1);
  }

  function recursiveCount(folder: string): number {
    let count = directNoteCounts.get(folder) ?? 0;
    if (folder === "") {
      for (const f of allFolders) {
        count += directNoteCounts.get(f) ?? 0;
      }
    } else {
      for (const f of allFolders) {
        if (f.startsWith(folder + "/")) {
          count += directNoteCounts.get(f) ?? 0;
        }
      }
    }
    return count;
  }

  function buildNode(folder: string): FolderNode {
    const childFolders: string[] = [];
    for (const f of allFolders) {
      if (folder === "") {
        if (!f.includes("/")) {
          childFolders.push(f);
        }
      } else if (f.startsWith(folder + "/")) {
        const remaining = f.slice(folder.length + 1);
        if (!remaining.includes("/")) {
          childFolders.push(f);
        }
      }
    }
    childFolders.sort();

    return {
      path: folder,
      noteCount: directOnly
        ? (directNoteCounts.get(folder) ?? 0)
        : recursiveCount(folder),
      childFolders: childFolders.length,
      children: [],
    };
  }

  const warnings: WarningItem[] = [];

  const root = buildNode("");
  const queue: { node: FolderNode; depth: number }[] = [
    { node: root, depth: 1 },
  ];
  let nodesCount = 1;
  let truncated = false;

  while (queue.length > 0) {
    const { node, depth: nodeDepth } = queue.shift()!;
    if (nodeDepth >= depth) {
      continue;
    }

    const childFolders: string[] = [];
    if (node.path === "") {
      for (const f of allFolders) {
        if (!f.includes("/")) childFolders.push(f);
      }
    } else {
      for (const f of allFolders) {
        if (f.startsWith(node.path + "/")) {
          const remaining = f.slice(node.path.length + 1);
          if (!remaining.includes("/")) childFolders.push(f);
        }
      }
    }
    childFolders.sort();

    for (const childFolder of childFolders) {
      if (nodesCount >= limit) {
        truncated = true;
        break;
      }
      const childNode = buildNode(childFolder);
      node.children.push(childNode);
      nodesCount++;
      queue.push({ node: childNode, depth: nodeDepth + 1 });
    }
  }

  if (truncated) {
    warnings.push({
      code: "TREE_LIMIT_EXCEEDED",
      message: `Tree output was truncated to ${limit} nodes.`,
    });
  }

  const freshness = resolveFreshnessState(ctx);
  const fw = freshnessWarning(freshness);
  if (fw) warnings.push(fw);

  return {
    data: {
      tree: root,
      indexFreshness: freshness,
    },
    warnings,
  };
}

export function getTags(
  ctx: OrientationContext,
  params: OrientationParams,
): OrientationOutput<TagsResult> {
  assertUsableIndex(ctx);

  const limit = params.limit ?? DEFAULT_TAGS_LIMIT;
  const notes = ctx.store.getAllNotes();

  const tagCounts = new Map<string, number>();
  for (const note of notes) {
    const tags = parseTagsJson(note.tags_json);
    const seenTags = new Set<string>();
    for (const tag of tags) {
      if (!seenTags.has(tag)) {
        seenTags.add(tag);
        tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
      }
    }
  }

  const tags: TagEntry[] = sortByCountThenName(
    Array.from(tagCounts.entries()).map(([tag, noteCount]) => ({
      tag,
      noteCount,
    })),
    "tag",
  ).slice(0, limit);

  const freshness = resolveFreshnessState(ctx);
  const warnings: WarningItem[] = [];
  const fw = freshnessWarning(freshness);
  if (fw) warnings.push(fw);

  return {
    data: {
      tags,
      indexFreshness: freshness,
    },
    warnings,
  };
}

export function getFacets(
  ctx: OrientationContext,
  params: OrientationParams,
): OrientationOutput<FacetsResult> {
  assertUsableIndex(ctx);

  const limit = params.limit ?? DEFAULT_FACETS_LIMIT;
  const notes = ctx.store.getAllNotes();

  const fieldCounts = new Map<string, number>();
  const valueCounts = new Map<string, Map<string, number>>();

  for (const note of notes) {
    countFrontmatterFields(note, { fieldCounts, valueCounts });
  }

  const fields: FacetField[] = sortByCountThenName(
    Array.from(fieldCounts.entries()).map(([name, noteCount]) => {
      const field: FacetField = { name, noteCount };
      if (facetValueAllowlistSet.has(name)) {
        const values = valueCounts.get(name);
        if (values) {
          field.values = sortByCountThenName(
            Array.from(values.entries()).map(([value, noteCount]) => ({
              value,
              noteCount,
            })),
            "value",
          );
        }
      }
      return field;
    }),
    "name",
  ).slice(0, limit);

  const freshness = resolveFreshnessState(ctx);
  const warnings: WarningItem[] = [];
  const fw = freshnessWarning(freshness);
  if (fw) warnings.push(fw);

  return {
    data: {
      fields,
      indexFreshness: freshness,
    },
    warnings,
  };
}

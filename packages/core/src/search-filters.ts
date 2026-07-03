import { SearchError } from "./errors.js";
import { SearchFiltersInput, SearchResultItem } from "./schemas.js";

export interface NormalizedSearchFilters {
  pathPrefix?: string[];
  excludePathPrefix?: string[];
  tags?: string[];
  excludeTags?: string[];
  frontmatter?: {
    type?: string[];
    status?: string[];
  };
}

export function normalizeSearchFilters(
  filters?: SearchFiltersInput,
): NormalizedSearchFilters | undefined {
  if (!filters) return undefined;

  const normalized: NormalizedSearchFilters = {};

  if (filters.pathPrefix) {
    normalized.pathPrefix = normalizePathFilters(filters.pathPrefix);
  }
  if (filters.excludePathPrefix) {
    normalized.excludePathPrefix = normalizePathFilters(
      filters.excludePathPrefix,
    );
  }
  if (filters.tags) {
    normalized.tags = normalizeTagFilters(filters.tags);
  }
  if (filters.excludeTags) {
    normalized.excludeTags = normalizeTagFilters(filters.excludeTags);
  }
  if (filters.frontmatter) {
    const frontmatter: NonNullable<NormalizedSearchFilters["frontmatter"]> = {};
    if (filters.frontmatter.type) {
      frontmatter.type = normalizeFrontmatterValues(filters.frontmatter.type);
    }
    if (filters.frontmatter.status) {
      frontmatter.status = normalizeFrontmatterValues(
        filters.frontmatter.status,
      );
    }
    if (!frontmatter.type && !frontmatter.status) {
      throw new SearchError(
        "INVALID_FRONTMATTER_FILTER",
        "Frontmatter filters support type and status.",
      );
    }
    normalized.frontmatter = frontmatter;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

export function matchesSearchFilters(
  item: SearchResultItem,
  noteRow: Record<string, unknown> | null,
  filters?: NormalizedSearchFilters,
): boolean {
  if (!filters) return true;
  return metadataMatchesFilters(
    item.path,
    item.metadata.tags,
    noteRow,
    filters,
  );
}

export function noteMatchesSearchFilters(
  noteRow: Record<string, unknown> | null,
  filters?: NormalizedSearchFilters,
): boolean {
  if (!filters) return true;
  if (!noteRow) return false;
  return metadataMatchesFilters(
    String(noteRow.path ?? ""),
    tagsFromNoteRow(noteRow),
    noteRow,
    filters,
  );
}

function metadataMatchesFilters(
  path: string,
  tags: string[],
  noteRow: Record<string, unknown> | null,
  filters: NormalizedSearchFilters,
): boolean {
  if (
    filters.pathPrefix &&
    !filters.pathPrefix.some((prefix) => pathMatchesPrefix(path, prefix))
  ) {
    return false;
  }

  const noteTags = new Set(tags);
  if (filters.tags && !filters.tags.some((tag) => noteTags.has(tag))) {
    return false;
  }

  if (filters.frontmatter) {
    const values = frontmatterValuesFromNote(noteRow);
    if (
      filters.frontmatter.type &&
      !filters.frontmatter.type.some((value) => values.type.has(value))
    ) {
      return false;
    }
    if (
      filters.frontmatter.status &&
      !filters.frontmatter.status.some((value) => values.status.has(value))
    ) {
      return false;
    }
  }

  if (
    filters.excludePathPrefix &&
    filters.excludePathPrefix.some((prefix) => pathMatchesPrefix(path, prefix))
  ) {
    return false;
  }

  if (
    filters.excludeTags &&
    filters.excludeTags.some((tag) => noteTags.has(tag))
  ) {
    return false;
  }

  return true;
}

function normalizePathFilters(values: string[]): string[] {
  return dedupe(values.map(normalizePathFilter));
}

function normalizePathFilter(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new SearchError("INVALID_PATH_FILTER", "Path filter is empty.");
  }

  let decoded = trimmed;
  try {
    decoded = decodeURIComponent(trimmed);
  } catch {
    // Keep the original string; normal segment validation still applies.
  }

  const normalized = decoded
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/+$/g, "");

  if (!normalized) {
    throw new SearchError("INVALID_PATH_FILTER", "Path filter is empty.");
  }
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(normalized)) {
    throw new SearchError(
      "INVALID_PATH_FILTER",
      "Path filters must be vault-relative prefixes.",
    );
  }
  if (normalized.startsWith("/")) {
    throw new SearchError(
      "INVALID_PATH_FILTER",
      "Path filters must be vault-relative prefixes.",
    );
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new SearchError(
      "INVALID_PATH_FILTER",
      "Path filters must not contain traversal segments.",
    );
  }

  return normalized;
}

function normalizeTagFilters(values: string[]): string[] {
  return dedupe(
    values.map((value) => {
      const trimmed = value.trim();
      const normalized = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
      if (!normalized) {
        throw new SearchError("INVALID_TAG_FILTER", "Tag filter is empty.");
      }
      return normalized;
    }),
  );
}

function normalizeFrontmatterValues(values: string[]): string[] {
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

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

function pathMatchesPrefix(notePath: string, prefix: string): boolean {
  return notePath === prefix || notePath.startsWith(`${prefix}/`);
}

function frontmatterValuesFromNote(noteRow: Record<string, unknown> | null): {
  type: Set<string>;
  status: Set<string>;
} {
  const fields = parseFrontmatterFields(noteRow);
  return {
    type: new Set(normalizeIndexedFrontmatterValue(fields.type)),
    status: new Set(normalizeIndexedFrontmatterValue(fields.status)),
  };
}

function parseFrontmatterFields(
  noteRow: Record<string, unknown> | null,
): Record<string, unknown> {
  const raw = noteRow?.frontmatter_fields_json;
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

function tagsFromNoteRow(noteRow: Record<string, unknown>): string[] {
  const raw = noteRow.tags_json;
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function normalizeIndexedFrontmatterValue(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap(normalizeIndexedFrontmatterValue);
  }
  if (value === null || value === undefined) return [];
  const normalized = String(value);
  return normalized.length > 0 ? [normalized] : [];
}

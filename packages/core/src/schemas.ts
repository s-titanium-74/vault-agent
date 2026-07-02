import { z } from "zod";
import type { FreshnessState } from "./freshness.js";

export const searchModeSchema = z.enum(["lexical", "embedding", "hybrid"]);
export type SearchMode = z.infer<typeof searchModeSchema>;

export const searchRequestSchema = z.object({
  query: z
    .string()
    .min(1)
    .max(1000)
    .refine((val) => val.trim().length > 0, {
      message: "Query must not be empty or whitespace-only",
    }),
  mode: searchModeSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const relatedRequestSchema = z.object({
  type: z.enum(["note", "chunk"]),
  id: z.string().min(1),
  mode: searchModeSchema.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const noteRetrieveQuerySchema = z.object({
  noteId: z.string().regex(/^[0-9a-f]{32}$/),
  allowLarge: z.boolean().optional(),
});

export const chunkRetrieveQuerySchema = z.object({
  noteId: z.string().regex(/^[0-9a-f]{32}$/),
  chunkIndex: z.number().int().min(0),
  allowLarge: z.boolean().optional(),
});

export const attachmentRetrieveQuerySchema = z.object({
  vaultRelativePath: z.string().min(1),
  download: z.boolean().optional(),
  allowLarge: z.boolean().optional(),
});

export const resultMetadataSchema = z.object({
  aliases: z.array(z.string()),
  tags: z.array(z.string()),
  date: z.string().nullable(),
  created: z.string().nullable(),
  updated: z.string().nullable(),
  attachmentCount: z.number().int().min(0),
});

export interface SearchResultItem {
  id: string;
  type: "note" | "chunk";
  noteId: string;
  chunkIndex: number | null;
  path: string;
  title: string | null;
  heading: string | null;
  headingPath: string[];
  snippet: string;
  score: number;
  reason: string;
  metadata: z.infer<typeof resultMetadataSchema>;
}

export interface SearchResult {
  requestedMode: SearchMode;
  usedMode: SearchMode;
  limit: number;
  results: SearchResultItem[];
  warnings: WarningItem[];
}

export interface RelatedResult {
  input: {
    type: "note" | "chunk";
    id: string;
  };
  requestedMode: SearchMode;
  usedMode: SearchMode;
  limit: number;
  results: SearchResultItem[];
  warnings: WarningItem[];
}

export interface NoteRetrieveResult {
  id: string;
  path: string;
  title: string | null;
  metadata: z.infer<typeof resultMetadataSchema>;
  content: string;
  contentType: string;
  size: number;
  links?: {
    resolved: string[];
    unresolved: string[];
  };
  attachments?: string[];
}

export interface ChunkRetrieveResult {
  id: string;
  noteId: string;
  chunkIndex: number;
  path: string;
  title: string | null;
  heading: string | null;
  headingPath: string[];
  metadata: z.infer<typeof resultMetadataSchema>;
  content: string;
  contentType: string;
  size: number;
}

export interface AttachmentMetadataResult {
  path: string;
  fileName: string;
  contentType: string;
  size: number;
  downloadAvailable: boolean;
}

export interface WarningItem {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface TopLevelFolderEntry {
  path: string;
  noteCount: number;
}

export interface TagEntry {
  tag: string;
  noteCount: number;
}

export interface FrontmatterFieldEntry {
  name: string;
  noteCount: number;
}

export interface FacetFieldValue {
  value: string;
  noteCount: number;
}

export interface FacetField {
  name: string;
  noteCount: number;
  values?: FacetFieldValue[];
}

export interface FolderNode {
  path: string;
  noteCount: number;
  childFolders: number;
  children: FolderNode[];
}

export interface OverviewResult {
  noteCount: number;
  chunkCount: number;
  topLevelFolders: TopLevelFolderEntry[];
  topTags: TagEntry[];
  frontmatterFields: FrontmatterFieldEntry[];
  indexFreshness: FreshnessState;
}

export interface TreeResult {
  tree: FolderNode;
  indexFreshness: FreshnessState;
}

export interface TagsResult {
  tags: TagEntry[];
  indexFreshness: FreshnessState;
}

export interface FacetsResult {
  fields: FacetField[];
  indexFreshness: FreshnessState;
}

export interface OrientationParams {
  depth?: number;
  limit?: number;
  directOnly?: boolean;
}

export const DEFAULT_RESULT_LIMIT = 10;
export const MAX_RESULT_LIMIT = 50;
export const MAX_SNIPPET_LENGTH = 240;
export const MAX_QUERY_LENGTH = 1000;
export const DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT = 200 * 1024;
export const DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT = 10 * 1024 * 1024;
export const TARGET_CHUNK_SIZE = 2000;
export const MAX_CHUNK_SIZE = 4000;
export const CHUNK_EMBEDDING_INPUT_CAP = 8000;
export const EMBEDDING_BATCH_SIZE = 32;
export const EMBEDDING_REQUEST_TIMEOUT_MS = 120_000;
export const MAX_MARKDOWN_SIZE_FOR_INDEXING = 2 * 1024 * 1024;
export const INDEX_SCHEMA_VERSION = 3;
export const MAX_WARNING_COUNT = 100;

export const DEFAULT_OVERVIEW_TOP_FOLDERS_LIMIT = 20;
export const DEFAULT_OVERVIEW_TOP_TAGS_LIMIT = 50;
export const DEFAULT_OVERVIEW_FRONTMATTER_FIELDS_LIMIT = 50;
export const DEFAULT_TREE_DEPTH = 2;
export const DEFAULT_TREE_LIMIT = 50;
export const MAX_TREE_DEPTH = 10;
export const MAX_TREE_LIMIT = 500;
export const DEFAULT_TAGS_LIMIT = 50;
export const MAX_TAGS_LIMIT = 200;
export const DEFAULT_FACETS_LIMIT = 50;
export const MAX_FACETS_LIMIT = 200;

export const FACET_VALUE_ALLOWLIST = ["type", "status"] as const;
export type FacetValueAllowlist = (typeof FACET_VALUE_ALLOWLIST)[number];

export const overviewQuerySchema = z.object({});

export const treeQuerySchema = z.object({
  depth: z.coerce.number().int().min(1).max(MAX_TREE_DEPTH).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_TREE_LIMIT).optional(),
  directOnly: z
    .union([z.enum(["true", "false"]), z.literal("")])
    .optional()
    .transform((val) => {
      if (val === undefined) return false;
      if (val === "") return true;
      return val === "true";
    }),
});

export const tagsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_TAGS_LIMIT).optional(),
});

export const facetsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(MAX_FACETS_LIMIT).optional(),
});

export const INDEXED_EXTENSIONS = [".md", ".markdown"];

export const DEFAULT_EXCLUDE_PATTERNS = [
  ".obsidian/",
  ".git/",
  "node_modules/",
  ".DS_Store",
  "Thumbs.db",
  "__pycache__/",
  ".cache/",
  ".tmp/",
  "dist/",
  "build/",
  ".next/",
  ".nuxt/",
  "target/",
  "out/",
];

export interface Note {
  noteId: string;
  vaultRelativePath: string;
  title: string | null;
  filePath: string;
  frontmatter: Frontmatter | null;
  frontmatterDegraded: boolean;
  size: number;
  contentHash: string;
  mtimeMs: number;
  chunks: Chunk[];
  links: WikilinkInfo[];
  attachmentReferences: string[];
}

export interface Frontmatter {
  title?: string;
  aliases?: string[];
  tags?: string[];
  date?: string;
  created?: string;
  updated?: string;
  [key: string]: unknown;
}

export interface Chunk {
  noteId: string;
  chunkIndex: number;
  vaultRelativePath: string;
  title: string | null;
  heading: string | null;
  headingPath: string[];
  content: string;
  contentHash: string;
  charStart: number;
  charEnd: number;
}

export interface WikilinkInfo {
  target: string;
  heading: string | null;
  display: string | null;
  resolved: string | null;
}

export interface IndexManifest {
  schemaVersion: number;
  vaultIdentity: string;
  indexedFileExtensions: string[];
  effectiveExcludePatterns: string[];
  targetChunkSize: number;
  maxChunkSize: number;
  embeddingModel: string | null;
  embeddingDimension: number | null;
  noteCount: number;
  chunkCount: number;
  indexedAt: number;
}

export interface IndexResult {
  mode: "incremental" | "full";
  notesIndexed: number;
  chunksIndexed: number;
  notesSkipped: number;
  warnings: IndexWarning[];
}

export interface IndexWarning {
  code: string;
  message: string;
  path?: string;
  size?: number;
}

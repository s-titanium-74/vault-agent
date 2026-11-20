export class ConfigError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

export class IndexError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "IndexError";
  }
}

export class SearchError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "SearchError";
  }
}

export class RetrievalError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RetrievalError";
  }
}

export class RetrievalSizeError extends Error {
  constructor(
    public code: string,
    message: string,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RetrievalSizeError";
  }
}

const publicIndexCodes = new Set([
  "EMBEDDING_TIMEOUT",
  "EMBEDDING_INPUT_TOO_LARGE",
  "EMBEDDING_FAILED",
  "EMBEDDING_UNAVAILABLE",
  "EMBEDDING_CONFIG_INVALID",
  "EMBEDDING_NO_MODEL",
  "INDEX_EMBEDDING_DIMENSION_MISMATCH",
  "INDEX_BUSY",
  "INDEX_WRITER_BUSY",
  "INDEX_UPDATE_FAILED",
  "INDEX_INCOMPATIBLE",
  "INDEX_REINDEX_REQUIRED",
  "INDEX_SCHEMA_INCOMPATIBLE",
  "INDEX_VAULT_IDENTITY_CHANGED",
  "INDEX_EXCLUDES_CHANGED",
  "INDEX_CHUNKING_CHANGED",
  "INDEX_EMBEDDINGS_STALE",
  "INDEX_ID_COLLISION",
  "SOURCE_UNAVAILABLE",
  "SOURCE_NOT_UTF8",
  "SOURCE_REVISION_MISMATCH",
  "REVISION_CHANGED",
]);
/** Return only a known code, never provider messages or arbitrary error fields. */
export function publicIndexErrorCode(
  error: unknown,
  fallback = "INDEX_UPDATE_FAILED",
): string {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  return typeof code === "string" && publicIndexCodes.has(code)
    ? code
    : fallback;
}

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

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly code:
      "EMBEDDING_FAILED" | "EMBEDDING_TIMEOUT" = "EMBEDDING_FAILED",
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

import {
  EmbeddingProviderError,
  type EmbeddingDescriptor,
  type EmbeddingProviderContract,
} from "@vault-agent/core/portable";

export const MODEL = "@cf/baai/bge-m3";
export const DIMENSION = 1024;
export function descriptor(revision: string): EmbeddingDescriptor {
  return {
    provider: "workers-ai",
    model: MODEL,
    modelRevision: revision,
    metric: "cosine",
    normalization: "unit",
    maxInputTokens: 8192,
    dimension: DIMENSION,
    inputFormat: "vault-agent-bge-m3-v1",
    maxBatchSize: 16,
    maxInputCharacters: 8000,
  };
}
export function usage() {
  return {
    attempts: 0,
    retries: 0,
    embeddingInputs: 0,
    embeddingBytes: 0,
    vectorQueries: 0,
    vectorCandidates: 0,
    vectorWrites: 0,
    vectorDeletes: 0,
  };
}
export type Usage = ReturnType<typeof usage>;
const unavailable = () =>
  new EmbeddingProviderError("Cloud embeddings are unavailable.");
export class ProviderOperations {
  constructor(readonly counts: Usage = usage()) {}
  async run<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const deadline = Date.now() + 10000;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw unavailable();
      let timer: ReturnType<typeof setTimeout> | undefined;
      this.counts.attempts++;
      try {
        return await Promise.race([
          operation(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(unavailable()), remaining);
          }),
        ]);
      } catch (error) {
        const e = error as {
          status?: number;
          statusCode?: number;
          retryAfter?: number;
          headers?: Headers;
        };
        const status = e?.status ?? e?.statusCode;
        const transient =
          status === 429 ||
          (typeof status === "number" && status >= 500 && status <= 599);
        if (!transient || attempt === 2) throw unavailable();
        const header = e.headers?.get("Retry-After");
        const seconds = header
          ? /^\d+(\.\d+)?$/.test(header)
            ? Number(header)
            : (Date.parse(header) - Date.now()) / 1000
          : e.retryAfter;
        const delay =
          seconds === undefined ? 100 * 2 ** attempt : seconds * 1000;
        if (
          !Number.isFinite(delay) ||
          delay < 0 ||
          delay >= deadline - Date.now()
        )
          throw unavailable();
        this.counts.retries++;
        await new Promise((resolve) => setTimeout(resolve, delay));
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
    throw unavailable();
  }
}
export function validVector(values: ArrayLike<number>): boolean {
  return (
    values.length === DIMENSION &&
    Array.from(values).every(Number.isFinite) &&
    Array.from(values).some((v) => v !== 0)
  );
}
function denseVector(values: unknown): values is number[] {
  return Array.isArray(values) && validVector(values);
}
export class WorkersAIEmbeddingProvider implements EmbeddingProviderContract {
  constructor(
    readonly ai: Pick<Ai, "run">,
    readonly revision: string,
    readonly operations = new ProviderOperations(),
  ) {}
  describe() {
    return descriptor(this.revision);
  }
  async embed(texts: string[], options?: { signal?: AbortSignal }) {
    const sizes = texts.map((text) => new TextEncoder().encode(text).length);
    if (
      !texts.length ||
      texts.length > 16 ||
      sizes.some((size) => size === 0 || size > 8000) ||
      sizes.reduce((sum, size) => sum + size, 0) > 32000
    )
      throw unavailable();
    this.operations.counts.embeddingInputs += texts.length;
    this.operations.counts.embeddingBytes += sizes.reduce((a, b) => a + b, 0);
    const output: unknown = await this.operations.run(
      () => this.ai.run(MODEL, { text: texts, truncate_inputs: false }),
      options?.signal,
    );
    options?.signal?.throwIfAborted();
    if (
      !output ||
      typeof output !== "object" ||
      !("data" in output) ||
      !Array.isArray(output.data) ||
      output.data.length !== texts.length ||
      !output.data.every(denseVector)
    )
      throw unavailable();
    const embeddings = output.data.map((values) => {
      const norm = Math.hypot(...values);
      if (!Number.isFinite(norm) || norm === 0) throw unavailable();
      return Float32Array.from(values, (value) => value / norm);
    });
    return { embeddings, model: MODEL, dimension: DIMENSION };
  }
}

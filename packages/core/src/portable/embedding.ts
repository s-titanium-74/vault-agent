import type { EmbeddingResponse } from "./contracts.js";

export class EmbeddingProviderError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly code:
      | "EMBEDDING_FAILED"
      | "EMBEDDING_TIMEOUT"
      | "EMBEDDING_INPUT_TOO_LARGE" = "EMBEDDING_FAILED",
  ) {
    super(message);
    this.name = "EmbeddingProviderError";
  }
}

const inputTooLarge = () =>
  new EmbeddingProviderError(
    "Embedding input exceeds the supported recovery limits.",
    undefined,
    "EMBEDDING_INPUT_TOO_LARGE",
  );

/** Preserve one vector per input; only a typed size rejection permits recovery. */
export async function embedWithInputSplitting(
  texts: string[],
  request: (texts: string[]) => Promise<EmbeddingResponse>,
  options: { signal?: AbortSignal } = {},
): Promise<EmbeddingResponse> {
  let attempts = 0;
  let model: string | undefined;
  let dimension: number | undefined;
  const checked = async (inputs: string[]) => {
    options.signal?.throwIfAborted();
    if (++attempts > 128) throw inputTooLarge();
    const response = await request(inputs);
    options.signal?.throwIfAborted();
    if (
      !Number.isSafeInteger(response.dimension) ||
      response.dimension < 1 ||
      response.embeddings.length !== inputs.length ||
      (model !== undefined && response.model !== model) ||
      (dimension !== undefined && response.dimension !== dimension) ||
      response.embeddings.some(
        (v) => v.length !== response.dimension || !v.every(Number.isFinite),
      )
    )
      throw new EmbeddingProviderError("Embedding response is incompatible.");
    model = response.model;
    dimension = response.dimension;
    return response.embeddings;
  };
  type Part = { values: Float32Array; weight: number };
  const split = async (text: string, depth: number): Promise<Part[]> => {
    const points = Array.from(text);
    if (depth >= 6 || points.length < 2) throw inputTooLarge();
    const middle = Math.floor(points.length / 2);
    const parts: Part[] = [];
    for (const piece of [points.slice(0, middle), points.slice(middle)]) {
      const input = piece.join("");
      try {
        const values = (await checked([input]))[0]!;
        parts.push({ values, weight: piece.length });
      } catch (error) {
        options.signal?.throwIfAborted();
        if (
          !(error instanceof EmbeddingProviderError) ||
          error.code !== "EMBEDDING_INPUT_TOO_LARGE" ||
          attempts >= 128
        )
          throw error;
        parts.push(...(await split(input, depth + 1)));
      }
    }
    return parts;
  };
  const run = async (inputs: string[]): Promise<Float32Array[]> => {
    try {
      return await checked(inputs);
    } catch (error) {
      options.signal?.throwIfAborted();
      if (
        !(error instanceof EmbeddingProviderError) ||
        error.code !== "EMBEDDING_INPUT_TOO_LARGE" ||
        attempts >= 128
      )
        throw error;
      if (inputs.length > 1) {
        const middle = Math.floor(inputs.length / 2);
        return [
          ...(await run(inputs.slice(0, middle))),
          ...(await run(inputs.slice(middle))),
        ];
      }
      const text = inputs[0] ?? "";
      const parts = await split(text, 0);
      const weight = parts.reduce((sum, part) => sum + part.weight, 0);
      const mean = new Float64Array(dimension!);
      for (const part of parts)
        for (let i = 0; i < mean.length; i++)
          mean[i] = mean[i]! + part.values[i]! * (part.weight / weight);
      const norm = Math.hypot(...mean);
      if (!Number.isFinite(norm) || norm === 0)
        throw new EmbeddingProviderError("Embedding aggregate is invalid.");
      return [Float32Array.from(mean, (value) => value / norm)];
    }
  };
  const embeddings = await run(texts);
  return { embeddings, model: model ?? "", dimension: dimension ?? 0 };
}

import type {
  EmbeddingDescriptor,
  EmbeddingProviderContract,
  IndexRow,
  SourceEntry,
  SourceKind,
} from "./contracts.js";
import { canonicalSourcePath } from "./source-policy.js";
import { contentRevision } from "./identifiers.js";
import { prepareSourceNote } from "./ingestion.js";
import { EmbeddingProviderError } from "./embedding.js";

export interface IndexedSource {
  path: string;
  kind: SourceKind;
  revision: string | null;
}
export interface SourceObservation {
  path: string;
  source: IndexedSource | null;
  unavailable?: boolean;
}
export interface SourceChange {
  path: string;
  action: "upsert" | "reuse" | "remove" | "preserve" | "ignore";
  source: IndexedSource | null;
  previous: IndexedSource | null;
}
/** A complete scan admits deletions; a partial event batch removes only explicit absences. */
export function planSourceChanges(
  previous: readonly IndexedSource[],
  observed: readonly SourceObservation[],
  options: { complete?: boolean; force?: boolean } = {},
) {
  const before = new Map(previous.map((e) => [canonicalSourcePath(e.path), e]));
  const changes = new Map<string, SourceChange>();
  for (const observation of observed) {
    const path = canonicalSourcePath(observation.path),
      old = before.get(path) ?? null,
      current = observation.source;
    if (current && current.path !== path)
      throw new Error("Source observation path mismatch.");
    const action = observation.unavailable
      ? "preserve"
      : !current
        ? old
          ? "remove"
          : "ignore"
        : !options.force &&
            old &&
            old.kind === current.kind &&
            current.revision !== null &&
            old.revision === current.revision
          ? "reuse"
          : "upsert";
    changes.set(path, { path, action, source: current, previous: old });
  }
  if (options.complete)
    for (const [path, old] of before)
      if (!changes.has(path))
        changes.set(path, {
          path,
          action: "remove",
          source: null,
          previous: old,
        });
  return [...changes.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
}
export async function prepareNoteUpdate(
  entry: SourceEntry,
  previous: IndexRow | null,
  readText: () => Promise<string>,
  options: { force?: boolean; noteId?: string; mtimeMs?: number } = {},
) {
  const [change] = planSourceChanges(
    previous
      ? [
          {
            path: entry.path,
            kind: "note",
            revision: String(previous.content_hash),
          },
        ]
      : [],
    [
      {
        path: entry.path,
        source: { path: entry.path, kind: "note", revision: entry.revision },
      },
    ],
    options,
  );
  if (
    change!.action === "reuse" &&
    typeof previous?.wikilinks_json === "string"
  ) {
    const note: IndexRow = {
      ...previous,
      file_size: entry.size,
      mtime_ms: options.mtimeMs ?? Date.parse(entry.updated),
    };
    return { action: "reuse" as const, note };
  }
  const prepared = await prepareSourceNote(entry, await readText(), options);
  return { action: "upsert" as const, ...prepared };
}
export interface IndexEmbeddingInput {
  chunkId: string;
  contentHash: string;
  text: string;
  vectorKey?: string | null;
}
export interface IndexEmbeddingCache {
  get(key: string): Promise<Float32Array | null>;
}
export interface PreparedEmbedding extends IndexEmbeddingInput {
  cacheKey: string;
  values: Float32Array;
  generated: boolean;
  needsWrite: boolean;
}
function valid(values: Float32Array, dimension: number | null) {
  return (
    values.length > 0 &&
    (dimension === null || values.length === dimension) &&
    values.every(Number.isFinite)
  );
}
export async function embeddingInputKey(
  descriptor: EmbeddingDescriptor,
  text: string,
) {
  return contentRevision(JSON.stringify([descriptor, text]));
}
/** Common inference/reuse policy; adapters persist cache writes and publish vectors. */
export async function prepareEmbeddingBatch(
  inputs: readonly IndexEmbeddingInput[],
  options: {
    enabled: boolean;
    provider?: EmbeddingProviderContract;
    cache: IndexEmbeddingCache;
    descriptor?: EmbeddingDescriptor;
  },
) {
  if (!options.enabled || !inputs.length) return [];
  if (!options.provider)
    throw new EmbeddingProviderError("Embeddings are unavailable.");
  const descriptor = options.descriptor ?? options.provider.describe();
  if (inputs.length > descriptor.maxBatchSize)
    throw new EmbeddingProviderError("Embedding batch exceeds its limit.");
  const ready = new Map<string, Float32Array>();
  const keys = await Promise.all(
    inputs.map((input) => embeddingInputKey(descriptor, input.text)),
  );
  const missing = new Map<string, string>();
  for (let i = 0; i < inputs.length; i++) {
    const key = keys[i]!;
    if (ready.has(key) || missing.has(key)) continue;
    const values = await options.cache.get(key);
    if (values && valid(values, descriptor.dimension)) ready.set(key, values);
    else missing.set(key, inputs[i]!.text);
  }
  const generated = new Set<string>();
  let actual = descriptor;
  if (missing.size) {
    const response = await options.provider.embed([...missing.values()]);
    if (
      response.model !== descriptor.model ||
      !Number.isSafeInteger(response.dimension) ||
      response.dimension < 1 ||
      (descriptor.dimension !== null &&
        response.dimension !== descriptor.dimension) ||
      response.embeddings.length !== missing.size ||
      response.embeddings.some((v) => !valid(v, response.dimension))
    )
      throw new EmbeddingProviderError("Embedding response is incompatible.");
    actual = { ...descriptor, dimension: response.dimension };
    let i = 0;
    for (const [key] of missing) {
      ready.set(key, response.embeddings[i++]!);
      generated.add(key);
    }
  }
  return Promise.all(
    inputs.map(async (input, i) => {
      const key = keys[i]!,
        values = ready.get(key)!;
      const cacheKey = generated.has(key)
        ? await embeddingInputKey(actual, input.text)
        : key;
      return {
        ...input,
        cacheKey,
        values,
        generated: generated.has(key),
        needsWrite: input.vectorKey !== cacheKey,
      } satisfies PreparedEmbedding;
    }),
  );
}

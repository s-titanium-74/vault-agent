import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { EmbeddingProvider, EmbeddingProviderError } from "../src/embedding.js";
import { embedWithInputSplitting } from "../src/portable/embedding.js";
import { indexVault, reindexVault } from "../src/indexer.js";
import { incrementalIndexUpdate } from "../src/incremental-indexer.js";
import { IndexStore, getIndexPath } from "../src/index-store.js";
import { publicIndexErrorCode } from "../src/errors.js";
import { search } from "../src/search.js";
import { getChunk, getNote } from "../src/retrieval.js";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
const config = () => {
  const value = structuredClone(DEFAULT_CONFIG);
  value.embedding.enabled = true;
  value.embedding.model = "synthetic-model";
  return value;
};
const sizeError = () =>
  new EmbeddingProviderError(
    "safe size error",
    400,
    "EMBEDDING_INPUT_TOO_LARGE",
  );
const response = (inputs: string[]) => ({
  model: "synthetic-model",
  dimension: 2,
  embeddings: inputs.map(() => new Float32Array([1, 0])),
});
function mockEndpoint(limit: number) {
  const accepted: string[] = [];
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const { input } = JSON.parse(String(init.body)) as { input: string[] };
    // Synthetic tokenizer: one Unicode code point is one token.
    if (input.some((text) => Array.from(text).length > limit))
      return new Response(
        JSON.stringify({
          error: { message: "the input length exceeds the context length" },
        }),
        { status: 400 },
      );
    accepted.push(...input);
    return new Response(
      JSON.stringify({
        model: "synthetic-model",
        data: input.map(() => ({ embedding: [1, 0] })),
      }),
    );
  });
  vi.stubGlobal("fetch", fetch);
  return { fetch, accepted };
}

describe("bounded embedding input recovery", () => {
  it.each([
    "春の観測記録。".repeat(400),
    "A synthetic observation. ".repeat(100),
    "段落境界なし".repeat(400),
    "```typescript\n" + "const synthetic = 123;\n".repeat(120) + "```",
    "🌱𠮷é".repeat(600),
  ])("covers every code point of a rejected input", async (text) => {
    const { fetch, accepted } = mockEndpoint(1000);
    const result = await new EmbeddingProvider(config()).embed([text]);
    expect(accepted.join("")).toBe(text);
    expect(result.embeddings).toHaveLength(1);
    expect(Array.from(result.embeddings[0]!)).toEqual([1, 0]);
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(128);
  });

  it("keeps successful batches unchanged and isolates a rejected input", async () => {
    const { fetch, accepted } = mockEndpoint(3);
    const output = await new EmbeddingProvider(config()).embed([
      "abc",
      "123456",
      "xy",
    ]);
    expect(output.embeddings).toHaveLength(3);
    expect(accepted).toEqual(["abc", "123", "456", "xy"]);
    expect(fetch.mock.calls.length).toBe(7);
  });

  it("uses leaf lengths once when normalizing an uneven multi-level split", async () => {
    const vectors = new Map([
      ["a", [1, 0]],
      ["b", [0, 1]],
      ["c", [0, 1]],
      ["de", [1, 0]],
    ]);
    const result = await embedWithInputSplitting(["abcde"], async (texts) => {
      const values = vectors.get(texts[0]!);
      if (!values) throw sizeError();
      return {
        model: "synthetic-model",
        dimension: 2,
        embeddings: [new Float32Array(values)],
      };
    });
    expect(result.embeddings[0]![0]).toBeCloseTo(3 / Math.sqrt(13));
    expect(result.embeddings[0]![1]).toBeCloseTo(2 / Math.sqrt(13));
  });

  it.each(["", "a", "a".repeat(10000)])(
    "terminates persistent size errors",
    async (text) => {
      const request = vi.fn(async () => {
        throw sizeError();
      });
      await expect(
        embedWithInputSplitting([text], request),
      ).rejects.toMatchObject({ code: "EMBEDDING_INPUT_TOO_LARGE" });
      expect(request.mock.calls.length).toBeLessThanOrEqual(7);
    },
  );

  it("bounds total attempts across many rejected inputs", async () => {
    const request = vi.fn(async (texts: string[]) => {
      if (texts.length > 1 || texts[0]!.length > 1) throw sizeError();
      return response(texts);
    });
    await expect(
      embedWithInputSplitting(Array(32).fill("abcd"), request),
    ).rejects.toMatchObject({ code: "EMBEDDING_INPUT_TOO_LARGE" });
    expect(request).toHaveBeenCalledTimes(128);
  });

  it.each([
    [400, { error: { message: "invalid model or private diagnostic" } }],
    [413, { error: "payload limit" }],
    [500, { error: "the input length exceeds the context length" }],
    [
      400,
      {
        error: "the input length exceeds the context length" + "x".repeat(8192),
      },
    ],
    [400, null],
  ])(
    "does not split unrelated or unbounded errors (%s)",
    async (status, body) => {
      const fetch = vi.fn(
        async () => new Response(JSON.stringify(body), { status }),
      );
      vi.stubGlobal("fetch", fetch);
      await expect(
        new EmbeddingProvider(config()).embed(["synthetic input"]),
      ).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
      expect(fetch).toHaveBeenCalledTimes(1);
    },
  );

  it("recognizes a physical batch size rejection without exposing its response", async () => {
    const endpoint = mockEndpoint(5);
    endpoint.fetch.mockImplementationOnce(
      async () =>
        new Response(
          JSON.stringify({
            error: {
              message:
                "input (9 tokens) is too large to process. increase the physical batch size (current batch size: 5)",
            },
          }),
          { status: 400 },
        ),
    );
    expect(
      (await new EmbeddingProvider(config()).embed(["123456789"])).embeddings,
    ).toHaveLength(1);
  });

  it("rejects incompatible part vectors and zero aggregates", async () => {
    for (const kind of ["model", "dimension", "nan", "zero"] as const) {
      await expect(
        embedWithInputSplitting(["ab"], async (texts) => {
          if (texts[0] === "ab") throw sizeError();
          if (texts[0] === "a") return response(texts);
          return {
            model: kind === "model" ? "other" : "synthetic-model",
            dimension: kind === "dimension" ? 3 : 2,
            embeddings: [
              new Float32Array(
                kind === "dimension"
                  ? [1, 0, 0]
                  : kind === "nan"
                    ? [NaN, 0]
                    : [-1, 0],
              ),
            ],
          };
        }),
      ).rejects.toMatchObject({ code: "EMBEDDING_FAILED" });
    }
  });

  it("shares the deadline across recovery requests", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 70000);
        init.signal!.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new DOMException("synthetic private text", "AbortError"));
          },
          { once: true },
        );
      });
      return new Response(
        JSON.stringify({
          error: "the input length exceeds the context length",
        }),
        { status: 400 },
      );
    });
    vi.stubGlobal("fetch", fetch);
    const result = expect(
      new EmbeddingProvider(config()).embed(["abcdef"]),
    ).rejects.toMatchObject({ code: "EMBEDDING_TIMEOUT" });
    await vi.advanceTimersByTimeAsync(120000);
    await result;
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("honors caller cancellation before another recovery request", async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      throw sizeError();
    });
    await expect(
      embedWithInputSplitting(["abcdef"], request, {
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retains the safe terminal size code", () => {
    expect(publicIndexErrorCode(sizeError())).toBe("EMBEDDING_INPUT_TOO_LARGE");
  });
});

describe.each(["initial", "incremental", "reindex"] as const)(
  "%s input-limit recovery",
  (mode) => {
    it.each([false, true])(
      "preserves chunks and cache reuse (required=%s)",
      async (required) => {
        const root = fs.mkdtempSync(
          path.join(os.tmpdir(), "embedding-limits-"),
        );
        dirs.push(root);
        const cfg = config();
        cfg.vault.root = path.join(root, "vault");
        cfg.index.dir = path.join(root, "index");
        cfg.embedding.require = required;
        fs.mkdirSync(cfg.vault.root);
        const note = path.join(cfg.vault.root, "synthetic.md");
        fs.writeFileSync(
          note,
          "# Synthetic\n" + "観測記録🌱".repeat(500) + "\nSYNTHETIC_TAIL",
        );
        cfg.embedding.enabled = mode === "incremental";
        if (mode === "incremental") mockEndpoint(Infinity);
        await indexVault(cfg);
        let store = await IndexStore.open(getIndexPath(cfg));
        if (mode === "incremental") {
          // A valid lexical publication with unfinished embeddings, same model.
          store
            .getDb()
            .exec(
              "DELETE FROM embedding_cache; DELETE FROM vec_chunks; UPDATE chunks SET embedding_key = NULL",
            );
        }
        const chunks = (value: IndexStore) =>
          value
            .getDb()
            .prepare(
              "SELECT chunk_id, note_id, chunk_index, content, char_start, char_end, embedding_input_text FROM chunks ORDER BY chunk_id",
            )
            .all();
        const before = chunks(store);
        store.close();
        cfg.embedding.enabled = true;
        const endpoint = mockEndpoint(1000);
        const run = async () => {
          if (mode === "incremental") {
            const current = await IndexStore.open(getIndexPath(cfg));
            try {
              return await incrementalIndexUpdate(current, cfg, {
                paths: ["synthetic.md"],
              });
            } finally {
              current.close();
            }
          }
          return mode === "reindex" ? reindexVault(cfg) : indexVault(cfg);
        };
        await run();
        store = await IndexStore.open(getIndexPath(cfg));
        try {
          const after = chunks(store);
          expect(after).toEqual(before);
          expect(after.map((row) => row.content).join("")).toContain(
            "SYNTHETIC_TAIL",
          );
          for (const row of after)
            expect(
              getChunk(store, String(row.note_id), Number(row.chunk_index))
                ?.content,
            ).toBe(row.content);
          expect(
            getNote(store, String(after[0]!.note_id), cfg.vault.root)?.content,
          ).toBe(fs.readFileSync(note, "utf8"));
          expect(store.embeddingState(cfg)).toBe("ready");
          expect(
            (
              await search(
                store,
                "Synthetic",
                "embedding",
                5,
                cfg,
                new EmbeddingProvider(cfg),
              )
            ).usedMode,
          ).toBe("embedding");
        } finally {
          store.close();
        }
        endpoint.fetch.mockClear();
        await run();
        expect(endpoint.fetch).not.toHaveBeenCalled();
      },
    );
  },
);

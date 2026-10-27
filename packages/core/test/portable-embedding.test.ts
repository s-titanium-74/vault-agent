import { afterEach, expect, it, vi } from "vitest";
import { EmbeddingProvider, EmbeddingProviderError } from "../src/embedding.js";
import { DEFAULT_CONFIG } from "../src/config.js";
import { EMBEDDING_BATCH_SIZE } from "../src/schemas.js";

afterEach(() => vi.unstubAllGlobals());
function provider() {
  const config = structuredClone(DEFAULT_CONFIG);
  config.embedding.model = "synthetic";
  return new EmbeddingProvider(config);
}
it("describes the local provider without network or cloud configuration", () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(provider().describe()).toMatchObject({
    provider: "ollama",
    model: "synthetic",
    dimension: null,
    metric: "l2",
    inputFormat: "vault-agent-v1",
  });
  expect(fetch).not.toHaveBeenCalled();
});
it.each([
  { data: [] },
  { data: [{ embedding: [] }] },
  { data: [{ embedding: ["bad"] }] },
  { data: [{ embedding: [1e100] }] },
])(
  "rejects invalid embedding responses before vector persistence: %j",
  async (response) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(response)),
    );
    await expect(provider().embed(["synthetic input"])).rejects.toBeInstanceOf(
      EmbeddingProviderError,
    );
  },
);
it("rejects inconsistent vector dimensions within and across batches", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ data: [{ embedding: [1, 0] }, { embedding: [1] }] }),
    ),
  );
  await expect(provider().embed(["one", "two"])).rejects.toThrow("dimensions");
  let calls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calls++;
      return Response.json({
        model: "synthetic",
        data: Array.from(
          { length: calls === 1 ? EMBEDDING_BATCH_SIZE : 1 },
          () => ({ embedding: calls === 1 ? [1, 0] : [1] }),
        ),
      });
    }),
  );
  await expect(
    provider().embed(
      Array.from({ length: EMBEDDING_BATCH_SIZE + 1 }, () => "synthetic input"),
    ),
  ).rejects.toThrow("between batches");
});
it("sanitizes provider error bodies", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response("synthetic private input echoed by provider", {
          status: 500,
        }),
    ),
  );
  const error = await provider()
    .embed(["synthetic input"])
    .catch((e) => e);
  expect(error.message).toBe("Embedding provider returned HTTP 500.");
});
it("supports explicit cancellation without provider I/O", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  controller.abort();
  await expect(
    provider().embed(["synthetic input"], { signal: controller.signal }),
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(fetch).not.toHaveBeenCalled();
});

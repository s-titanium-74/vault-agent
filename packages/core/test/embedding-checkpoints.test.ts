import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../src/config.js";
import { EmbeddingProvider, EmbeddingProviderError } from "../src/embedding.js";
import { indexVault, reindexVault } from "../src/indexer.js";
import { IndexStore, getIndexPath } from "../src/index-store.js";
import { incrementalIndexUpdate } from "../src/incremental-indexer.js";
import { search } from "../src/search.js";
import { publicIndexErrorCode } from "../src/errors.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

describe.each(["initial", "watch", "reindex", "initial-reindex"] as const)(
  "%s checkpoint recovery",
  (mode) => {
    it.each([false, true])(
      "retains batches across two timeouts (required=%s)",
      async (required) => {
        const root = fs.mkdtempSync(
          path.join(os.tmpdir(), "embedding-checkpoints-"),
        );
        dirs.push(root);
        const config = structuredClone(DEFAULT_CONFIG);
        config.vault.root = path.join(root, "vault");
        config.index.dir = path.join(root, "index");
        config.embedding.enabled = true;
        config.embedding.model = "synthetic-model";
        config.embedding.require = required;
        fs.mkdirSync(config.vault.root);
        let call = 0;
        let fail = false;
        const generated = new Set<string>();
        const embed = vi
          .spyOn(EmbeddingProvider.prototype, "embed")
          .mockImplementation(async (texts) => {
            expect(texts.length).toBeLessThanOrEqual(8);
            // Allow an asynchronous provider boundary before the controlled timeout.
            await Promise.resolve();
            if (fail && ++call === 2)
              throw new EmbeddingProviderError(
                "synthetic private diagnostic",
                undefined,
                "EMBEDDING_TIMEOUT",
              );
            for (const text of texts) {
              expect(generated.has(text)).toBe(false);
              generated.add(text);
            }
            return {
              model: config.embedding.model,
              dimension: 2,
              embeddings: texts.map(() => new Float32Array([1, 0])),
            };
          });
        if (mode === "watch" || mode === "reindex") {
          fs.writeFileSync(
            path.join(config.vault.root, "seed.md"),
            "# Seed\nOriginal synthetic body.",
          );
          await indexVault(config);
          fs.writeFileSync(
            path.join(config.vault.root, "seed.md"),
            "# Seed\nChanged synthetic body.",
          );
        }
        const paths = Array.from({ length: 20 }, (_, i) => `note-${i}.md`);
        for (const [i, p] of paths.entries())
          fs.writeFileSync(
            path.join(config.vault.root, p),
            `# Synthetic ${i}\nUnique synthetic body ${i}.`,
          );
        paths.push("seed.md");
        const read = async () => IndexStore.open(getIndexPath(config));
        const run = async () => {
          if (mode === "watch") {
            const store = await read();
            try {
              return await incrementalIndexUpdate(store, config, { paths });
            } finally {
              store.close();
            }
          }
          return mode.includes("reindex")
            ? reindexVault(config)
            : indexVault(config);
        };
        const baseline = await read();
        const oldManifest = baseline.getManifest();
        const oldNotes = baseline.getAllNotesForUpdate();
        baseline.close();
        fail = true;
        let previousPending = Infinity;
        for (let attempt = 0; attempt < 2; attempt++) {
          call = 0;
          if (required)
            await expect(run()).rejects.toMatchObject({
              code: "EMBEDDING_TIMEOUT",
            });
          else {
            const result = await run();
            expect(result.warnings).toContainEqual(
              expect.objectContaining({ code: "EMBEDDING_TIMEOUT" }),
            );
            expect(JSON.stringify(result)).not.toContain("private diagnostic");
          }
          const store = await read();
          try {
            expect(
              store
                .getDb()
                .prepare("SELECT count(*) AS n FROM embedding_cache")
                .get(),
            ).toMatchObject({ n: expect.any(Number) });
            expect(
              store
                .getDb()
                .prepare("SELECT count(*) AS n FROM embedding_cache")
                .get()!.n,
            ).toBeGreaterThan(0);
            if (required) {
              expect(store.getManifest()).toEqual(oldManifest);
              expect(store.getAllNotesForUpdate()).toEqual(oldNotes);
            } else {
              const pending = Number(
                store
                  .getDb()
                  .prepare(
                    "SELECT count(*) AS n FROM chunks WHERE embedding_key IS NULL",
                  )
                  .get()!.n,
              );
              expect(pending).toBeLessThan(previousPending);
              previousPending = pending;
              expect(store.hasPendingEmbeddings()).toBe(true);
              expect(store.isEmbeddingReady()).toBe(false);
              expect(
                store
                  .getDb()
                  .prepare(
                    "SELECT count(*) AS n FROM chunks WHERE embedding_key IS NOT NULL",
                  )
                  .get()!.n,
              ).toBeGreaterThan(0);
            }
          } finally {
            store.close();
          }
        }
        fail = false;
        await run();
        const store = await read();
        try {
          expect(store.isEmbeddingReady()).toBe(true);
          expect(store.hasPendingEmbeddings()).toBe(false);
          const result = await search(
            store,
            "Synthetic query",
            "embedding",
            5,
            config,
            new EmbeddingProvider(config),
          );
          expect(result.usedMode).toBe("embedding");
          expect(result.results.length).toBeGreaterThan(0);
          expect(store.getManifest()!.noteCount).toBe(
            mode === "watch" || mode === "reindex" ? 21 : 20,
          );
        } finally {
          store.close();
        }
        expect(embed).toHaveBeenCalled();
      },
    );
  },
);

it("keeps only allowlisted diagnostic codes", () => {
  expect(
    publicIndexErrorCode({ code: "EMBEDDING_TIMEOUT", message: "secret" }),
  ).toBe("EMBEDDING_TIMEOUT");
  expect(publicIndexErrorCode({ code: "secret", message: "secret" })).toBe(
    "INDEX_UPDATE_FAILED",
  );
});

it("reports an aborted provider request as a safe timeout", async () => {
  const config = structuredClone(DEFAULT_CONFIG);
  config.embedding.model = "synthetic-model";
  vi.useFakeTimers();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: unknown, options: RequestInit) =>
        new Promise((_resolve, reject) => {
          options.signal!.addEventListener(
            "abort",
            () => reject(new DOMException("private diagnostic", "AbortError")),
            { once: true },
          );
        }),
    ),
  );
  try {
    const request = new EmbeddingProvider(config).embed(["Synthetic input"]);
    const assertion = expect(request).rejects.toMatchObject({
      code: "EMBEDDING_TIMEOUT",
    });
    await vi.advanceTimersByTimeAsync(120_000);
    await assertion;
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
});

it("can reindex an unreadable active database", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "embedding-repair-"));
  dirs.push(root);
  const config = structuredClone(DEFAULT_CONFIG);
  config.vault.root = path.join(root, "vault");
  config.index.dir = path.join(root, "index");
  fs.mkdirSync(config.vault.root);
  fs.writeFileSync(
    path.join(config.vault.root, "synthetic.md"),
    "# Synthetic\nBody.",
  );
  const dbPath = getIndexPath(config);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, "synthetic invalid database");
  await reindexVault(config);
  const store = await IndexStore.open(dbPath);
  try {
    expect(store.getManifest()!.noteCount).toBe(1);
  } finally {
    store.close();
  }
});

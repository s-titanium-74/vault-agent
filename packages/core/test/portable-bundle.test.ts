import { describe, expect, it } from "vitest";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

describe("portable dependency boundary", () => {
  it("bundles every export for a Web runtime without Node compatibility", async () => {
    const result = await build({
      entryPoints: ["packages/core/src/portable/index.ts"],
      bundle: true,
      platform: "browser",
      format: "iife",
      globalName: "Portable",
      write: false,
      metafile: true,
    });
    expect(
      Object.keys(result.metafile!.inputs).some((p) =>
        /(?:better-sqlite3|sqlite-vec|env-paths|src\/config\.ts|src\/pathsafety\.ts|src\/watcher\.ts|src\/sync\.ts)/.test(
          p,
        ),
      ),
    ).toBe(false);
    expect(result.metafile!.outputs["index.js"]?.imports ?? []).toEqual([]);
    const sandbox = {
      crypto: globalThis.crypto,
      TextEncoder,
      TextDecoder,
      ReadableStream,
      AbortController,
    };
    const api = runInNewContext(
      result.outputFiles![0]!.text + "; Portable",
      sandbox,
    );
    const id = await api.noteIdFromPath("Notes/Example.md");
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    expect(api.parseMarkdown("# Example\n\nbody").title).toBe("Example");
    expect(
      (
        await api.chunkNote({
          noteId: id,
          vaultRelativePath: "Notes/Example.md",
          title: "Example",
          headingPath: [],
          body: "synthetic body",
          fileSize: 14,
        })
      ).chunks[0].contentHash,
    ).toMatch(/^[a-f0-9]{32}$/);
    expect(api.sourcePolicy(["Notes"])("Notes/Example.md")).toBe(true);
    expect(api.sourcePolicy(["Notes"])(".env")).toBe(false);
    const mutation = await api.prepareMutationBatch(
      {
        vaultId: "synthetic-vault",
        sourceId: "synthetic-source",
        sourceKind: "r2",
        policyRevision: "policy-v1",
        includes: ["Notes", "Images"],
        settings: { enabled: true },
        snapshot: async (path: string, options: { readContent: boolean }) =>
          path === "Notes/Example.md"
            ? {
                version: "source-v1",
                ...(options.readContent ? { content: "Alpha Beta😀" } : {}),
              }
            : null,
      },
      {
        operations: [
          {
            type: "patch_note",
            path: "Notes/Example.md",
            expected_version: "source-v1",
            replacements: [
              {
                match_type: "regex",
                pattern: "(\\w+) (\\w+)",
                replacement: "$2 $1",
              },
            ],
          },
          {
            type: "upload_attachment",
            path: "Images/New.png",
            content_base64: "AQID",
          },
        ],
      },
      { preview: true },
    );
    expect(
      mutation.items.map((item: { status: string }) => item.status),
    ).toEqual(["prepared", "prepared"]);
    expect(new TextDecoder().decode(mutation.items[0].bytes)).toBe(
      "Beta Alpha😀",
    );
    expect(Array.from(mutation.items[1].bytes)).toEqual([1, 2, 3]);
    expect(JSON.stringify(api.mutationBatchSummary(mutation))).not.toContain(
      "Beta Alpha",
    );
    expect(api.previewMutationBatch(mutation).results[0].diff).toMatchObject({
      removed: "Alpha Bet",
      added: "Beta Alph",
      truncated: false,
    });
    const rejected = await api.prepareMutationBatch(
      {
        vaultId: "synthetic-vault",
        sourceId: "synthetic-source",
        sourceKind: "r2",
        policyRevision: "policy-v1",
        includes: ["."],
        settings: { enabled: true },
        snapshot: async () => ({
          version: "source-v1",
          content: "a".repeat(1024 * 1024) + "!",
        }),
      },
      {
        operations: [
          {
            type: "patch_note",
            path: "Example.md",
            expected_version: "source-v1",
            replacements: [
              { match_type: "regex", pattern: "(a+)+$", replacement: "X" },
            ],
          },
        ],
      },
    );
    expect(rejected.items[0].code).toBe("REGEX_BUDGET_EXCEEDED");
  });
});

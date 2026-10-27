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
  });
});

import { expect, it } from "vitest";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

it("bundles the published portable subpath without loading local/native code", async () => {
  const bundle = await build({
    stdin: {
      contents:
        'import * as api from "@vault-agent/core/portable"; globalThis.portable = api;',
      resolveDir: process.cwd(),
    },
    platform: "browser",
    bundle: true,
    write: false,
    metafile: true,
    format: "iife",
  });
  for (const output of Object.values(bundle.metafile!.outputs))
    expect(output.imports).toEqual([]);
  for (const dependency of Object.keys(bundle.metafile!.inputs))
    expect(dependency).not.toMatch(
      /(?:better-sqlite3|sqlite-vec|env-paths|dist\/local\/|dist\/index\.js$)/,
    );
  const api = runInNewContext(bundle.outputFiles![0]!.text + "; portable", {
    crypto,
    TextEncoder,
    TextDecoder,
    ReadableStream,
  });
  expect(await api.noteIdFromPath("Notes/Example.md")).toMatch(
    /^[a-f0-9]{32}$/,
  );
  expect(api.getOverview).toBeTypeOf("function");
  expect(api.getMetadataProfile).toBeTypeOf("function");
});

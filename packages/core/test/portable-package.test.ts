import { expect, it } from "vitest";
import { build } from "esbuild";
import { runInNewContext } from "node:vm";

it.each(["portable", "access"])(
  "bundles the published %s subpath without loading local/native code",
  async (subpath) => {
    const bundle = await build({
      stdin: {
        contents: `import * as api from "@vault-agent/core/${subpath}"; globalThis.portable = api;`,
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
    if (subpath === "access") {
      expect(api.requiredHttpRole("/index", "POST")).toBe("admin");
      expect(
        await api.authorizeBearer(
          "Bearer synthetic",
          { read: ["synthetic"], admin: [] },
          "admin",
          (a: string, b: string) => a === b,
        ),
      ).toBe("ADMIN_REQUIRED");
      return;
    }
    expect(await api.noteIdFromPath("Notes/Example.md")).toMatch(
      /^[a-f0-9]{32}$/,
    );
    expect(api.getOverview).toBeTypeOf("function");
    expect(api.getMetadataProfile).toBeTypeOf("function");
  },
);

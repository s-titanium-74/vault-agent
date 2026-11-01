import { it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rename,
  unlink,
  stat,
  utimes,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomBytes } from "node:crypto";
import { DEFAULT_CONFIG } from "../../core/src/config.js";
import { indexVault } from "../../core/src/indexer.js";
import { incrementalIndexUpdate } from "../../core/src/incremental-indexer.js";
import { IndexStore, getIndexPath } from "../../core/src/index-store.js";
import type { IndexRow } from "../../core/src/portable/contracts.js";
import { VAULT_ID } from "../scripts/fixture.js";

it("runs the same synthetic change/rename/delete corpus through local watch and Worker jobs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "shared-adapter-corpus-"));
  const root = path.join(dir, "vault");
  await mkdir(path.join(root, "Notes"), { recursive: true });
  const config = structuredClone(DEFAULT_CONFIG);
  config.vault.root = root;
  config.index.dir = path.join(dir, "index");
  const read = randomBytes(32).toString("hex"),
    admin = randomBytes(32).toString("hex");
  const bundle = await build({
    entryPoints: ["test/ingestion-worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    tsconfig: "tsconfig.json",
  });
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-10-28",
      d1Databases: { DB: "shared-updates" },
      r2Buckets: { SOURCE: "shared-updates" },
      ratelimits: {
        REQUEST_LIMITER: {
          namespace_id: "1010",
          simple: { limit: 100000, period: 60 },
        },
      },
      bindings: {
        VAULT_ID,
        READ_TOKEN: read,
        ADMIN_TOKEN: admin,
        INCLUDE_PATHS: '["Notes"]',
        EXCLUDE_PATHS: "[]",
        ALLOWED_ORIGINS: "[]",
        PROFILE_VALUE_ALLOWLIST: "[]",
        INGESTION_ENABLED: "true",
        EXTERNAL_EMBEDDING_CONSENT: "false",
        EMBEDDING_MODEL_REVISION: "operator-v1",
      },
    }),
  );
  let local: IndexStore | undefined;
  try {
    const db = await mf.getD1Database("DB"),
      bucket = await mf.getR2Bucket("SOURCE");
    for (const file of [
      "0001_retrieval.sql",
      "0002_semantic.sql",
      "0003_ingestion.sql",
      "0004_incremental.sql",
      "0005_source_observations.sql",
    ])
      for (const sql of (await readFile("migrations/" + file, "utf8"))
        .replace(/--[^\n]*/g, "")
        .split(";")
        .filter((s) => s.trim()))
        await db.prepare(sql).run();
    const request = async (route: string) => {
      const response = await mf.dispatchFetch(
        "https://vault.example.invalid" + route,
        { headers: { Authorization: `Bearer ${admin}` } },
      );
      expect(response.status).toBe(200);
      return response.json() as Promise<any>;
    };
    const settle = async () => {
      for (let n = 0; n < 100; n++) {
        await request("/__tick");
        const state = await db
          .prepare(
            "SELECT j.state,j.error FROM ingestion_state s JOIN ingestion_jobs j ON j.id=s.job",
          )
          .first<{ state: string; error: string | null }>();
        expect(state?.error).toBeNull();
        if (state?.state === "complete") return;
      }
      throw new Error("Worker did not finish");
    };
    const put = async (p: string, text: string) => {
      await writeFile(path.join(root, p), text);
      await bucket.put(`${VAULT_ID}/source/${p}`, text);
    };
    const normalized = (row: IndexRow) =>
      Object.fromEntries(
        Object.entries(row).filter(
          ([key]) =>
            !["mtime_ms", "embedding_key"].includes(key) &&
            !(key === "content_hash" && !row.chunk_id),
        ),
      );
    const compare = async () => {
      const rows = (
        await db
          .prepare(
            "SELECT data FROM notes WHERE revision=(SELECT revision FROM deployment) ORDER BY path",
          )
          .all<{ data: string }>()
      ).results.map((r) => JSON.parse(r.data));
      expect(rows.map(normalized)).toEqual(
        local!
          .getAllNotes()
          .sort((a, b) => String(a.path).localeCompare(String(b.path)))
          .map(normalized),
      );
      const chunks = (
        await db
          .prepare(
            "SELECT data FROM chunks WHERE revision=(SELECT revision FROM deployment) ORDER BY chunk_id",
          )
          .all<{ data: string }>()
      ).results.map((r) => JSON.parse(r.data));
      expect(chunks.map(normalized)).toEqual(
        local!
          .getAllChunkIds()
          .sort()
          .map((id) => normalized(local!.getChunkById(id)!)),
      );
      const source = local!.getNoteByPath("Notes/Source.md")!;
      return JSON.parse(String(source.links_json)) as {
        target: string;
        resolved: string | null;
      }[];
    };
    await put(
      "Notes/Source.md",
      "---\ntitle: Source\ntags: [garden]\nstatus: active\n---\n# Source\n[[Future]] [target](Target.md)\n",
    );
    await put("Notes/Target.md", "# Target\nold content\n日本語の果樹。\n");
    await indexVault(config);
    local = await IndexStore.open(getIndexPath(config));
    await settle();
    let links = await compare();
    expect(links.find((l) => l.target === "Future")!.resolved).toBeNull();
    await put("Notes/Future.md", "# Future\nSynthetic new target.\n");
    await incrementalIndexUpdate(local, config, { paths: ["Notes/Future.md"] });
    await settle();
    links = await compare();
    expect(links.find((l) => l.target === "Future")!.resolved).not.toBeNull();
    const original = await stat(path.join(root, "Notes/Target.md"));
    await put("Notes/Target.md", "# Target\nnew content\n日本語の果樹。\n");
    await utimes(
      path.join(root, "Notes/Target.md"),
      original.atime,
      original.mtime,
    );
    await incrementalIndexUpdate(local, config, { paths: ["Notes/Target.md"] });
    await settle();
    await compare();
    await rename(
      path.join(root, "Notes/Future.md"),
      path.join(root, "Notes/Renamed.md"),
    );
    await bucket.delete(`${VAULT_ID}/source/Notes/Future.md`);
    await bucket.put(
      `${VAULT_ID}/source/Notes/Renamed.md`,
      "# Future\nSynthetic new target.\n",
    );
    await incrementalIndexUpdate(local, config, {
      paths: ["Notes/Future.md", "Notes/Renamed.md"],
    });
    await settle();
    await compare();
    await unlink(path.join(root, "Notes/Target.md"));
    await bucket.delete(`${VAULT_ID}/source/Notes/Target.md`);
    await incrementalIndexUpdate(local, config, { paths: ["Notes/Target.md"] });
    await settle();
    links = await compare();
    expect(links.find((l) => l.target !== "Future")!.resolved).toBeNull();
  } finally {
    local?.close();
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);

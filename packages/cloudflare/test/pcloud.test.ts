import { expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SyntheticPCloud } from "../../core/test/helpers/pcloud.js";
import { DEFAULT_CONFIG } from "../../core/src/config.js";
import { indexVault } from "../../core/src/indexer.js";
import { IndexStore, getIndexPath } from "../../core/src/index-store.js";
import * as core from "../../core/src/portable/index.js";

it("indexes the same pCloud corpus in SQLite and D1 without an R2 binding", async () => {
  const api = new SyntheticPCloud();
  api.set("Notes/Apple.md", "# Apple\n\nSynthetic orchard. [[Pear]]\n");
  api.set("Notes/Pear.md", "# Pear\n\nSynthetic fruit.\n");
  api.set("Private/Skip.md", "# Excluded synthetic note\n");
  const bundle = await build({
    entryPoints: ["test/ingestion-worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    tsconfig: "tsconfig.json",
  });
  const admin = "a".repeat(64);
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-10-29",
      d1Databases: { DB: "pcloud-synthetic" },
      // Deliberately no r2Buckets option.
      outboundService: async (request) =>
        api.fetch(request.url, {
          method: request.method,
          body: request.method === "POST" ? await request.text() : undefined,
        }),
      ratelimits: {
        REQUEST_LIMITER: {
          namespace_id: "1051",
          simple: { limit: 100000, period: 60 },
        },
      },
      bindings: {
        VAULT_ID: "11111111-1111-4111-8111-111111111111",
        READ_TOKEN: "b".repeat(64),
        ADMIN_TOKEN: admin,
        INCLUDE_PATHS: '["Notes"]',
        EXCLUDE_PATHS: "[]",
        ALLOWED_ORIGINS: "[]",
        PROFILE_VALUE_ALLOWLIST: "[]",
        INGESTION_ENABLED: "true",
        EXTERNAL_EMBEDDING_CONSENT: "false",
        EMBEDDING_MODEL_REVISION: "operator-v1",
        SOURCE_PROVIDER: "pcloud",
        PCLOUD_REGION: "eu",
        PCLOUD_FOLDER_ID: "1",
        PCLOUD_ACCESS_TOKEN: "synthetic-token",
      },
    }),
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "pcloud-parity-"));
  let local: IndexStore | undefined;
  try {
    const db = await mf.getD1Database("DB");
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      for (const sql of (await readFile("migrations/" + file, "utf8"))
        .replace(/--[^\n]*/g, "")
        .split(";")
        .filter((s) => s.trim()))
        await db.prepare(sql).run();
    const request = async (route: string, input?: unknown) => {
      const response = await mf.dispatchFetch(
        "https://vault.example.invalid" + route,
        {
          method: input === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${admin}`,
            "Content-Type": "application/json",
          },
          ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        },
      );
      return { status: response.status, ...((await response.json()) as any) };
    };
    const run = async () => {
      let job = (await request("/index", {})).data;
      for (
        let n = 0;
        n < 100 && !["complete", "failed"].includes(job.state);
        n++
      )
        job = (
          await request(`/jobs/${job.jobId}/advance`, {
            checkpoint: job.checkpoint,
          })
        ).data;
      return job;
    };
    const config = structuredClone(DEFAULT_CONFIG);
    config.index.dir = dir;
    config.vault.pcloud = {
      region: "eu",
      folder_id: "1",
      access_token: "synthetic-token",
      includes: ["Notes"],
      poll_seconds: 300,
    };
    vi.stubGlobal("fetch", api.fetch);
    const compare = async () => {
      await indexVault(config);
      local ??= await IndexStore.open(getIndexPath(config));
      const cloudRows = (
        await db
          .prepare(
            "SELECT data FROM notes WHERE revision=(SELECT revision FROM deployment) ORDER BY path",
          )
          .all<{ data: string }>()
      ).results.map((r) => JSON.parse(r.data));
      const normalize = (r: core.IndexRow) => ({
        path: r.path,
        note_id: r.note_id,
        content_hash: r.content_hash,
        links_json: r.links_json,
        body_text: r.body_text,
      });
      expect(cloudRows.map(normalize)).toEqual(
        local
          .getAllNotes()
          .sort((a, b) => String(a.path).localeCompare(String(b.path)))
          .map(normalize),
      );
    };
    const initial = await run();
    expect(initial.error).toBeNull();
    expect(initial.state).toBe("complete");
    await compare();
    const id = await core.noteIdFromPath("Notes/Apple.md");
    const searchStart = api.requests.length;
    expect(
      (await request("/search", { query: "orchard", mode: "lexical" })).status,
    ).toBe(200);
    expect(api.requests).toHaveLength(searchStart);
    expect((await request(`/notes/${id}`)).data.content).toContain(
      "Synthetic orchard",
    );
    expect((await request(`/chunks/${id}/0`)).status).toBe(200);
    const before = await db
      .prepare("SELECT data FROM notes WHERE path='Notes/Pear.md'")
      .first();
    api.set("Notes/Apple.md", "# Apple\n\nSynthetic gardens. [[Pear]]\n");
    expect((await request(`/notes/${id}`)).error.code).toBe(
      "SOURCE_REVISION_MISMATCH",
    );
    const update = await run();
    expect(update.state).toBe("complete");
    expect(update.updatePath).toBe("incremental");
    await compare();
    expect(
      await db
        .prepare("SELECT data FROM notes WHERE path='Notes/Pear.md'")
        .first(),
    ).toEqual(before);
    // Simulate a changed body even when provider hash/mtime remain unchanged.
    const originalProviderHash = api.files.get("Notes/Pear.md")!.hash;
    api.files.get("Notes/Pear.md")!.text = "# Pear\n\nSynthetic plant.\n";
    expect(api.files.get("Notes/Pear.md")!.hash).toBe(originalProviderHash);
    expect(await run()).toMatchObject({
      state: "complete",
      updatePath: "incremental",
    });
    await compare();
    api.set("Notes/Plum.md", api.files.get("Notes/Pear.md")!.text);
    api.files.delete("Notes/Pear.md");
    expect(await run()).toMatchObject({ state: "complete" });
    await compare();
    const prior = (await request("/status")).data.deployment.activeRevision;
    api.partial = true;
    expect((await run()).state).toBe("failed");
    expect((await request("/status")).data.deployment.activeRevision).toBe(
      prior,
    );
    api.partial = false;
    expect(await run()).toMatchObject({ state: "complete" });
    // Stop between validation and publication, then mutate the source.
    api.set("Notes/New.md", "# New\n");
    let job = (await request("/index", {})).data;
    for (
      let n = 0;
      n < 100 &&
      job.state !== "publishing" &&
      !["failed", "complete"].includes(job.state);
      n++
    )
      job = (
        await request(`/jobs/${job.jobId}/advance`, {
          checkpoint: job.checkpoint,
        })
      ).data;
    expect(job.state).toBe("publishing");
    api.set("Notes/Race.md", "# Race\n");
    job = (
      await request(`/jobs/${job.jobId}/advance`, {
        checkpoint: job.checkpoint,
      })
    ).data;
    expect(job.state).toBe("failed");
    expect((await request("/status")).data.deployment.activeRevision).toBe(
      prior,
    );
    expect(await run()).toMatchObject({ state: "complete" });
    await compare();
    expect(
      (await db.prepare("SELECT count(*) AS n FROM source_objects").first())!.n,
    ).toBe(0);
    expect(
      (await db.prepare("SELECT count(*) AS n FROM retired_objects").first())!
        .n,
    ).toBe(0);
    await db
      .prepare(
        "UPDATE snapshots SET created=0 WHERE revision NOT IN (SELECT revision FROM deployment)",
      )
      .run();
    await db
      .prepare(
        "UPDATE ingestion_jobs SET created=0 WHERE id IS NOT (SELECT job FROM ingestion_state)",
      )
      .run();
    for (let n = 0; n < 12; n++)
      expect((await request("/__tick")).status).toBe(200);
    // Idle R2 preflight must not skip pCloud's digest scan or require a bucket.
    api.files.get("Notes/Plum.md")!.text = "# Pear\n\nSynthetic bloom.\n";
    for (let n = 0; n < 12; n++)
      expect((await request("/__tick")).status).toBe(200);
    expect(
      (await db
        .prepare(
          "SELECT data FROM notes WHERE path='Notes/Plum.md' AND revision=(SELECT revision FROM deployment)",
        )
        .first<{ data: string }>())!.data,
    ).toContain("Synthetic bloom.");
    await compare();
    expect((await request("/status")).data.deployment.capabilities.upload).toBe(
      false,
    );
  } finally {
    vi.unstubAllGlobals();
    local?.close();
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}, 60000);

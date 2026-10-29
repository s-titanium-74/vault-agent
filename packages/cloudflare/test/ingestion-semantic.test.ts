import { it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { VAULT_ID } from "../scripts/fixture.js";

it("caches unchanged embedding inputs, waits for visibility and revokes deleted vectors at publication", async () => {
  const bundle = await build({
    entryPoints: ["test/ingestion-worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    tsconfig: "tsconfig.json",
  });
  const read = randomBytes(32).toString("hex"),
    admin = randomBytes(32).toString("hex");
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-10-28",
      d1Databases: { DB: "semantic-ingestion" },
      r2Buckets: { SOURCE: "semantic-ingestion" },
      ratelimits: {
        REQUEST_LIMITER: {
          namespace_id: "1003",
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
        EXTERNAL_EMBEDDING_CONSENT: "true",
        EMBEDDING_MODEL: "@cf/baai/bge-m3",
        EMBEDDING_MODEL_REVISION: "operator-v1",
      },
    }),
  );
  try {
    const db = await mf.getD1Database("DB"),
      bucket = await mf.getR2Bucket("SOURCE");
    for (const file of [
      "0001_retrieval.sql",
      "0002_semantic.sql",
      "0003_ingestion.sql",
    ])
      for (const sql of (await readFile("migrations/" + file, "utf8"))
        .replace(/--[^\n]*/g, "")
        .split(";")
        .filter((s) => s.trim()))
        await db.prepare(sql).run();
    await db
      .prepare(
        "CREATE TABLE synthetic_vectors(id TEXT PRIMARY KEY,namespace TEXT,data TEXT)",
      )
      .run();
    await db
      .prepare(
        "CREATE TABLE synthetic_usage(calls INTEGER,visible INTEGER,fail INTEGER)",
      )
      .run();
    await db.prepare("INSERT INTO synthetic_usage VALUES(0,0,0)").run();
    const req = async (route: string, input?: unknown) => {
      const response = await mf.dispatchFetch(
        "https://vault.example.invalid" + route,
        {
          method: input === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${admin}`,
            "Content-Type": "application/json",
          },
          ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
        },
      );
      return response.json() as Promise<any>;
    };
    const prefix = `${VAULT_ID}/source/`;
    await bucket.put(
      prefix + "Notes/Apple.md",
      "# Apple\nApples in orchards.\n",
    );
    await bucket.put(prefix + "Notes/Pear.md", "# Pear\nPear trees.\n");
    const start = async () => (await req("/index", {})).data;
    const step = async (job: any) =>
      (await req(`/jobs/${job.jobId}/advance`, { checkpoint: job.checkpoint }))
        .data;
    const finish = async (job: any) => {
      for (
        let n = 0;
        n < 150 && !["complete", "failed"].includes(job.state);
        n++
      )
        job = await step(job);
      expect(job.error).toBeNull();
      expect(job.state).toBe("complete");
      return job;
    };
    let job = await start();
    for (let n = 0; n < 100; n++) {
      job = await step(job);
      const count = await db
        .prepare("SELECT count(*) AS n FROM ingestion_vectors")
        .first<{ n: number }>();
      if (count!.n) break;
    }
    expect(job.state).toBe("vectors");
    const checkpoint = job.checkpoint;
    job = await step(job);
    expect(job.checkpoint).toBeGreaterThan(checkpoint);
    expect(job.state).toBe("vectors");
    expect(
      await db.prepare("SELECT revision FROM deployment").first(),
    ).toBeNull();
    await db.prepare("UPDATE synthetic_usage SET visible=1").run();
    job = await finish(job);
    expect(
      (await db.prepare("SELECT calls FROM synthetic_usage").first())!.calls,
    ).toBe(2);
    const firstRevision = job.targetRevision;
    // Force rebuild, using persisted input cache rather than hosted inference again.
    const rebuild = (await req("/reindex", {})).data;
    await finish(rebuild);
    expect(
      (await db.prepare("SELECT calls FROM synthetic_usage").first())!.calls,
    ).toBe(2);
    await bucket.put(
      prefix + "Notes/Apple.md",
      "# Apple\nRevised citrus orchard.\n",
    );
    await bucket.delete(prefix + "Notes/Pear.md");
    await finish(await start());
    expect(
      (await db.prepare("SELECT calls FROM synthetic_usage").first())!.calls,
    ).toBe(3);
    const search = await req("/search", {
      query: "orchard",
      mode: "embedding",
      limit: 10,
    });
    expect(JSON.stringify(search)).not.toContain("Pear");
    expect(search.data.results).toHaveLength(1);
    expect(
      (await db
        .prepare(
          "SELECT count(*) AS n FROM synthetic_vectors WHERE namespace IN (SELECT namespace FROM synthetic_vectors GROUP BY namespace)",
        )
        .first())!.n,
    ).toBeGreaterThan(1);
    expect(
      (await db.prepare("SELECT revision FROM deployment").first())!.revision,
    ).not.toBe(firstRevision);
    // Invalid persisted vectors are regenerated and repaired before retrying the step.
    const callsBeforeRepair = Number(
      (await db.prepare("SELECT calls FROM synthetic_usage").first())!.calls,
    );
    await db.prepare("UPDATE embedding_cache SET values_json='[1]'").run();
    await finish((await req("/reindex", { requireEmbeddings: true })).data);
    expect(
      Number(
        (await db.prepare("SELECT calls FROM synthetic_usage").first())!.calls,
      ),
    ).toBe(callsBeforeRepair + 1);
    await finish((await req("/reindex", { requireEmbeddings: true })).data);
    expect(
      Number(
        (await db.prepare("SELECT calls FROM synthetic_usage").first())!.calls,
      ),
    ).toBe(callsBeforeRepair + 1);
    // Provider failure publishes a consistent lexical-only target with explicit state.
    await db.prepare("UPDATE synthetic_usage SET fail=1").run();
    await bucket.put(
      prefix + "Notes/Apple.md",
      "# Apple\nNew unavailable input.\n",
    );
    await finish(await start());
    expect(
      (await db
        .prepare(
          "SELECT state FROM embedding_generations WHERE revision=(SELECT revision FROM deployment)",
        )
        .first())!.state,
    ).toBe("unavailable");
    const strict = (await req("/reindex", { requireEmbeddings: true })).data;
    let failed = strict;
    for (
      let n = 0;
      n < 100 && !["complete", "failed"].includes(failed.state);
      n++
    )
      failed = await step(failed);
    expect(failed.state).toBe("failed");
    const admission = await mf.dispatchFetch(
      "https://vault.example.invalid/index",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${admin}`,
          "Content-Type": "application/json",
          "X-Synthetic-Lost-Admission": "true",
        },
        body: JSON.stringify({ requireEmbeddings: true }),
      },
    );
    expect(admission.status).toBe(409);
    expect(((await admission.json()) as any).error.code).toBe("INDEX_BUSY");

    expect(JSON.stringify(failed)).not.toContain(
      "synthetic-private-provider-error",
    );
  } finally {
    await mf.dispose();
  }
}, 30000);

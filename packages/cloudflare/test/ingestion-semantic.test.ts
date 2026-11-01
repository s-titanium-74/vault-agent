import { it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";
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
      "0004_incremental.sql",
      "0005_source_observations.sql",
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
    const req = async (
      route: string,
      input?: unknown,
      extra: Record<string, string> = {},
    ) => {
      const response = await mf.dispatchFetch(
        "https://vault.example.invalid" + route,
        {
          method: input === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${admin}`,
            "Content-Type": "application/json",
            ...extra,
          },
          ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
        },
      );
      return response.json() as Promise<any>;
    };
    const catchUp = async (extra: Record<string, string> = {}) => {
      const current = (await db
        .prepare(
          "SELECT j.id,j.checkpoint FROM ingestion_state s JOIN ingestion_jobs j ON j.id=s.job WHERE s.id=1",
        )
        .first())!;
      return req(
        `/jobs/${current.id}/advance`,
        { checkpoint: current.checkpoint },
        extra,
      );
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
    const pending = await req("/search", {
      query: "orchard",
      mode: "embedding",
      limit: 10,
    });
    expect(pending.data.results).toHaveLength(0);
    expect(
      pending.warnings.some((w: any) => w.code === "SEMANTIC_UPDATING"),
    ).toBe(true);
    expect((await req("/status")).data.deployment.semantic.state).toBe(
      "updating",
    );
    expect(
      (await req("/search", { query: "citrus", mode: "lexical" })).data.results
        .length,
    ).toBeGreaterThan(0);
    await catchUp();
    expect(
      (await db.prepare("SELECT calls FROM synthetic_usage").first())!.calls,
    ).toBe(4);
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
    await catchUp();
    expect(
      (await db
        .prepare(
          "SELECT state FROM vector_work WHERE revision=(SELECT revision FROM deployment)",
        )
        .first())!.state,
    ).toBe("failed");
    expect((await req("/status")).data.deployment.semantic.state).toBe(
      "failed",
    );
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
    // A title-only edit changes the embedding input, even when chunk bytes do not.
    await db.prepare("UPDATE synthetic_usage SET fail=0").run();
    await bucket.put(
      prefix + "Notes/Apple.md",
      "---\ntitle: Variant A\n---\n# Apple\nSame orchard body.\n",
    );
    await finish(await start());
    const oldWork = (await db
      .prepare(
        "SELECT * FROM vector_work WHERE revision=(SELECT revision FROM deployment)",
      )
      .first())!;
    await bucket.put(
      prefix + "Notes/Apple.md",
      "---\ntitle: Variant B\n---\n# Apple\nSame orchard body.\n",
    );
    await finish(await start());
    const newWork = (await db
      .prepare(
        "SELECT * FROM vector_work WHERE revision=(SELECT revision FROM deployment)",
      )
      .first())!;
    expect(newWork.content_hash).toBe(oldWork.content_hash);
    expect(newWork.input_key).not.toBe(oldWork.input_key);
    expect(newWork.vector_id).not.toBe(oldWork.vector_id);
    // Simulate the superseded writer finishing its immutable upsert late.
    const record = JSON.parse(
      (await db.prepare("SELECT data FROM synthetic_vectors LIMIT 1").first())!
        .data as string,
    );
    record.id = oldWork.vector_id;
    record.namespace = createHash("sha256")
      .update(
        JSON.stringify([
          VAULT_ID,
          oldWork.revision,
          record.metadata.generation,
        ]),
      )
      .digest("hex");
    record.metadata = {
      ...record.metadata,
      chunkId: oldWork.chunk_id,
      contentHash: oldWork.content_hash,
      inputKey: oldWork.input_key,
    };
    await db
      .prepare("INSERT OR REPLACE INTO synthetic_vectors VALUES(?,?,?)")
      .bind(record.id, record.namespace, JSON.stringify(record))
      .run();
    expect(
      (await req("/search", { query: "orchard", mode: "embedding" })).data
        .results,
    ).toHaveLength(0);
    const calls = (await db
      .prepare("SELECT calls FROM synthetic_usage")
      .first())!.calls;
    await catchUp({
      "X-Synthetic-Disable-Semantic": "true",
    });
    expect(
      (await db.prepare("SELECT calls FROM synthetic_usage").first())!.calls,
    ).toBe(calls);
    await db.prepare("UPDATE synthetic_usage SET visible=0").run();
    await catchUp();
    expect((await req("/status")).data.deployment.semantic.state).toBe(
      "updating",
    );
    const afterInference = (await db
      .prepare("SELECT calls FROM synthetic_usage")
      .first())!.calls;
    await db.prepare("UPDATE synthetic_usage SET visible=1").run();
    await catchUp();
    expect(
      (await db.prepare("SELECT calls FROM synthetic_usage").first())!.calls,
    ).toBe(afterInference);
    expect((await req("/status")).data.deployment.semantic.state).toBe("ready");
    const current = await req("/search", {
      query: "orchard",
      mode: "embedding",
    });
    expect(current.data.results).toHaveLength(1);
    expect(JSON.stringify(current.data.results)).toContain("Variant B");
    await bucket.put(
      prefix + "Notes/Pine.md",
      "# Pine\nAnother synthetic orchard.\n",
    );
    await finish(await start());
    const partial = await req("/search", {
      query: "orchard",
      mode: "embedding",
    });
    expect(partial.data.results).toHaveLength(1);
    expect(JSON.stringify(partial.data.results)).toContain("Variant B");
    expect(
      partial.warnings.some((w: any) => w.code === "SEMANTIC_UPDATING"),
    ).toBe(true);
    await db.prepare("UPDATE retired_vectors SET retired=0").run();
    await req("/__tick");
    await req("/__tick");
    expect(
      (await db.prepare("SELECT count(*) AS n FROM retired_vectors").first())!
        .n,
    ).toBe(0);
    const retained = (
      await db
        .prepare(
          "SELECT vector_id FROM vector_work WHERE revision=(SELECT revision FROM deployment) AND state='ready'",
        )
        .all()
    ).results;
    expect(retained.length).toBeGreaterThan(0);
    for (const row of retained)
      expect(
        await db
          .prepare("SELECT id FROM synthetic_vectors WHERE id=?")
          .bind(row.vector_id)
          .first(),
      ).not.toBeNull();
  } finally {
    await mf.dispose();
  }
}, 30000);

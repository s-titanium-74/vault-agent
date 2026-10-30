// Local workerd operation benchmark. No network service, real vault or credentials.
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, writeFile, mkdtemp, rm, readdir } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import assert from "node:assert/strict";
import { noteIdFromPath } from "../../core/src/portable/identifiers.js";
const reportFile = process.argv[2];
assert(reportFile, "Usage: benchmark-local.ts REPORT_JSON");
const bundle = await build({
  entryPoints: ["test/benchmark-worker.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "browser",
  tsconfig: "tsconfig.json",
});
const report: Record<string, unknown> = {
  runtime: "local-workerd",
  date: new Date().toISOString(),
  cpuMs: null,
  peakMemoryBytes: null,
  hosted: false,
  semantic: false,
  workloads: [],
};
for (const count of [1, 100, 1000]) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "vault-agent-benchmark-"));
  const read = randomBytes(32).toString("hex"),
    admin = randomBytes(32).toString("hex"),
    vaultId = randomUUID();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-10-29",
      d1Databases: { DB: "benchmark" },
      r2Buckets: { SOURCE: "benchmark" },
      ratelimits: {
        REQUEST_LIMITER: {
          namespace_id: "1001",
          simple: { limit: 1000000, period: 60 },
        },
      },
      bindings: {
        VAULT_ID: vaultId,
        READ_TOKEN: read,
        ADMIN_TOKEN: admin,
        INCLUDE_PATHS: '["Notes","images"]',
        EXCLUDE_PATHS: '["**/secret.md"]',
        ALLOWED_ORIGINS: "[]",
        PROFILE_VALUE_ALLOWLIST: "[]",
        INGESTION_ENABLED: "true",
        EXTERNAL_EMBEDDING_CONSENT: "false",
        EMBEDDING_MODEL_REVISION: "operator-v1",
      },
    }),
  );
  try {
    const db = await mf.getD1Database("DB"),
      bucket = await mf.getR2Bucket("SOURCE");
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort())
      for (const sql of (await readFile("migrations/" + file, "utf8"))
        .replace(/--[^\n]*/g, "")
        .split(";")
        .filter((s) => s.trim()))
        await db.prepare(sql).run();
    await db
      .prepare(
        "CREATE TABLE synthetic_telemetry(kind TEXT,wall_ms INTEGER,counts TEXT)",
      )
      .run();
    const fixture = path.join(dir, "vault");
    assert.equal(
      spawnSync(
        process.execPath,
        ["scripts/sample-vault.mjs", fixture, String(count)],
        { stdio: "pipe" },
      ).status,
      0,
    );
    let sourceBytes = 0;
    for (const sub of ["Notes", "images"])
      for (const file of await readdir(path.join(fixture, sub))) {
        const bytes = await readFile(path.join(fixture, sub, file));
        sourceBytes += bytes.length;
        await bucket.put(`${vaultId}/source/${sub}/${file}`, bytes);
      }
    const phases: unknown[] = [];
    const request = async (route: string, body?: unknown, token = admin) => {
      const response = await mf.dispatchFetch(
        "https://synthetic.example.invalid" + route,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
      );
      return { status: response.status, body: (await response.json()) as any };
    };
    const drive = async (force = false) => {
      const start = await request(force ? "/reindex" : "/index", {
        newScan: true,
      });
      assert.equal(start.status, 200);
      let job = start.body.data;
      for (
        let step = 0;
        step < 12000 && !["complete", "failed"].includes(job.state);
        step++
      ) {
        const result = await request(`/jobs/${job.jobId}/advance`, {
          checkpoint: job.checkpoint,
        });
        assert.equal(result.status, 200);
        job = result.body.data;
      }
      assert(
        ["complete", "failed"].includes(job.state),
        "checkpoint bound exceeded",
      );
      return job;
    };
    const phase = async (name: string, operation: () => Promise<unknown>) => {
      await db.prepare("DELETE FROM synthetic_telemetry").run();
      const started = performance.now();
      const result = await operation();
      const wallMs = Math.round(performance.now() - started);
      const rows = (
        await db
          .prepare("SELECT * FROM synthetic_telemetry")
          .all<{ kind: string; wall_ms: number; counts: string }>()
      ).results;
      const totals: Record<string, number> = {};
      for (const row of rows)
        for (const [key, value] of Object.entries(JSON.parse(row.counts)))
          totals[key] = (totals[key] ?? 0) + Number(value);
      phases.push({
        name,
        wallMs,
        invocations: rows.length,
        maxInvocationWallMs: Math.max(0, ...rows.map((r) => r.wall_ms)),
        totals,
        result,
      });
      console.log(
        JSON.stringify({
          notes: count,
          phase: name,
          wallMs,
          invocations: rows.length,
        }),
      );
    };
    await phase("initial-index", async () => {
      const job = await drive();
      if (count === 1000) {
        assert.equal(job.state, "failed");
        assert.equal(job.error.code, "INDEX_BUDGET_EXCEEDED");
      } else assert.equal(job.state, "complete", job.error?.code);
      return {
        state: job.state,
        error: job.error?.code ?? null,
        checkpoints: job.checkpoint,
      };
    });
    if (count !== 1000) {
      const id = await noteIdFromPath("Notes/Note-0000.md");
      await phase("lexical-search-20", async () => {
        for (let n = 0; n < 20; n++) {
          const r = await request(
            "/search",
            { query: n % 2 ? "果樹園" : "apple", mode: "lexical", limit: 5 },
            read,
          );
          assert.equal(r.status, 200);
          assert(r.body.data.results.length > 0);
        }
      });
      await phase("explicit-get-20", async () => {
        for (let n = 0; n < 20; n++)
          assert.equal(
            (await request(`/notes/${id}`, undefined, read)).status,
            200,
          );
      });
      await bucket.put(
        `${vaultId}/source/Notes/Note-0000.md`,
        "# Changed orchard\nSynthetic changedmarker apples. 日本語の剪定。\n",
      );
      await phase("one-file-update", async () => {
        const job = await drive();
        assert.equal(job.state, "complete", job.error?.code);
        return { checkpoints: job.checkpoint };
      });
      await phase("rebuild", async () => {
        const job = await drive(true);
        assert.equal(job.state, "complete", job.error?.code);
        return { checkpoints: job.checkpoint };
      });
      await bucket.delete(`${vaultId}/source/Notes/Note-0000.md`);
      await phase("deletion", async () => {
        const job = await drive();
        assert.equal(job.state, "complete", job.error?.code);
        assert.equal(
          (await request(`/notes/${id}`, undefined, read)).status,
          404,
        );
        assert.equal(
          (await request(`/chunks/${id}/0`, undefined, read)).status,
          404,
        );
        return { checkpoints: job.checkpoint, staleRetrievalRevoked: true };
      });
      await phase("idle-reconciliation", async () => {
        assert.equal((await request("/__tick")).status, 200);
      });
    }
    const stats = await db
      .prepare(
        "SELECT (SELECT count(*) FROM notes) AS retainedNotes,(SELECT count(*) FROM chunks) AS retainedChunks,(SELECT count(*) FROM grams) AS retainedGrams,(SELECT count(*) FROM snapshots) AS snapshots",
      )
      .first();
    let cursor: string | undefined,
      objectCount = 0,
      objectBytes = 0;
    do {
      const page = await bucket.list({ cursor });
      for (const o of page.objects) {
        objectCount++;
        objectBytes += o.size;
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    (report.workloads as unknown[]).push({
      notes: count,
      sourceBytes,
      directSourcePuts: count + 2,
      phases,
      retained: { ...stats, r2Objects: objectCount, r2Bytes: objectBytes },
    });
    await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
  } finally {
    await mf.dispose();
    await rm(dir, { recursive: true, force: true });
  }
}

// Matched synthetic workerd comparison; no remote credentials or services.
// Run from packages/cloudflare: npx tsx scripts/benchmark-idle.ts BASE_REF REPORT
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { execFileSync } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import assert from "node:assert/strict";
const [ref, reportFile] = process.argv.slice(2);
assert(ref && reportFile, "Usage: benchmark-idle.ts BASE_REF REPORT_JSON");
assert(/^[a-f0-9]{7,40}$/.test(ref), "Use an immutable baseline commit");
const baseline = execFileSync("git", ["rev-parse", ref], {
  encoding: "utf8",
}).trim();
const migrations = await Promise.all(
  (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort()
    .map(async (n) => await readFile("migrations/" + n, "utf8")),
);
const report = {
  date: new Date().toISOString(),
  runtime: "local-workerd",
  baseline,
  fixture: "one small synthetic note per entry; no attachments",
  cpuMs: null,
  peakMemoryBytes: null,
  hosted: false,
  repetitions: 3,
  workloads: [] as unknown[],
};
for (const variant of ["baseline", "optimized"]) {
  const bundle = await build({
    entryPoints: ["test/idle-worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    tsconfig: "tsconfig.json",
    plugins:
      variant === "baseline"
        ? [
            {
              name: "immutable-baseline",
              setup(b) {
                b.onLoad(
                  { filter: /\/src\/(ingestion|service|mcp)\.ts$/ },
                  async (args) => ({
                    contents: execFileSync(
                      "git",
                      [
                        "show",
                        `${baseline}:packages/cloudflare/src/${args.path.split("/").at(-1)}`,
                      ],
                      { encoding: "utf8" },
                    ),
                    loader: "ts",
                  }),
                );
              },
            },
          ]
        : [],
  });
  for (const notes of [0, 1, 99, 101]) {
    const token = randomBytes(32).toString("hex"),
      vaultId = randomUUID();
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundle.outputFiles[0]!.text,
        compatibilityDate: "2026-10-28",
        d1Databases: { DB: "idle-benchmark" },
        r2Buckets: { SOURCE: "idle-benchmark" },
        ratelimits: {
          REQUEST_LIMITER: {
            namespace_id: "1043",
            simple: { limit: 100000, period: 60 },
          },
        },
        bindings: {
          VAULT_ID: vaultId,
          READ_TOKEN: randomBytes(32).toString("hex"),
          ADMIN_TOKEN: token,
          INCLUDE_PATHS: '["Notes","images"]',
          EXCLUDE_PATHS: "[]",
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
      for (const migration of migrations)
        for (const sql of migration
          .replace(/--[^\n]*/g, "")
          .split(";")
          .filter((s) => s.trim()))
          await db.prepare(sql).run();
      for (let n = 0; n < notes; n++)
        await bucket.put(
          `${vaultId}/source/Notes/Note-${String(n).padStart(4, "0")}.md`,
          `# Orchard ${n}\nSynthetic orchard apples.`,
        );
      async function request(route: string, body?: unknown) {
        const r = await mf.dispatchFetch(
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
        assert.equal(r.status, 200);
        return (await r.json()) as any;
      }
      let job = (await request("/index", {})).data;
      for (
        let n = 0;
        n < 3000 && !["complete", "failed"].includes(job.state);
        n++
      )
        job = (
          await request(`/jobs/${job.jobId}/advance`, {
            checkpoint: job.checkpoint,
          })
        ).data;
      assert.equal(job.state, "complete");
      const samples = [];
      for (let n = 0; n < 3; n++) {
        const sample = await request("/__idle");
        if (variant === "optimized") {
          assert.equal(sample.counts.rowsWritten, 0);
          assert.equal(sample.mutatingStatements, 0);
        }
        samples.push(sample);
      }
      report.workloads.push({ variant, notes, samples });
      await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n");
      console.log(
        JSON.stringify({
          variant,
          notes,
          writes: samples.map((s) => s.counts.rowsWritten),
        }),
      );
    } finally {
      await mf.dispose();
    }
  }
}

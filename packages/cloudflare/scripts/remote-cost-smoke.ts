// Native-binding measurements on an instrumented disposable synthetic Worker.
// Args: private state JSON, report JSON, config JSONC, initial|update|rebuild|delete|search|get.
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { noteIdFromPath } from "../../core/src/portable/identifiers.js";
const execute = promisify(execFile);
const state = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const reportFile = process.argv[3]!,
  config = process.argv[4]!,
  phase = process.argv[5]!;
assert(/^vault-agent-trial-[a-f0-9]{10}$/.test(state.name));
assert(
  ["initial", "update", "rebuild", "delete", "search", "get"].includes(phase),
);
const settings = JSON.parse(await readFile(config, "utf8"));
assert.equal(settings.name, state.name);
assert(
  settings.main.endsWith("test/remote-ingestion-worker.ts"),
  "Use only the instrumented synthetic entrypoint",
);
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  hosted: true,
  phase,
  passed: false,
  checkpoints: 0,
  cpuMs: null,
  peakMemoryBytes: null,
};
const started = Date.now();
async function sql(command: string) {
  const { stdout } = await execute(
    process.execPath,
    [
      wrangler,
      "d1",
      "execute",
      "DB",
      "--remote",
      "--config",
      config,
      "--command",
      command,
      "--json",
    ],
    {
      env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout)[0].results as Record<string, unknown>[];
}
async function call(route: string, body?: unknown) {
  const r = await fetch(state.endpoint + route, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${state.adminToken}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const result = (await r.json()) as any;
  return { status: r.status, body: result };
}
async function drive(job: any) {
  for (
    let n = 0;
    n < 12000 && !["complete", "failed"].includes(job.state);
    n++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const r = await call(`/jobs/${job.jobId}/advance`, {
      checkpoint: job.checkpoint,
    });
    assert.equal(r.status, 200, r.body.error?.code);
    job = r.body.data;
    report.checkpoints = Number(report.checkpoints) + 1;
    if (Number(report.checkpoints) % 100 === 0)
      console.log(
        JSON.stringify({
          phase,
          checkpoints: report.checkpoints,
          state: job.state,
        }),
      );
  }
  assert.equal(job.state, "complete", job.error?.code);
  return job;
}
try {
  // Complete already-admitted Cron work before beginning the measured phase.
  const current = await call("/status");
  const pending = current.body.data?.deployment?.activeJobId;
  if (pending) await drive((await call(`/jobs/${pending}`)).body.data);
  report.checkpoints = 0;
  await sql("DELETE FROM synthetic_telemetry");
  const measuredStart = Date.now();
  report.measuredStartedAt = new Date(measuredStart).toISOString();
  if (["search", "get"].includes(phase)) {
    const id = await noteIdFromPath("Notes/Note-0000.md");
    for (let n = 0; n < 20; n++) {
      const r =
        phase === "get"
          ? await call(`/notes/${id}`)
          : await call("/search", {
              query: n % 2 ? "果樹園" : "apple",
              mode: "lexical",
              limit: 5,
            });
      assert.equal(r.status, 200);
      if (phase === "search") assert(r.body.data.results.length > 0);
    }
    report.operations = 20;
  } else {
    const created = await call(phase === "rebuild" ? "/reindex" : "/index", {
      newScan: true,
    });
    assert.equal(created.status, 200, created.body.error?.code);
    const complete = await drive(created.body.data);
    report.notes = complete.notesIndexed;
    report.chunks = complete.chunksIndexed;
  }
  if (!["delete", "search", "get"].includes(phase)) {
    const result = await call("/search", {
      query: "apple",
      mode: "lexical",
      limit: 5,
    });
    assert.equal(result.status, 200);
    assert(result.body.data.results.length > 0);
    const note = await call(`/notes/${result.body.data.results[0].noteId}`);
    assert.equal(note.status, 200);
  }
  if (phase === "delete") {
    const id = await noteIdFromPath("Notes/Note-0000.md");
    assert.equal((await call(`/notes/${id}`)).status, 404);
    assert.equal((await call(`/chunks/${id}/0`)).status, 404);
    report.staleRetrievalRevoked = true;
  }
  report.measuredEndedAt = new Date().toISOString();
  const rows = await sql("SELECT kind,wall_ms,counts FROM synthetic_telemetry");
  const totals: Record<string, number> = {};
  for (const row of rows)
    for (const [key, value] of Object.entries(JSON.parse(String(row.counts))))
      totals[key] = (totals[key] ?? 0) + Number(value);
  report.invocations = rows.length;
  report.scheduledInvocations = rows.filter(
    (r) => r.kind === "scheduled",
  ).length;
  report.maxInvocationWallMs = Math.max(
    0,
    ...rows.map((r) => Number(r.wall_ms)),
  );
  report.totals = totals;
  report.measuredWallMs = Date.now() - measuredStart;
  report.passed = true;
  console.log(
    JSON.stringify({
      phase,
      passed: true,
      notes: report.notes,
      checkpoints: report.checkpoints,
      rowsWritten: totals.rowsWritten,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      phase,
      passed: false,
      errorType: error instanceof Error ? error.name : "unknown",
    }),
  );
  process.exitCode = 1;
} finally {
  report.elapsedMs = Date.now() - started;
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
}

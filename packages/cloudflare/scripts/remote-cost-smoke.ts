// Native-binding measurements on an instrumented disposable synthetic Worker.
// Args: private state JSON, report JSON, config JSONC, initial|update|rebuild|delete|search|get.
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import path from "node:path";
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
const scheduledDriver = process.argv.includes("--scheduled-driver");
const resume = process.argv.includes("--resume");
const settings = JSON.parse(await readFile(config, "utf8"));
assert.equal(settings.name, state.name);
assert(
  ["test/remote-ingestion-worker.ts", "test/remote-retention-worker.ts"].some(
    (entry) => settings.main.endsWith(entry),
  ),
  "Use only a synthetic instrumentation entrypoint",
);
if (scheduledDriver)
  assert(settings.main.endsWith("test/remote-retention-worker.ts"));

const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  hosted: true,
  phase,
  driver: scheduledDriver
    ? "synthetic-http-production-tick"
    : "http-single-checkpoint",
  retries: 0,
  passed: false,
  checkpoints: 0,
  cpuMs: null,
  peakMemoryBytes: null,
};
if (resume) {
  const prior = JSON.parse(await readFile(reportFile, "utf8"));
  assert.equal(prior.phase, phase);
  assert.equal(prior.passed, false);
  Object.assign(report, prior, {
    previousDriver: prior.driver,
    driver: scheduledDriver
      ? "synthetic-http-production-tick"
      : "http-single-checkpoint",
    resumed: true,
    passed: false,
    knownTelemetryGap: true,
  });
}
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
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_LOG_PATH:
          process.env.WRANGLER_LOG_PATH ??
          path.join(path.dirname(path.resolve(reportFile)), "wrangler-logs"),
      },
      timeout: 60000,
      maxBuffer: 8 * 1024 * 1024,
    },
  );
  return JSON.parse(stdout)[0].results as Record<string, unknown>[];
}
async function call(route: string, body?: unknown) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let r: Response;
    try {
      r = await fetch(state.endpoint + route, {
        method: body === undefined ? "GET" : "POST",
        redirect: "error",
        headers: {
          Authorization: `Bearer ${state.adminToken}`,
          "Content-Type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (error) {
      const safe =
        body === undefined ||
        route === "/search" ||
        /^\/jobs\/[^/]+\/advance$/.test(route);
      if (!safe || attempt === 2) throw error;
      report.retries = Number(report.retries) + 1;
      report.knownTelemetryGap = true;
      await new Promise((resolve) => setTimeout(resolve, (attempt + 1) * 1000));
      continue;
    }
    if (r.status === 429 && attempt < 2) {
      const seconds = Number(r.headers.get("Retry-After") ?? 60);
      if (!Number.isFinite(seconds) || seconds < 0 || seconds > 300)
        throw new Error("Rate limit requires operator retry");
      report.retries = Number(report.retries) + 1;
      await r.body?.cancel();
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(1000, seconds * 1000)),
      );
      continue;
    }
    const result = r.headers.get("Content-Type")?.includes("json")
      ? ((await r.json()) as any)
      : {};
    if (r.status >= 400) {
      report.lastHttpStatus = r.status;
      if (/^[A-Z_]{1,64}$/.test(result.error?.code ?? ""))
        report.errorCode = result.error.code;
    }
    return { status: r.status, body: result };
  }
  throw new Error("Request retry budget exhausted");
}
async function drive(job: any) {
  for (
    let n = 0;
    n < 12000 && !["complete", "failed"].includes(job.state);
    n++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    if (scheduledDriver) {
      const tick = await call("/__retention/tick", {});
      assert.equal(tick.status, 200, tick.body.error?.code);
      report.tickInvocations = Number(report.tickInvocations ?? 0) + 1;
      const r = await call(`/jobs/${job.jobId}`);
      assert.equal(r.status, 200, r.body.error?.code);
      job = r.body.data;
    } else {
      const r = await call(`/jobs/${job.jobId}/advance`, {
        checkpoint: job.checkpoint,
      });
      assert.equal(r.status, 200, r.body.error?.code);
      job = r.body.data;
    }
    report.jobCheckpoints = job.checkpoint;
    report.checkpoints = Number(report.checkpoints) + 1;
    if (Number(report.checkpoints) % (scheduledDriver ? 10 : 100) === 0)
      console.log(
        JSON.stringify({
          phase,
          checkpoints: report.checkpoints,
          state: job.state,
        }),
      );
  }
  if (job.error?.code) report.errorCode = job.error.code;
  assert.equal(job.state, "complete", job.error?.code);
  return job;
}
try {
  // Complete already-admitted Cron work before beginning the measured phase.
  const current = await call("/status");
  const pending = current.body.data?.deployment?.activeJobId;
  if (pending && !resume)
    await drive((await call(`/jobs/${pending}`)).body.data);
  if (!resume) {
    report.checkpoints = 0;
    await sql("DELETE FROM synthetic_telemetry");
  }
  const measuredStart = resume
    ? Date.parse(String(report.measuredStartedAt))
    : Date.now();
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
    const jobId =
      current.body.data?.deployment?.activeJobId ??
      current.body.data?.deployment?.detection?.lastJobId;
    if (resume)
      assert(jobId, "No matching job to resume in this isolated deployment");
    const created = resume
      ? await call(`/jobs/${jobId}`)
      : await call(phase === "rebuild" ? "/reindex" : "/index", {
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
  if (error && typeof error === "object" && "stderr" in error) {
    await writeFile(reportFile + ".private-error.log", String(error.stderr), {
      mode: 0o600,
    });
    report.operatorCommandFailed = true;
  }
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

import fs from "node:fs/promises";
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";

async function main() {
  // Args: private trial state JSON, report JSON, phase. No provider credentials in reports.
  const stateFile = process.argv[2],
    reportFile = process.argv[3];
  assert(
    stateFile && reportFile,
    "Provide private trial state and report files",
  );
  const state = JSON.parse(await fs.readFile(stateFile, "utf8"));
  assert(/^vault-agent-trial-[a-f0-9]{10}$/.test(state.name));
  assert(new URL(state.endpoint).hostname.startsWith(state.name + "."));
  const phase = process.argv[4] ?? "probe";
  assert(
    [
      "probe",
      "seed",
      "purge",
      "baseline-initial",
      "baseline-update",
      "candidate-restore",
      "candidate-update",
    ].includes(phase),
  );
  assert.equal(new URL(state.endpoint).protocol, "https:");
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const id = createHash("sha256")
    .update("Notes/Note-0000.md")
    .digest("hex")
    .slice(0, 32);
  let lastFailure = null;
  async function call(route, body, read = false) {
    const r = await fetch(state.endpoint + route, {
      method: body === undefined ? "GET" : "POST",
      redirect: "error",
      headers: {
        Authorization: "Bearer " + (read ? state.readToken : state.adminToken),
        "Content-Type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30000),
    });
    const b = r.headers.get("content-type")?.includes("json")
      ? await r.json()
      : {};
    if (r.status >= 400)
      lastFailure = {
        status: r.status,
        code: /^[A-Z0-9_]{1,64}$/.test(b.error?.code ?? "")
          ? b.error.code
          : null,
      };
    return { status: r.status, body: b };
  }
  const ok = (r) => {
    assert.equal(r.status, 200, r.body.error?.code ?? "HTTP_" + r.status);
    return r.body;
  };
  const note = () => call("/notes/" + id, undefined, true);
  const search = () =>
    call(
      "/search",
      { query: "revisionmarker", mode: "lexical", limit: 10 },
      true,
    );
  if (phase === "probe") {
    ok(await call("/__verify/probe"));
    console.log(JSON.stringify({ phase, passed: true }));
    process.exit(0);
  }
  if (phase === "seed") {
    for (let start = 0; start < 100; start += 10) {
      ok(await call("/__verify/seed", { start, count: 10 }));
      if (start % 30 === 0)
        console.log(JSON.stringify({ phase, seeded: start + 10 }));
    }
    console.log(JSON.stringify({ phase, passed: true }));
    process.exit(0);
  }
  if (phase === "purge") {
    let count = 0,
      bytes = 0;
    for (let n = 0; n < 10; n++) {
      const b = ok(await call("/__verify/purge", {}));
      count += b.removed;
      bytes += b.bytes;
      if (!b.removed) {
        console.log(
          JSON.stringify({ phase, removed: count, bytes, empty: true }),
        );
        process.exit(0);
      }
    }
    throw Error("Purge incomplete");
  }
  const report = {
    date: new Date().toISOString(),
    phase,
    hosted: true,
    synthetic: true,
    notes: 100,
    chunks: 200,
    noteBytes: 1521,
    semantic: false,
    cron: false,
    driver: "synthetic-http-production-tick",
    tickPauseMs: 1000,
    readPollPauseMs: 5000,
    cpuMs: null,
    peakMemoryBytes: null,
    passed: false,
    readChecks: 0,
    readErrors: [],
    unexpectedBody: false,
    firstNewBodyMs: null,
    firstMarkerSearchMs: null,
  };
  let started = 0,
    done = false,
    observer;
  try {
    const initial = phase === "baseline-initial";
    let oldBody = null,
      targetBody = null;
    if (!initial) {
      oldBody = ok(await note()).data.content;
      const base = oldBody.replace(/\nSynthetic revisionmarker 改訂\.\n$/, "");
      targetBody =
        phase === "candidate-restore"
          ? base
          : base + "\nSynthetic revisionmarker 改訂.\n";
    }
    ok(await call("/__verify/reset", {}));
    if (!initial)
      ok(
        await call("/__verify/change", {
          kind: phase === "candidate-restore" ? "restore" : "update",
        }),
      );
    started = performance.now();
    report.startedAt = new Date().toISOString();
    if (!initial)
      observer = (async () => {
        while (!done) {
          try {
            const r = await note();
            report.readChecks++;
            if (r.status !== 200)
              report.readErrors.push({
                operation: "get",
                status: r.status,
                code: r.body.error?.code,
              });
            else {
              const text = r.body.data.content;
              if (text !== oldBody && text !== targetBody)
                report.unexpectedBody = true;
              if (text === targetBody && report.firstNewBodyMs === null)
                report.firstNewBodyMs = performance.now() - started;
            }
            const s = await search();
            report.readChecks++;
            if (s.status !== 200)
              report.readErrors.push({
                operation: "search",
                status: s.status,
                code: s.body.error?.code,
              });
            else if (
              r.status === 200 &&
              r.body.data.content === targetBody &&
              s.body.data.results.some((r) => r.noteId === id) &&
              report.firstMarkerSearchMs === null
            )
              report.firstMarkerSearchMs = performance.now() - started;
          } catch (e) {
            report.readErrors.push({ operation: "poll", type: e.name });
          }
          if (!done) await sleep(5000);
        }
      })();
    let job = ok(await call("/index", { newScan: true })).data;
    report.jobId = job.jobId;
    let ticks = 0;
    while (!["complete", "failed"].includes(job.state) && ticks < 200) {
      await sleep(1000);
      ok(await call("/__retention/tick", {}));
      job = ok(await call("/jobs/" + job.jobId)).data;
      ticks++;
      if (ticks % 10 === 0)
        console.log(
          JSON.stringify({
            phase,
            ticks,
            state: job.state,
            checkpoint: job.checkpoint,
          }),
        );
    }
    report.publicationMs = performance.now() - started;
    report.tickInvocations = ticks;
    report.jobCheckpoints = job.checkpoint;
    report.updatePath = job.updatePath ?? "legacy-full-snapshot";
    report.jobError = job.error?.code ?? null;
    assert.equal(job.state, "complete", job.error?.code ?? job.state);
    assert.equal(job.notesIndexed, 100);
    assert.equal(job.chunksIndexed, 200);
    const final = ok(await note());
    if (!initial) assert.equal(final.data.content, targetBody);
    report.exactBodyVerified = true;
    report.publicSnapshot = final.revision.snapshot;
    const s = ok(await search());
    if (phase !== "candidate-restore" && !initial)
      assert(s.data.results.some((r) => r.noteId === id));
    report.completedVerificationMs = performance.now() - started;
    if (!initial && report.firstNewBodyMs === null)
      report.firstNewBodyMs = report.completedVerificationMs;
    if (
      phase !== "candidate-restore" &&
      !initial &&
      report.firstMarkerSearchMs === null
    )
      report.firstMarkerSearchMs = report.completedVerificationMs;
    done = true;
    if (observer) await observer;
    assert.equal(report.unexpectedBody, false);
    assert(
      report.readErrors.every(
        (e) => e.status === 409 && e.code === "REVISION_CHANGED",
      ),
    );
    const telemetry = ok(await call("/__verify/telemetry")).rows;
    report.invocations = telemetry.length;
    report.totals = {};
    report.byKind = {};
    for (const row of telemetry) {
      const counts = JSON.parse(row.counts);
      const group = (report.byKind[row.kind] ??= {
        invocations: 0,
        totals: {},
      });
      group.invocations++;
      for (const [k, v] of Object.entries(counts)) {
        report.totals[k] = (report.totals[k] ?? 0) + v;
        group.totals[k] = (group.totals[k] ?? 0) + v;
      }
    }
    report.maxInvocationWallMs = Math.max(...telemetry.map((r) => r.wall_ms));
    report.passed = true;
  } catch (e) {
    report.lastHttpFailure = lastFailure;
    report.errorType = e.name;
    report.errorCode = /^[A-Z_0-9]{1,64}$/.test(e.message) ? e.message : null;
    process.exitCode = 1;
  } finally {
    done = true;
    if (observer) await observer;
    await fs.writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", {
      mode: 0o600,
    });
    console.log(
      JSON.stringify({
        phase,
        passed: report.passed,
        publicationMs: report.publicationMs,
        jobError: report.jobError,
        reads: report.readChecks,
        readErrors: report.readErrors.length,
        rowsWritten: report.totals?.rowsWritten,
        r2Put: report.totals?.r2Put,
      }),
    );
  }
}

main().catch((error) => {
  console.error(
    JSON.stringify({
      passed: false,
      errorType: error.name,
      errorCode: /^[A-Z0-9_]{1,64}$/.test(error.code ?? "") ? error.code : null,
    }),
  );
  process.exitCode = 1;
});

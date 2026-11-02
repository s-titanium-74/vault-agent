// Disposable synthetic remote-update-worker only; never run against an existing vault.
// Args: private state JSON, public report JSON, prepare|idle|update|restore|cron-update|cron-idle|maintenance.
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { noteIdFromPath } from "../../core/src/portable/identifiers.js";
const [stateFile, reportFile, stage] = process.argv.slice(2);
assert(stateFile && reportFile && stage);
assert(
  [
    "prepare",
    "idle",
    "update",
    "restore",
    "cron-update",
    "cron-idle",
    "maintenance",
  ].includes(stage),
);
const state = JSON.parse(await readFile(stateFile, "utf8"));
assert(/^vault-agent-trial-[a-f0-9]{10}$/.test(state.name));
const endpoint = new URL(state.endpoint);
assert(
  endpoint.protocol === "https:" &&
    endpoint.hostname.startsWith(state.name + "."),
);
const report = JSON.parse(
  await readFile(reportFile, "utf8").catch(() =>
    JSON.stringify({
      date: new Date().toISOString(),
      runtime: "hosted",
      semantic: false,
      cpuMs: null,
      peakMemoryBytes: null,
      phases: [],
      counterBoundary:
        "Production operations only; synthetic telemetry receipt/reset writes are excluded. No private content.",
    }),
  ),
);
async function call(route: string, body?: unknown) {
  const response = await fetch(state.endpoint + route, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${state.adminToken}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(
    response.status,
    200,
    `Synthetic endpoint failed: ${response.status}`,
  );
  return (await response.json()) as any;
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const noteId = await noteIdFromPath("Notes/Note-0000.md");
await call("/__verify/probe");
await call("/__verify/reset", {});
const started = Date.now();
const oldRevision = (await call("/status")).data.deployment.activeRevision;
let sourceAcknowledgedAt: number | null = null;
let publicationObservedMs: number | null = null;
if (stage === "prepare") {
  for (let start = 0; start < 100; start += 10)
    await call("/__verify/seed", { start, count: 10 });
  await call("/index", {});
} else if (["update", "restore", "cron-update"].includes(stage)) {
  await call("/__verify/change", {
    kind: stage === "restore" ? "restore" : "update",
  });
  sourceAcknowledgedAt = Date.now();
}
if (stage === "idle" || stage === "maintenance") {
  for (let n = 0; n < 3; n++) {
    await call("/__retention/tick", {});
    await pause(1000);
  }
} else if (stage === "cron-idle") {
  // Capture at least three actual scheduled invocations; status requests do not advance jobs.
  for (let n = 0; n < 60; n++) {
    await pause(10000);
    const rows = (await call("/__verify/telemetry")).rows.filter(
      (r: any) => r.kind === "scheduled",
    );
    if (rows.length >= 3) break;
  }
} else {
  let complete = false;
  for (let n = 0; n < (stage === "cron-update" ? 90 : 500); n++) {
    if (stage === "cron-update") await pause(10000);
    else {
      await call("/__retention/tick", {});
      await pause(1000);
    }
    const status = (await call("/status")).data.deployment;
    assert(!status.detection.error, "Synthetic reconciliation failed");
    if (
      !status.activeJobId &&
      status.activeRevision &&
      (stage === "prepare" || status.activeRevision !== oldRevision)
    ) {
      complete = true;
      publicationObservedMs = Date.now() - (sourceAcknowledgedAt ?? started);
      break;
    }
  }
  assert(
    complete,
    "Synthetic publication did not complete within the bounded observation window",
  );
}
const status = (await call("/status")).data;
if (stage !== "prepare")
  assert.equal(
    status.deployment.activeRevision === oldRevision,
    stage.endsWith("idle") || stage === "maintenance",
  );
const body = (await call(`/notes/${noteId}`)).data.content as string;
if (["update", "restore", "cron-update"].includes(stage))
  assert.equal(body.includes("revisionmarker"), stage !== "restore");
const search = await call("/search", {
  query: "orchard",
  mode: "lexical",
  limit: 5,
});
assert(search.data.results.length > 0);
assert.equal(status.deployment.detection.state, "idle");
assert.equal(status.index.freshness.state, "unknown");
const rows = (await call("/__verify/telemetry")).rows;
const ticks = rows
  .filter((r: any) => ["scheduled", "retention-tick"].includes(r.kind))
  .map((r: any) => ({
    kind: r.kind,
    wallMs: r.wall_ms,
    counts: JSON.parse(r.counts),
  }));
assert(ticks.length > 0);
if (stage.endsWith("idle")) {
  assert(ticks.length >= 3);
  for (const tick of ticks) assert.equal(tick.counts.rowsWritten, 0);
}
if (stage === "maintenance") {
  assert(
    ticks.some((tick: any) => tick.counts.rowsWritten > 0),
    "Seed an eligible synthetic cache entry before this phase",
  );
  for (const tick of ticks.slice(-2)) assert.equal(tick.counts.rowsWritten, 0);
}
report.phases.push({
  stage,
  wallMs: Date.now() - started,
  publicationObservedMs,
  searchHits: search.data.results.length,
  ticks,
  passed: true,
});
await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", {
  mode: 0o600,
});
console.log(
  JSON.stringify({
    stage,
    passed: true,
    publicationObservedMs,
    tickWrites: ticks.map((r: any) => r.counts.rowsWritten),
  }),
);

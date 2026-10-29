// Run only against a new disposable deployment with synthetic sources.
// Args: private operator state JSON, report JSON, rebuild|index|wait-deleted.
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { noteIdFromPath } from "../../core/src/portable/identifiers.js";
const state = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const reportFile = process.argv[3]!;
const mode = process.argv[4]!;
assert(["rebuild", "index", "wait-deleted"].includes(mode));
const report: {
  mode: string;
  passed: boolean;
  checkpoints: number;
  vectorStageCheckpoints: number;
  elapsedMs: number;
  revision?: string;
  initialRevision?: string;
  searchResults?: number;
} = {
  mode,
  passed: false,
  checkpoints: 0,
  vectorStageCheckpoints: 0,
  elapsedMs: 0,
};
const started = Date.now();
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
  const result = (await response.json()) as any;
  return { status: response.status, ...result };
}
async function drive(job: any) {
  for (
    let step = 0;
    step < 600 && !["complete", "failed"].includes(job.state);
    step++
  ) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const result = await call(`/jobs/${job.jobId}/advance`, {
      checkpoint: job.checkpoint,
    });
    assert.equal(result.status, 200, "Job advancement failed");
    report.checkpoints++;
    job = result.data;
    if (job.state === "vectors") report.vectorStageCheckpoints++;
  }
  assert.equal(job.state, "complete", job.error?.code ?? "Job did not finish");
  return job;
}
try {
  if (mode !== "wait-deleted") {
    let complete: any;
    for (let attempt = 0; attempt < 5 && !complete; attempt++) {
      const result = await call(mode === "rebuild" ? "/reindex" : "/index", {
        requireEmbeddings: true,
        newScan: true,
      });
      if (result.status === 409 && result.error?.code === "INDEX_BUSY") {
        const status = await call("/status");
        const id = status.data.deployment.activeJobId;
        await drive((await call(`/jobs/${id}`)).data);
        continue;
      }
      assert.equal(result.status, 200, "Index creation failed");
      complete = await drive(result.data);
    }
    assert(complete, "Index remained busy");
    const status = await call("/status");
    assert.equal(status.status, 200);
    assert.equal(status.data.index.embeddingState, "ready");
    assert.equal(
      status.data.deployment.activeRevision,
      complete.targetRevision,
    );
    report.revision = complete.targetRevision;
    // No search here: external telemetry distinguishes ingestion AI calls from queries.
  } else {
    const noteId = await noteIdFromPath("Notes/Pear.md");
    const before = await call("/status");
    report.initialRevision = before.data.deployment.activeRevision;
    await writeFile(
      reportFile + ".ready",
      JSON.stringify({ readyAt: Date.now(), revision: report.initialRevision }),
      { mode: 0o600 },
    );
    let removed = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      const note = await call(`/notes/${noteId}`);
      if (note.status === 404) {
        removed = true;
        break;
      }
      if (note.status !== 409 || note.error?.code !== "REVISION_CHANGED")
        assert.equal(
          note.status,
          200,
          "Unexpected note response during detection lag",
        );
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
    assert(
      removed,
      "Real Cron did not publish deletion within the observation window",
    );
    assert.equal((await call(`/chunks/${noteId}/0`)).status, 404);
    const status = await call("/status");
    assert.equal(status.data.index.embeddingState, "ready");
    assert.notEqual(
      status.data.deployment.activeRevision,
      report.initialRevision,
    );
    report.revision = status.data.deployment.activeRevision;
    const search = await call("/search", {
      query: "pear trees and fruit orchards",
      mode: "embedding",
      limit: 10,
    });
    assert.equal(search.status, 200, "Embedding search failed after deletion");
    assert.equal(search.data.results.length, 1);
    assert(search.data.results.every((r: any) => r.noteId !== noteId));
    report.searchResults = search.data.results.length;
  }
  report.passed = true;
} catch (error) {
  // Assertions and error types only; never emit provider bodies, source data or credentials.
  console.error(
    JSON.stringify({
      passed: false,
      mode,
      errorType: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : "failed",
    }),
  );
  process.exitCode = 1;
} finally {
  report.elapsedMs = Date.now() - started;
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify(report));
}

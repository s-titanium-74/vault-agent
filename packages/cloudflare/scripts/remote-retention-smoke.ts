// Synthetic-only age-equivalent retention test, not a 24-hour wall-clock wait.
// Args: private state JSON, report JSON, config, --age-synthetic-data.
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import assert from "node:assert/strict";
import { noteIdFromPath } from "../../core/src/portable/identifiers.js";
const execute = promisify(execFile);
const state = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const reportFile = process.argv[3]!,
  configFile = process.argv[4]!;
assert(process.argv.includes("--age-synthetic-data"));
assert(/^vault-agent-trial-[a-f0-9]{10}$/.test(state.name));
const config = JSON.parse(await readFile(configFile, "utf8"));
assert.equal(config.name, state.name);
assert.equal(config.vars.VAULT_ID, state.vaultId);
assert.equal(config.vars.SYNTHETIC_RETENTION, "true");
assert(config.main.endsWith("test/remote-retention-worker.ts"));
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const env = {
  ...process.env,
  WRANGLER_SEND_METRICS: "false",
  WRANGLER_LOG_PATH: path.join(
    path.dirname(path.resolve(reportFile)),
    "wrangler-logs",
  ),
};
const quote = (v: string) => "'" + v.replaceAll("'", "''") + "'";
const report: Record<string, unknown> = {
  date: new Date().toISOString(),
  passed: false,
  hosted: true,
  driver: "authenticated-synthetic-production-tick",
  ageEquivalent: true,
  elapsed24Hours: false,
  steps: 0,
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
      configFile,
      "--command",
      command,
      "--json",
    ],
    { env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 },
  );
  return JSON.parse(stdout)[0].results as any[];
}
async function tick() {
  const r = await fetch(state.endpoint + "/__retention/tick", {
    method: "POST",
    headers: { Authorization: `Bearer ${state.adminToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(r.status, 200);
  await r.body?.cancel();
  report.steps = Number(report.steps) + 1;
  if (Number(report.steps) % 5 === 0)
    console.log(JSON.stringify({ retentionSteps: report.steps }));
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
async function object(relative: string, expectMissing = false) {
  const file = path.join(path.dirname(reportFile), "retention-object.tmp");
  try {
    await execute(
      process.execPath,
      [
        wrangler,
        "r2",
        "object",
        "get",
        `${state.name}/${relative}`,
        "--remote",
        "--file",
        file,
        "--config",
        configFile,
      ],
      { env, timeout: 60000 },
    );
    assert.equal(expectMissing, false);
    return await readFile(file, "utf8");
  } catch (error) {
    if (!expectMissing) throw error;
    const result = error as { stdout?: string; stderr?: string };
    assert(
      /404|not found|does not exist/i.test(
        (result.stdout ?? "") + (result.stderr ?? ""),
      ),
    );
    return null;
  }
}
try {
  report.stage = "prepare";
  const active = (
    await sql(
      "SELECT s.revision,s.manifest FROM snapshots s JOIN deployment d ON s.revision=d.revision WHERE d.id=1",
    )
  )[0];
  assert(active);
  const old = await sql(
    `SELECT revision FROM snapshots WHERE revision<>${quote(active.revision)} ORDER BY created,revision`,
  );
  assert(old.length >= 2);
  for (const row of old) assert(/^[a-f0-9]{64}$/.test(row.revision));
  const young = old.at(-1)!.revision,
    aged = old.slice(0, -1).map((row) => row.revision as string);
  const fence = randomUUID(),
    abandoned = randomUUID(),
    target = randomBytes(32).toString("hex");
  const data = JSON.stringify({
    revision: target,
    parent: active.revision,
    manifest: JSON.parse(active.manifest),
  });
  await sql(
    `INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,lease,lease_until,created) VALUES(${quote(fence)},${quote(fence)},'scan','scanning',${quote(data)},'synthetic-retention-fence',${Date.now() + 3600000},${Date.now()}); UPDATE ingestion_state SET job=${quote(fence)} WHERE id=1; UPDATE snapshots SET created=0 WHERE revision IN (${aged.map(quote).join(",")}); UPDATE snapshots SET created=${Date.now()} WHERE revision=${quote(young)}; INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,created) VALUES(${quote(abandoned)},${quote(abandoned)},'upload','failed',${quote(data)},0); INSERT INTO ingestion_entries(job,path,kind,size,updated) VALUES(${quote(abandoned)},'Notes/Expired.md','note',22,'2026-01-01'); INSERT INTO embedding_cache VALUES('synthetic-retention-orphan','[1]',0); INSERT INTO embedding_cache VALUES('synthetic-retention-reference','[1]',0); INSERT INTO ingestion_vectors(revision,chunk_id,cache_key) VALUES(${quote(active.revision)},'synthetic-retention-reference','synthetic-retention-reference')`,
  );
  const staged = `${state.vaultId}/staging/${abandoned}/Notes/Expired.md`,
    file = path.join(path.dirname(reportFile), "retention-stage.tmp");
  await writeFile(file, "synthetic-stage-marker", { mode: 0o600 });
  await execute(
    process.execPath,
    [
      wrangler,
      "r2",
      "object",
      "put",
      `${state.name}/${staged}`,
      "--remote",
      "--file",
      file,
      "--config",
      configFile,
    ],
    { env, timeout: 60000 },
  );
  await sql("DELETE FROM synthetic_telemetry");
  report.agedSnapshots = aged.length;
  report.stage = "expired-snapshots-and-staging";
  let complete = false;
  for (let n = 0; n < 120; n++) {
    await tick();
    const r = (
      await sql(
        `SELECT (SELECT count(*) FROM snapshots WHERE revision IN (${aged.map(quote).join(",")})) AS snapshots,(SELECT count(*) FROM ingestion_jobs WHERE id=${quote(abandoned)}) AS abandoned`,
      )
    )[0];
    if (!r.snapshots && !r.abandoned) {
      complete = true;
      break;
    }
  }
  assert(complete, "Retention step budget exhausted");
  assert.equal(
    (await sql("SELECT revision FROM deployment WHERE id=1"))[0].revision,
    active.revision,
  );
  assert.equal(
    (
      await sql(
        `SELECT count(*) AS n FROM snapshots WHERE revision=${quote(young)}`,
      )
    )[0].n,
    1,
  );
  assert.equal(
    (
      await sql(
        "SELECT count(*) AS n FROM embedding_cache WHERE key='synthetic-retention-orphan'",
      )
    )[0].n,
    1,
  );
  report.orphanCacheProtectedDuringWork = true;
  for (const revision of aged) {
    assert.equal(
      (
        await sql(
          `SELECT count(*) AS n FROM sqlite_master WHERE name=${quote("fts_" + revision)}`,
        )
      )[0].n,
      0,
    );
    await object(`${state.vaultId}/${revision}/Notes/Note-0001.md`, true);
  }
  await object(staged, true);
  assert(
    (await object(`${state.vaultId}/${young}/Notes/Note-0001.md`))!.includes(
      "apple",
    ),
  );
  assert(
    (await object(`${state.vaultId}/source/Notes/Note-0001.md`))!.includes(
      "apple",
    ),
  );
  assert(
    (await object("unrelated/source/Notes/Foreign.md"))!.includes(
      "synthetic unrelated marker",
    ),
  );
  report.youngSnapshotPreserved = true;
  report.mutableSourcePreserved = true;
  report.unrelatedPrefixPreserved = true;
  report.expiredObjectsAndFtsRemoved = true;
  report.stage = "unreferenced-cache";
  await sql(
    `UPDATE ingestion_jobs SET state='complete',lease=NULL,lease_until=0 WHERE id=${quote(fence)}`,
  );
  await tick();
  assert.equal(
    (
      await sql(
        "SELECT count(*) AS n FROM embedding_cache WHERE key='synthetic-retention-orphan'",
      )
    )[0].n,
    0,
  );
  assert.equal(
    (
      await sql(
        "SELECT count(*) AS n FROM embedding_cache WHERE key='synthetic-retention-reference'",
      )
    )[0].n,
    1,
  );
  report.orphanCacheReclaimed = true;
  report.referencedCachePreserved = true;
  assert.equal(
    (await sql("SELECT revision FROM deployment WHERE id=1"))[0].revision,
    active.revision,
  );
  const id = await noteIdFromPath("Notes/Note-0001.md");
  const get = await fetch(state.endpoint + `/notes/${id}`, {
    headers: { Authorization: `Bearer ${state.readToken}` },
    redirect: "error",
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(get.status, 200);
  await get.body?.cancel();
  report.activeRevisionAndRetrievalPreserved = true;
  const rows = await sql(
    "SELECT wall_ms,counts FROM synthetic_telemetry WHERE kind='retention-tick'",
  );
  const totals: Record<string, number> = {};
  for (const row of rows)
    for (const [key, value] of Object.entries(JSON.parse(row.counts)))
      totals[key] = (totals[key] ?? 0) + Number(value);
  report.totals = totals;
  report.maxTickWallMs = Math.max(0, ...rows.map((row) => row.wall_ms));
  report.passed = true;
  console.log(
    JSON.stringify({
      retentionPassed: true,
      steps: report.steps,
      agedSnapshots: report.agedSnapshots,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      retentionPassed: false,
      stage: report.stage,
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

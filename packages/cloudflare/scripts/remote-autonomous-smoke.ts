// Synthetic-only direct R2 mutation test; never run against an existing vault.
// Args: private operator state JSON, report JSON, Wrangler config, --allow-synthetic-r2-writes.
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { noteIdFromPath } from "../../core/src/portable/identifiers.js";
const execute = promisify(execFile);
const stateFile = process.argv[2]!,
  reportFile = process.argv[3]!,
  config = process.argv[4]!;
assert(process.argv.includes("--allow-synthetic-r2-writes"));
const state = JSON.parse(await readFile(stateFile, "utf8"));
assert(
  /^vault-agent-trial-[a-f0-9]{10}$/.test(state.name),
  "Only newly provisioned synthetic trial resources are allowed",
);
const settings = JSON.parse(await readFile(config, "utf8"));
assert.equal(settings.name, state.name);
assert.equal(settings.vars.VAULT_ID, state.vaultId);
assert.equal(settings.r2_buckets[0].bucket_name, state.name);
const wrangler = fileURLToPath(
  new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
);
const report = {
  date: new Date().toISOString(),
  hosted: true,
  driver: "real-cron-no-admin-requests",
  adminRequests: 0,
  directPuts: 0,
  directDeletes: 0,
  pollRequests: 0,
  passed: false,
  phases: [] as unknown[],
};
const pause = () => new Promise((resolve) => setTimeout(resolve, 10000));
async function call(route: string, body?: unknown) {
  report.pollRequests++;
  const r = await fetch(state.endpoint + route, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${state.readToken}`,
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  assert.notEqual(r.status, 429, "Read polling unexpectedly rate limited");
  return { status: r.status, body: (await r.json()) as any };
}
async function put(relative: string, body: string) {
  const file = path.join(path.dirname(stateFile), "direct-source.tmp");
  await writeFile(file, body, { mode: 0o600 });
  await execute(
    process.execPath,
    [
      wrangler,
      "r2",
      "object",
      "put",
      `${state.name}/${state.vaultId}/source/${relative}`,
      "--remote",
      "--file",
      file,
      "--config",
      config,
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, timeout: 90000 },
  );
  report.directPuts++;
}
async function remove(relative: string) {
  await execute(
    process.execPath,
    [
      wrangler,
      "r2",
      "object",
      "delete",
      `${state.name}/${state.vaultId}/source/${relative}`,
      "--remote",
      "--config",
      config,
    ],
    { env: { ...process.env, WRANGLER_SEND_METRICS: "false" }, timeout: 90000 },
  );
  report.directDeletes++;
}
const directId = await noteIdFromPath("Notes/Direct.md"),
  renamedId = await noteIdFromPath("Notes/Renamed.md");
async function phase(
  name: string,
  mutate: () => Promise<void>,
  ready: () => Promise<boolean>,
) {
  const old = (await call("/status")).body.data.deployment;
  const started = Date.now();
  await mutate();
  const written = Date.now();
  let firstUpdatingMs: number | null = null;
  const failures = new Set<string>();
  console.log(JSON.stringify({ phase: name, sourceWriteComplete: true }));
  for (let n = 0; n < 90; n++) {
    await pause();
    const status = await call("/status");
    assert.equal(status.status, 200);
    const deployment = status.body.data.deployment;
    if (firstUpdatingMs === null && deployment.detection?.state === "updating")
      firstUpdatingMs = Date.now() - written;
    if (deployment.detection?.error)
      failures.add(deployment.detection.lastJobId);
    if (deployment.activeRevision !== old.activeRevision && (await ready())) {
      const result = {
        name,
        mutationWallMs: written - started,
        firstUpdatingObservedMs: firstUpdatingMs,
        publicationObservedMs: Date.now() - written,
        failedJobsObserved: failures.size,
      };
      report.phases.push(result);
      await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", {
        mode: 0o600,
      });
      console.log(
        JSON.stringify({
          phase: name,
          passed: true,
          publicationObservedMs: result.publicationObservedMs,
        }),
      );
      return;
    }
  }
  throw new Error(
    "Autonomous publication did not complete within 15-minute observation window",
  );
}
try {
  await phase(
    "direct-create",
    async () => {
      await put(
        "Notes/Direct.md",
        "# Direct\nSynthetic directcreatemarker. [[Orchard]]\n",
      );
      await put("Notes/secret.md", "Synthetic exclusionprobemarker.\n");
    },
    async () => {
      const r = await call(`/notes/${directId}`);
      return (
        r.status === 200 &&
        JSON.stringify(r.body.data).includes("directcreatemarker")
      );
    },
  );
  await phase(
    "direct-overwrite-and-attachment",
    async () => {
      await put(
        "Notes/Direct.md",
        "# Direct\nSynthetic directoverwritemarker. [[Orchard]]\n",
      );
      await put("images/chart.png", "synthetic-direct-image-changed");
    },
    async () => {
      const r = await call(`/notes/${directId}`);
      if (
        r.status !== 200 ||
        !JSON.stringify(r.body.data).includes("directoverwritemarker")
      )
        return false;
      const image = await fetch(
        state.endpoint + "/attachments/images%2Fchart.png?download=true",
        {
          headers: { Authorization: `Bearer ${state.readToken}` },
          redirect: "error",
          signal: AbortSignal.timeout(30000),
        },
      );
      assert.equal(image.status, 200);
      assert.equal(await image.text(), "synthetic-direct-image-changed");
      return true;
    },
  );
  await phase(
    "direct-rename",
    async () => {
      await put(
        "Notes/Renamed.md",
        "# Renamed\nSynthetic directrenamemarker. [[Orchard]]\n",
      );
      await remove("Notes/Direct.md");
    },
    async () => {
      const old = await call(`/notes/${directId}`),
        next = await call(`/notes/${renamedId}`);
      return (
        old.status === 404 &&
        next.status === 200 &&
        JSON.stringify(next.body.data).includes("directrenamemarker")
      );
    },
  );
  assert.equal((await call(`/chunks/${directId}/0`)).status, 404);
  await phase(
    "direct-delete",
    async () => remove("Notes/Renamed.md"),
    async () => (await call(`/notes/${renamedId}`)).status === 404,
  );
  assert.equal((await call(`/chunks/${renamedId}/0`)).status, 404);
  const search = await call("/search", {
    query: "directrenamemarker",
    mode: "lexical",
  });
  assert.equal(search.status, 200);
  assert.equal(search.body.data.results.length, 0);
  const excluded = await call("/search", {
    query: "exclusionprobemarker",
    mode: "lexical",
  });
  assert.equal(excluded.status, 200);
  assert.equal(excluded.body.data.results.length, 0);
  report.passed = true;
  console.log(
    JSON.stringify({
      passed: true,
      phases: report.phases.length,
      adminRequests: 0,
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      passed: false,
      errorType: error instanceof Error ? error.name : "unknown",
    }),
  );
  process.exitCode = 1;
} finally {
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
}

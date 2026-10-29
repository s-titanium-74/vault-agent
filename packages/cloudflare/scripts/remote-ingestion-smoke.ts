// Operate only on an operator-created disposable deployment and synthetic vault.
// Arguments: private state JSON, report JSON. No secrets appear in output.
import { readFile, writeFile, mkdir, rename, unlink } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import assert from "node:assert/strict";
import { noteIdFromPath } from "../../core/src/portable/identifiers.js";
const stateFile = process.argv[2]!,
  reportFile = process.argv[3]!;
const state = JSON.parse(await readFile(stateFile, "utf8"));
const dir = path.dirname(stateFile);
const root = path.join(dir, "vault");
const report: {
  groups: string[];
  requests: number;
  elapsedMs: number;
  checkpoints: number;
  cron?: unknown;
} = { groups: [], requests: 0, elapsedMs: 0, checkpoints: 0 };
const started = Date.now();
async function call(
  route: string,
  method = "GET",
  body?: unknown,
  token = state.readToken,
) {
  report.requests++;
  const r = await fetch(state.endpoint + route, {
    method,
    redirect: "error",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const json = (await r.json()) as any;
  return { status: r.status, ...json };
}
async function upload(deleteRemoved = false) {
  const result = await new Promise<{ code: number | null; output: string }>(
    (resolve) => {
      const child = spawn(
        process.execPath,
        [
          "--import",
          "tsx",
          "packages/cli/src/main.ts",
          "--config",
          path.join(dir, "config.toml"),
          "--endpoint",
          state.endpoint,
          "upload",
          "--vault-id",
          state.vaultId,
          "--include",
          "Notes",
          "images",
          ...(deleteRemoved ? ["--delete-removed"] : []),
        ],
        {
          env: {
            ...process.env,
            VAULT_AGENT_VAULT_ROOT: root,
            VAULT_AGENT_API_KEY: state.adminToken,
            XDG_DATA_HOME: path.join(dir, "user-data"),
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (b) => (output += b));
      child.stderr.on("data", (b) => (output += b));
      child.on("close", (code) => resolve({ code, output }));
    },
  );
  assert.equal(
    result.code,
    0,
    "CLI upload failed: " +
      result.output.replaceAll(state.adminToken, "[redacted]"),
  );
  const resultJson = JSON.parse(result.output);
  assert.equal(resultJson.state, "complete");
  report.checkpoints += resultJson.checkpoint;
}
const passed = async (name: string) => {
  report.groups.push(name);
  report.elapsedMs = Date.now() - started;
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ group: name, passed: true }));
};
try {
  await mkdir(path.join(root, "Notes"), { recursive: true });
  await mkdir(path.join(root, "images"), { recursive: true });
  await writeFile(
    path.join(root, "Notes", "Orchard.md"),
    "# Orchard\nSynthetic apples in a garden. [[Seasons]]\n",
  );
  await writeFile(
    path.join(root, "Notes", "Seasons.md"),
    "# Seasons\nSynthetic winter pruning.\n",
  );
  await writeFile(path.join(root, "images", "chart.png"), "synthetic-image");
  await writeFile(
    path.join(root, "Notes", "secret.md"),
    "synthetic excluded marker",
  );
  // Local exclusions match this disposable deployment's policy.
  const config = path.join(dir, "config.toml");
  await writeFile(
    config,
    "[vault]\nroot = " +
      JSON.stringify(root) +
      '\nexclude = ["**/secret.md"]\n',
    { mode: 0o600 },
  );
  // The child CLI receives its explicit config flag through this environment.
  process.env.VAULT_AGENT_VAULT_ROOT = root;
  await upload();
  const noteId = await noteIdFromPath("Notes/Orchard.md");
  assert.equal((await call(`/notes/${noteId}`)).status, 200);
  const search = await call("/search", "POST", {
    query: "apples",
    mode: "lexical",
    limit: 5,
  });
  assert.equal(search.status, 200);
  assert(search.data.results.some((r: any) => r.path === "Notes/Orchard.md"));
  assert.equal((await call("/attachments/images%2Fchart.png")).status, 200);
  await passed("actual-cli-upload-and-retrieval");
  await writeFile(
    path.join(root, "Notes", "Orchard.md"),
    "# Orchard\nChanged citrus orchard. [[Calendar]]\n",
  );
  await rename(
    path.join(root, "Notes", "Seasons.md"),
    path.join(root, "Notes", "Calendar.md"),
  );
  await upload(true);
  assert.equal(
    (await call(`/notes/${await noteIdFromPath("Notes/Seasons.md")}`)).status,
    404,
  );
  assert.equal(
    (await call(`/chunks/${await noteIdFromPath("Notes/Seasons.md")}/0`))
      .status,
    404,
  );
  assert.equal(
    (await call(`/notes/${await noteIdFromPath("Notes/Calendar.md")}`)).status,
    200,
  );
  await passed("actual-cli-change-rename-delete-and-stale-id-revocation");
  const readOnly = await call("/uploads", "POST", {}, state.readToken);
  assert.equal(readOnly.status, 403);
  await passed("remote-authentication");
  // Direct dashboard/API changes and real Cron progression are tested by the
  // operator between --watch calls using the separate Cloudflare connector.
  if (process.argv.includes("--watch")) {
    const before = (await call("/status")).data.deployment.activeRevision;
    await writeFile(
      path.join(dir, "watch-ready.json"),
      JSON.stringify({ before, readyAt: Date.now() }),
      { mode: 0o600 },
    );
    for (let n = 0; n < 90; n++) {
      await new Promise((r) => setTimeout(r, 10000));
      const result = await call(`/notes/${noteId}`);
      if (
        result.status === 200 &&
        JSON.stringify(result.data).includes("autonomous-cron-marker")
      ) {
        report.cron = {
          elapsedMs: Date.now() - started,
          before,
          after: result.revision?.snapshot,
        };
        await passed("real-cron-direct-r2-overwrite-with-cli-disconnected");
        break;
      }
      if (n === 89)
        throw new Error(
          "Cron did not publish the direct edit within the observation window",
        );
    }
  }
  await unlink(path.join(root, "Notes", "Calendar.md"));
  await upload(true);
  assert.equal(
    (await call(`/notes/${await noteIdFromPath("Notes/Calendar.md")}`)).status,
    404,
  );
  await passed("final-explicit-deletion");
} catch (error) {
  console.error(
    JSON.stringify({
      passed: false,
      errorType: error instanceof Error ? error.name : "unknown",
      message: error instanceof Error ? error.message : "failed",
    }),
  );
  process.exitCode = 1;
} finally {
  report.elapsedMs = Date.now() - started;
  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
}

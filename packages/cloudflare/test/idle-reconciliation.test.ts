import { afterEach, beforeAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import * as core from "../../core/src/portable/index.js";
import { VAULT_ID } from "../scripts/fixture.js";

let script: string;
let mf: Miniflare;
let db: D1Database;
let bucket: R2Bucket;
let persistRoot: string | undefined;
let options: ReturnType<typeof convertV4MiniflareOptions>;
const token = randomBytes(32).toString("hex");
const prefix = `${VAULT_ID}/source/`;
beforeAll(async () => {
  script = (
    await build({
      entryPoints: ["test/idle-worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      tsconfig: "tsconfig.json",
    })
  ).outputFiles[0]!.text;
});
afterEach(async () => {
  await mf?.dispose();
  if (persistRoot) await rm(persistRoot, { recursive: true, force: true });
  persistRoot = undefined;
});
async function request(
  route: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await mf.dispatchFetch(
    "https://vault.example.invalid" + route,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
  return { status: response.status, ...((await response.json()) as any) };
}
async function setup(count = 1) {
  options = convertV4MiniflareOptions({
    modules: true,
    script,
    compatibilityDate: "2026-10-28",
    d1Databases: { DB: "idle" },
    r2Buckets: { SOURCE: "idle" },
    ...(persistRoot ? { resourcePersistencePath: persistRoot } : {}),
    ratelimits: {
      REQUEST_LIMITER: {
        namespace_id: "1043",
        simple: { limit: 100000, period: 60 },
      },
    },
    bindings: {
      VAULT_ID,
      READ_TOKEN: randomBytes(32).toString("hex"),
      ADMIN_TOKEN: token,
      INCLUDE_PATHS: '["Notes","images"]',
      EXCLUDE_PATHS: '["**/secret.md"]',
      ALLOWED_ORIGINS: "[]",
      PROFILE_VALUE_ALLOWLIST: "[]",
      INGESTION_ENABLED: "true",
      EXTERNAL_EMBEDDING_CONSENT: "false",
      EMBEDDING_MODEL_REVISION: "operator-v1",
    },
  });
  mf = new Miniflare(options);
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  bucket = (await mf.getR2Bucket("SOURCE")) as unknown as R2Bucket;
  for (const name of (await readdir("migrations"))
    .filter((n) => n.endsWith(".sql"))
    .sort())
    for (const sql of (await readFile("migrations/" + name, "utf8"))
      .replace(/--[^\n]*/g, "")
      .split(";")
      .filter((s) => s.trim()))
      await db.prepare(sql).run();
  for (let n = 0; n < count; n++)
    await bucket.put(
      prefix + `Notes/Note-${String(n).padStart(4, "0")}.md`,
      `# Orchard ${n}\nSynthetic orchard apples.`,
    );
  await publish();
}
async function drive(job: any) {
  for (let n = 0; n < 3000 && !["complete", "failed"].includes(job.state); n++)
    job = (
      await request(`/jobs/${job.jobId}/advance`, {
        checkpoint: job.checkpoint,
      })
    ).data;
  expect(job.state, JSON.stringify(job.error)).toBe("complete");
  return job;
}
async function publish() {
  return drive((await request("/index", {})).data);
}
async function state() {
  return db.prepare("SELECT * FROM ingestion_state").first();
}
async function idle(headers: Record<string, string> = {}) {
  return request("/__idle", undefined, headers);
}
function unchanged(result: any) {
  expect(result.status).toBe(200);
  expect(result.counts.rowsWritten).toBe(0);
  expect(result.mutatingStatements).toBe(0);
  expect(
    result.counts.r2Get +
      result.counts.r2Head +
      result.counts.r2Put +
      result.counts.r2Delete,
  ).toBe(0);
  expect(result.logs.map((l: any) => l.result)).toEqual(["start", "unchanged"]);
}

it("repeats the read-only check after a workerd restart with durable storage", async () => {
  persistRoot = await mkdtemp(path.join(tmpdir(), "vault-agent-idle-restart-"));
  await setup();
  const before = await state();
  await mf.dispose();
  mf = new Miniflare(options);
  db = (await mf.getD1Database("DB")) as unknown as D1Database;
  bucket = (await mf.getR2Bucket("SOURCE")) as unknown as R2Bucket;
  expect(await state()).toEqual(before);
  unchanged(await idle());
  expect(await state()).toEqual(before);
});

it.each([0, 1, 99, 101])(
  "writes zero D1 rows for %i unchanged notes, including all LIST pages",
  async (count) => {
    await setup(count);
    const before = await state();
    const jobs = await db
      .prepare("SELECT count(*) AS n FROM ingestion_jobs")
      .first();
    for (let n = 0; n < 3; n++) {
      const result = await idle();
      unchanged(result);
      expect(result.logs[1].files).toBe(count);
      expect(result.counts.r2List).toBe(count > 100 ? 2 : 1);
    }
    expect(await state()).toEqual(before);
    expect(
      await db.prepare("SELECT count(*) AS n FROM ingestion_jobs").first(),
    ).toEqual(jobs);
  },
  30000,
);

it("ignores excluded entries and tombstones, but detects attachment writes and metadata-only rewrites", async () => {
  await setup();
  await bucket.put(prefix + "Notes/secret.md", "synthetic-private-path");
  await bucket.put(prefix + "Notes/Removed.md", "", {
    customMetadata: { deleted: "true" },
  });
  unchanged(await idle());
  await bucket.put(
    prefix + "images/chart.svg",
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  expect((await idle()).logs[1].result).toBe("changed");
  await publish();
  unchanged(await idle());
  const key = prefix + "Notes/Note-0000.md";
  const old = await bucket.get(key);
  await bucket.put(key, await old!.text(), {
    customMetadata: { synthetic: "rewrite" },
  });
  expect((await idle()).logs[1].result).toBe("changed");
  await publish();
  unchanged(await idle());
});

it("detects create, overwrite, rename and deletion and revokes old IDs after publication", async () => {
  await setup();
  const path = "Notes/Note-0000.md";
  const id = await core.noteIdFromPath(path);
  for (const action of ["create", "overwrite", "rename", "delete"]) {
    if (action === "create")
      await bucket.put(prefix + "Notes/New.md", "# New\nSynthetic new note.");
    if (action === "overwrite")
      await bucket.put(prefix + path, "# Updated\nSynthetic changed orchard.");
    if (action === "rename") {
      await bucket.put(
        prefix + "Notes/Renamed.md",
        "# Renamed\nSynthetic renamed note.",
      );
      await bucket.delete(prefix + path);
    }
    if (action === "delete") await bucket.delete(prefix + "Notes/New.md");
    expect((await idle()).logs[1].result).toBe("changed");
    await publish();
    unchanged(await idle());
  }
  expect((await request(`/notes/${id}`)).status).toBe(404);
});

it.each(["Policy", "Model"])(
  "invalidates the signature for %s configuration changes",
  async (flag) => {
    await setup();
    expect(
      (await idle({ [`X-Synthetic-${flag}`]: "true" })).logs[1].result,
    ).toBe("changed");
  },
);

it.each(["Epoch", "Upload"])(
  "does not skip work when %s changes during a probe",
  async (flag) => {
    await setup();
    const result = await idle({ [`X-Synthetic-${flag}`]: "true" });
    expect(result.logs[1].result).toBe("changed");
    expect(result.counts.rowsWritten).toBeGreaterThan(0);
  },
);

it("finds a direct edit racing an unchanged probe on the next tick", async () => {
  await setup();
  // The insertion occurs after the last page was sampled, matching R2's documented race.
  const first = await idle({ "X-Synthetic-Edit": "true" });
  expect(first.logs[1].result).toBe("unchanged");
  expect((await idle()).logs[1].result).toBe("changed");
  await publish();
  expect(
    (await request(`/notes/${await core.noteIdFromPath("Notes/New.md")}`))
      .status,
  ).toBe(200);
});

it("sanitizes failures, keeps persistent state unchanged and retries successfully", async () => {
  await setup();
  const before = await state();
  const result = await idle({ "X-Synthetic-Failure": "true" });
  expect(result.status).toBe(503);
  expect(result.logs[1].errorCode).toBe("INGESTION_FAILED");
  expect(JSON.stringify(result)).not.toMatch(
    /synthetic-private-path|secret-token|provider-response|\.md/,
  );
  expect(result.counts.rowsWritten).toBe(0);
  expect(await state()).toEqual(before);
  unchanged(await idle());
});

it("rejects duplicate membership instead of accepting a partial or ambiguous signature", async () => {
  await setup();
  const result = await idle({ "X-Synthetic-Duplicate": "true" });
  expect(result.status).toBe(503);
  expect(result.logs[1].errorCode).toBe("REVISION_CONFLICT");
  expect(result.counts.rowsWritten).toBe(0);
});

it("falls back to a resumable bounded scan when excluded objects exceed the preflight page budget", async () => {
  await setup();
  for (let n = 0; n < 801; n++)
    await bucket.put(prefix + `excluded/${n}.txt`, "synthetic");
  const result = await idle();
  expect(result.logs[1].result).toBe("deferred");
  expect(result.logs[1].pages).toBe(8);
  expect(result.counts.rowsWritten).toBeGreaterThan(0);
  const job = (await request("/status")).data.deployment.activeJobId;
  expect(job).toBeTruthy();
  expect((await idle()).logs[1].result).toBe("resumed");
  await drive((await request(`/jobs/${job}`)).data);
}, 30000);

it("resumes durable work across ticks and duplicate Cron invocations", async () => {
  await setup();
  await bucket.put(prefix + "Notes/New.md", "# New\nSynthetic changed note.");
  const job = (await request("/index", {})).data;
  const results = await Promise.all([idle(), idle()]);
  expect(
    results.every((r) => ["resumed", "unchanged"].includes(r.logs[1].result)),
  ).toBe(true);
  await drive((await request(`/jobs/${job.jobId}`)).data);
  unchanged(await idle());
});

it("keeps long-idle status unknown rather than stale and performs eligible cleanup without source changes", async () => {
  await setup();
  await db
    .prepare("UPDATE ingestion_state SET observed=?")
    .bind(Date.now() - 864000000)
    .run();
  const status = (await request("/status")).data;
  expect(status.deployment.detection.state).toBe("idle");
  expect(status.deployment.detection.monitoring).toBe("not_persisted");
  expect(status.index.freshness.state).toBe("unknown");
  const found = await request("/search", { query: "orchard", mode: "lexical" });
  expect(
    found.warnings.some((w: any) => w.code === "INDEX_FRESHNESS_UNKNOWN"),
  ).toBe(true);
  unchanged(await idle());
  await db
    .prepare("INSERT INTO embedding_cache VALUES('synthetic-unused','[]',?)")
    .bind(Date.now() - 86400001)
    .run();
  const maintenance = await idle();
  expect(maintenance.logs[1].result).toBe("unchanged");
  expect(maintenance.counts.rowsWritten).toBeGreaterThan(0);
  expect(await db.prepare("SELECT * FROM embedding_cache").first()).toBeNull();
  unchanged(await idle());
});

it("reports consistent freshness in HTTP aggregates, MCP retrieval, updating and failed recovery", async () => {
  await setup();
  const overview = await request("/overview");
  expect(overview.status).toBe(200);
  expect(overview.data.indexFreshness).toBe("unknown");
  for (const [name, args] of [
    ["search", { query: "orchard", mode: "lexical", limit: 5 }],
    ["get_note", { noteId: await core.noteIdFromPath("Notes/Note-0000.md") }],
  ] as const) {
    const response = await request(
      "/mcp",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
      { Accept: "application/json, text/event-stream" },
    );
    expect(response.error).toBeUndefined();
    const data = JSON.parse(response.result.content[0].text);
    expect(data.freshness).toBe("unknown");
  }
  const job = (await request("/index", {})).data;
  expect((await request("/status")).data.index.freshness.state).toBe(
    "updating",
  );
  await db
    .prepare(
      "UPDATE ingestion_jobs SET state='failed',error='INGESTION_FAILED' WHERE id=?",
    )
    .bind(job.jobId)
    .run();
  expect((await request("/status")).data.index.freshness.state).toBe("stale");
  expect((await idle()).logs[1].result).toBe("changed");
  await publish();
  unchanged(await idle());
});

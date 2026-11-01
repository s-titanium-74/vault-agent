import { afterAll, beforeAll, expect, it } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import * as core from "../../core/src/portable/index.js";
import { fixture, VAULT_ID } from "../scripts/fixture.js";

let mf: Miniflare, db: D1Database, bucket: R2Bucket;
const token = randomBytes(32).toString("hex");
const prefix = `${VAULT_ID}/source/`;
let sourceCounts = { get: 0, head: 0, list: 0, put: 0 };
function resetSourceCounts() {
  sourceCounts = { get: 0, head: 0, list: 0, put: 0 };
}
async function request(
  route: string,
  input?: unknown,
  extra: Record<string, string> = {},
) {
  const response = await mf.dispatchFetch(
    "https://vault.example.invalid" + route,
    {
      method: input === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-Synthetic-Measure-Source": "true",
        ...extra,
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    },
  );
  const measured = JSON.parse(
    response.headers.get("X-Synthetic-Source-Counts") ?? "{}",
  );
  if (route === "/index" || route === "/reindex" || route.endsWith("/advance"))
    for (const key of Object.keys(
      sourceCounts,
    ) as (keyof typeof sourceCounts)[])
      sourceCounts[key] += measured[key] ?? 0;
  return { status: response.status, ...((await response.json()) as any) };
}
async function advance(job: any, until = "complete") {
  for (
    let n = 0;
    n < 700 &&
    job.state !== until &&
    !["complete", "failed"].includes(job.state);
    n++
  )
    job = (
      await request(`/jobs/${job.jobId}/advance`, {
        checkpoint: job.checkpoint,
      })
    ).data;
  return job;
}
async function start() {
  return (await request("/index", {})).data;
}
async function get(path: string, snapshot?: string) {
  return request(
    `/notes/${await core.noteIdFromPath(path)}${snapshot ? "?snapshot=" + snapshot : ""}`,
  );
}
beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["test/ingestion-worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    tsconfig: "tsconfig.json",
  });
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: bundle.outputFiles[0]!.text,
      compatibilityDate: "2026-10-28",
      d1Databases: {
        DB: "incremental-publication",
        LEGACY: "legacy-publication",
      },
      r2Buckets: { SOURCE: "incremental-publication" },
      ratelimits: {
        REQUEST_LIMITER: {
          namespace_id: "1048",
          simple: { limit: 100000, period: 60 },
        },
      },
      bindings: {
        VAULT_ID,
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
  // Same public-safe size/language/chunk pattern as the capacity fixture.
  for (let n = 0; n < 100; n++) {
    const id = String(n).padStart(4, "0"),
      next = String((n + 1) % 100).padStart(4, "0");
    await bucket.put(
      prefix + `Notes/Note-${id}.md`,
      `---\ntags: [synthetic, orchard]\ntype: example\n---\n# Orchard ${id}\n\nSynthetic apple trees and winter pruning. 日本語の合成ノート。果樹園と冬の剪定。\n\n[[Note-${next}]] ![chart](../images/chart.svg)\n\n## Checklist\n\n${"Water the synthetic orchard. 果樹園の水やり。\n".repeat(24)}`,
    );
  }
  await bucket.put(
    prefix + "images/chart.svg",
    '<svg xmlns="http://www.w3.org/2000/svg"/>',
  );
  const initial = await advance(await start());
  expect(initial.state).toBe("complete");
  expect(initial.chunksIndexed).toBe(200);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM source_observations").first())!
      .n,
  ).toBe(101);
  await db.prepare("CREATE TABLE synthetic_writes(kind TEXT,id TEXT)").run();
  for (const [table, identity] of [
    ["notes", "note_id"],
    ["chunks", "chunk_id"],
    ["grams", "chunk_id"],
  ]) {
    for (const event of ["INSERT", "UPDATE", "DELETE"])
      await db
        .prepare(
          `CREATE TRIGGER synthetic_${table}_${event} AFTER ${event} ON ${table} BEGIN INSERT INTO synthetic_writes VALUES('${table}',${event === "DELETE" ? "old" : "new"}.${identity}); END`,
        )
        .run();
  }
}, 30000);
afterAll(async () => mf?.dispose());

it("migrates legacy stores without rewriting data and fences legacy publishers", async () => {
  const legacy = await mf.getD1Database("LEGACY");
  for (const name of [
    "0001_retrieval.sql",
    "0002_semantic.sql",
    "0003_ingestion.sql",
  ])
    for (const sql of (await readFile("migrations/" + name, "utf8"))
      .replace(/--[^\n]*/g, "")
      .split(";")
      .filter((s) => s.trim()))
      await legacy.prepare(sql).run();
  const seed = await fixture();
  for (const sql of seed.statements) await legacy.prepare(sql).run();
  const before = (
    await legacy.prepare("SELECT * FROM notes ORDER BY note_id").all()
  ).results;
  await legacy
    .prepare(
      "INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,created,lease,lease_until) VALUES('legacy-scan','legacy','scan','files','{}',0,'old-token',9999999999999)",
    )
    .run();
  await legacy
    .prepare(
      "INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,created) VALUES('legacy-upload','legacy','upload','applying','{}',0)",
    )
    .run();
  for (const sql of (await readFile("migrations/0004_incremental.sql", "utf8"))
    .replace(/--[^\n]*/g, "")
    .split(";")
    .filter((s) => s.trim()))
    await legacy.prepare(sql).run();
  expect(
    (await legacy.prepare("SELECT * FROM notes ORDER BY note_id").all())
      .results,
  ).toEqual(before);
  expect(
    (await legacy.prepare("SELECT snapshot FROM publications").first())!
      .snapshot,
  ).toBe(seed.revision);
  expect(
    await legacy
      .prepare(
        "SELECT state,error,lease FROM ingestion_jobs WHERE id='legacy-scan'",
      )
      .first(),
  ).toMatchObject({
    state: "failed",
    error: "INGESTION_UPGRADE_REQUIRED",
    lease: null,
  });
  expect(
    (await legacy
      .prepare("SELECT state FROM ingestion_jobs WHERE id='legacy-upload'")
      .first())!.state,
  ).toBe("applying");
  await legacy
    .prepare(
      "INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,created,lease) VALUES('v4-scan','v4','scan','delta_files','{\"layout\":2}',0,'v4-token')",
    )
    .run();
  for (const sql of (
    await readFile("migrations/0005_source_observations.sql", "utf8")
  )
    .replace(/--[^\n]*/g, "")
    .split(";")
    .filter((s) => s.trim()))
    await legacy.prepare(sql).run();
  expect(
    await legacy
      .prepare(
        "SELECT state,error,lease FROM ingestion_jobs WHERE id='v4-scan'",
      )
      .first(),
  ).toMatchObject({
    state: "failed",
    error: "INGESTION_UPGRADE_REQUIRED",
    lease: null,
  });
  expect(
    (await legacy
      .prepare("SELECT count(*) AS n FROM source_observations")
      .first())!.n,
  ).toBe(0);
  expect(
    (await legacy.prepare("SELECT * FROM notes ORDER BY note_id").all())
      .results,
  ).toEqual(before);
  await expect(
    legacy
      .prepare(
        "INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,created) VALUES('v4-new','v4','scan','scanning','{\"layout\":2}',0)",
      )
      .run(),
  ).rejects.toThrow();
  await expect(
    legacy
      .prepare(
        "INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,created) VALUES('old-writer','legacy','scan','scanning','{}',0)",
      )
      .run(),
  ).rejects.toThrow();
});

it("publishes one changed note atomically without rewriting the other 99 notes or their indexes", async () => {
  const before = (await request("/status")).data.deployment.activeRevision;
  const store = (await db
    .prepare("SELECT revision FROM deployment")
    .first<{ revision: string }>())!.revision;
  const unchanged = await db
    .prepare(
      `SELECT rowid,chunk_id,lexical_text FROM fts_${store} ORDER BY chunk_id`,
    )
    .all();
  const body = await (await bucket.get(prefix + "Notes/Note-0000.md"))!.text();
  const target = body + "\nSynthetic revisionmarker 改訂.\n";
  await bucket.put(prefix + "Notes/Note-0000.md", target);
  resetSourceCounts();
  let job = await advance(await start(), "publishing");
  expect(job.state).toBe("publishing");
  expect(JSON.stringify(await get("Notes/Note-0000.md"))).not.toContain(
    "revisionmarker",
  );
  expect(
    (await db.prepare("SELECT count(*) AS n FROM synthetic_writes").first())!.n,
  ).toBe(0);
  const checkpoint = job.checkpoint;
  job = await advance(job);
  expect(job.error).toBeNull();
  expect(job.updatePath).toBe("incremental");
  expect(job.semantic.state).toBe("disabled");
  expect(sourceCounts).toEqual({ get: 1, head: 0, list: 4, put: 1 });
  expect(job.checkpoint).toBeLessThan(15);
  expect((await get("Notes/Note-0000.md")).data.content).toBe(target);
  const stopped = await request(
    `/notes/${await core.noteIdFromPath("Notes/Note-0000.md")}`,
    undefined,
    { "X-Synthetic-Disable-Ingestion": "true" },
  );
  expect(stopped.data.content).toBe(target);
  expect(stopped.revision.snapshot).toBe(job.targetRevision);
  expect((await get("Notes/Note-0000.md", before)).status).toBe(409);
  expect(
    (await db.prepare("SELECT revision FROM deployment").first())!.revision,
  ).toBe(store);
  const id = await core.noteIdFromPath("Notes/Note-0000.md");
  const writes = (await db.prepare("SELECT * FROM synthetic_writes").all())
    .results;
  expect(writes.length).toBeGreaterThan(0);
  expect(
    writes.every((r) => r.id === id || String(r.id).startsWith(id + ":")),
  ).toBe(true);
  const after = await db
    .prepare(
      `SELECT rowid,chunk_id,lexical_text FROM fts_${store} ORDER BY chunk_id`,
    )
    .all();
  expect(
    after.results.filter((r) => !String(r.chunk_id).startsWith(id + ":")),
  ).toEqual(
    unchanged.results.filter((r) => !String(r.chunk_id).startsWith(id + ":")),
  );
  expect(
    (await db.prepare("SELECT count(*) AS n FROM source_objects").first())!.n,
  ).toBe(1);
  expect(
    (await db
      .prepare("SELECT count(*) AS n FROM prepared_deltas WHERE job=?")
      .bind(job.jobId)
      .first())!.n,
  ).toBe(1);
  const replay = (await request(`/jobs/${job.jobId}/advance`, { checkpoint }))
    .data;
  expect(replay.checkpoint).toBe(job.checkpoint);
  expect(
    (await db.prepare("SELECT count(*) AS n FROM synthetic_writes").first())!.n,
  ).toBe(writes.length);
  expect(
    (await request("/search", { query: "revisionmarker", mode: "lexical" }))
      .data.results.length,
  ).toBeGreaterThan(0);
});

it("uses LIST only for no change and reads a same-byte rewrite with a new object version", async () => {
  resetSourceCounts();
  expect((await advance(await start())).state).toBe("complete");
  expect(sourceCounts).toEqual({ get: 0, head: 0, list: 2, put: 0 });
  const key = prefix + "Notes/Note-0000.md";
  const old = await bucket.get(key),
    text = await old!.text();
  await bucket.put(key, text);
  const next = await bucket.head(key);
  expect(next!.etag).toBe(old!.etag);
  expect(next!.version).not.toBe(old!.version);
  resetSourceCounts();
  const job = await advance(await start());
  expect(job.state).toBe("complete");
  expect(job.notesSkipped).toBe(100);
  expect(sourceCounts).toEqual({ get: 1, head: 0, list: 4, put: 0 });
});

it("rejects a read spanning publication even when the public snapshot returns to the same value", async () => {
  const result = await request(
    `/notes/${await core.noteIdFromPath("Notes/Note-0000.md")}`,
    undefined,
    { "X-Synthetic-Read-Race": "true" },
  );
  expect(result.status).toBe(409);
  expect(result.error.code).toBe("REVISION_CHANGED");
});

it("reclaims retired bytes without removing reused active bytes", async () => {
  const key = (await db
    .prepare("SELECT object_key FROM source_objects LIMIT 1")
    .first())!.object_key as string;
  const store = (await db.prepare("SELECT revision FROM deployment").first())!
    .revision;
  const garbage = `${VAULT_ID}/${store}/.updates/synthetic-unreferenced/Notes/Unused.md`;
  await bucket.put(garbage, "Synthetic retired bytes");
  await db
    .prepare("INSERT INTO retired_objects VALUES(?,0)")
    .bind(garbage)
    .run();
  await db.prepare("UPDATE retired_objects SET retired=0").run();
  await request("/__tick");
  expect(await bucket.head(garbage)).toBeNull();
  expect(await bucket.head(key)).not.toBeNull();
  expect((await get("Notes/Note-0000.md")).data.content).toContain(
    "revisionmarker",
  );
  // Complete the no-change scan that Cron admitted after GC.
  const current = (await request("/index", {})).data;
  expect((await advance(current)).state).toBe("complete");
  const completed = (await db
    .prepare(
      "SELECT id,data FROM ingestion_jobs WHERE state='complete' AND json_extract(data,'$.incremental')=1 ORDER BY created LIMIT 1",
    )
    .first())!;
  const orphan = `${VAULT_ID}/${store}/.updates/${completed.id}/Notes/Interrupted.md`;
  await bucket.put(orphan, "Synthetic write without checkpoint receipt");
  await db
    .prepare("UPDATE ingestion_jobs SET created=0 WHERE id=?")
    .bind(completed.id)
    .run();
  await request("/__tick");
  expect(
    await db
      .prepare("SELECT object_key FROM retired_objects WHERE object_key=?")
      .bind(orphan)
      .first(),
  ).not.toBeNull();
  expect(await bucket.head(key)).not.toBeNull();
  await db
    .prepare("UPDATE retired_objects SET retired=0 WHERE object_key=?")
    .bind(orphan)
    .run();
  await request("/__tick");
  expect(await bucket.head(orphan)).toBeNull();
  expect(await bucket.head(key)).not.toBeNull();
});

it("rolls back data, FTS and publication together and recovers with a full store after a failed commit", async () => {
  const old = await get("Notes/Note-0001.md");
  const observationBefore = await db
    .prepare(
      "SELECT * FROM source_observations WHERE revision=(SELECT revision FROM deployment) AND path='Notes/Note-0001.md'",
    )
    .first();
  const before = (await request("/status")).data.deployment.activeRevision;
  await bucket.put(
    prefix + "Notes/Note-0001.md",
    "# Replacement\ntransactionmarker\n",
  );
  const prepared = await advance(await start(), "publishing");
  expect(prepared.updatePath).toBe("incremental");
  await db
    .prepare(
      "CREATE TRIGGER synthetic_commit_failure BEFORE UPDATE ON publications BEGIN SELECT RAISE(ABORT,'synthetic commit failure'); END",
    )
    .run();
  const failed = await advance(prepared);
  await db.prepare("DROP TRIGGER synthetic_commit_failure").run();
  expect(failed.state).toBe("failed");
  expect((await request("/status")).data.deployment.activeRevision).toBe(
    before,
  );
  expect((await get("Notes/Note-0001.md")).data.content).toBe(old.data.content);
  expect(
    await db
      .prepare(
        "SELECT * FROM source_observations WHERE revision=(SELECT revision FROM deployment) AND path='Notes/Note-0001.md'",
      )
      .first(),
  ).toEqual(observationBefore);
  const store = (await db.prepare("SELECT revision FROM deployment").first())!
    .revision;
  expect(
    (await db
      .prepare(
        `SELECT count(*) AS n FROM fts_${store} WHERE fts_${store} MATCH ?`,
      )
      .bind("transactionmarker")
      .first())!.n,
  ).toBe(0);
  const recovered = await advance(await start());
  expect(recovered.state).toBe("complete");
  expect(recovered.updatePath).toBe("rebuild-recovery");
  expect((await get("Notes/Note-0001.md")).data.content).toBe(
    "# Replacement\ntransactionmarker\n",
  );
});

it("routes a large delta to a separate store before mutating any live rows", async () => {
  for (let n = 2; n < 22; n++)
    await bucket.put(
      prefix + `Notes/Note-${String(n).padStart(4, "0")}.md`,
      `# Changed ${n}\nlarge-delta-marker ${n}\n`,
    );
  const before = (await request("/status")).data.deployment.activeRevision;
  const job = await advance(await start(), "files");
  expect(job.updatePath).toBe("rebuild-budget");
  expect((await request("/status")).data.deployment.activeRevision).toBe(
    before,
  );
  expect((await get("Notes/Note-0002.md")).data.content).not.toContain(
    "large-delta-marker",
  );
  expect((await advance(job)).state).toBe("complete");
});

it("rejects a new admitted path between final LIST pages and preserves the prior publication", async () => {
  const before = (await request("/status")).data.deployment.activeRevision;
  const old = await get("Notes/Note-0000.md");
  await bucket.put(
    prefix + "Notes/Note-0000.md",
    old.data.content + "\nPaged validation update.\n",
  );
  let job = await advance(await start(), "validating");
  job = (
    await request(`/jobs/${job.jobId}/advance`, { checkpoint: job.checkpoint })
  ).data;
  expect(job.state).toBe("validating");
  const saved = JSON.parse(
    (await db
      .prepare("SELECT data FROM ingestion_jobs WHERE id=?")
      .bind(job.jobId)
      .first())!.data as string,
  );
  expect(saved.validateSeen).toHaveLength(100);
  await bucket.put(
    prefix + "Notes/Note-9999.md",
    "# Unexpected\nSynthetic page membership change.\n",
  );
  const failed = await advance(job);
  expect(failed.error.code).toBe("REVISION_CONFLICT");
  expect((await request("/status")).data.deployment.activeRevision).toBe(
    before,
  );
  expect((await get("Notes/Note-0000.md")).data.content).toBe(old.data.content);
  await bucket.delete(prefix + "Notes/Note-9999.md");
  expect((await advance(await start())).state).toBe("complete");
});

it("bootstraps missing verified observations once and still reads every source on explicit rebuild", async () => {
  await db.prepare("DELETE FROM source_observations").run();
  await db
    .prepare("UPDATE ingestion_state SET signature='legacy-signature'")
    .run();
  resetSourceCounts();
  let job = await advance(await start(), "publishing");
  expect(
    (await db.prepare("SELECT count(*) AS n FROM source_observations").first())!
      .n,
  ).toBe(0);
  job = await advance(job);
  expect(job.state).toBe("complete");
  expect(sourceCounts).toEqual({ get: 101, head: 0, list: 4, put: 0 });
  expect(
    (await db.prepare("SELECT count(*) AS n FROM source_observations").first())!
      .n,
  ).toBe(101);
  resetSourceCounts();
  expect((await advance((await request("/reindex", {})).data)).state).toBe(
    "complete",
  );
  expect(sourceCounts).toEqual({ get: 101, head: 0, list: 4, put: 101 });
});

it("invalidates observation reuse when chunking compatibility changes", async () => {
  await db
    .prepare(
      "UPDATE snapshots SET manifest=json_set(manifest,'$.targetChunkSize',1) WHERE revision=(SELECT revision FROM deployment)",
    )
    .run();
  resetSourceCounts();
  const job = await advance(await start());
  expect(job.state).toBe("complete");
  expect(job.mode).toBe("full");
  expect(sourceCounts).toEqual({ get: 101, head: 0, list: 4, put: 101 });
  const manifest = JSON.parse(
    (await db
      .prepare(
        "SELECT manifest FROM snapshots WHERE revision=(SELECT revision FROM deployment)",
      )
      .first())!.manifest as string,
  );
  expect(manifest.targetChunkSize).toBe(core.TARGET_CHUNK_SIZE);
});

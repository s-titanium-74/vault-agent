import { beforeAll, afterAll, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import { fixture, VAULT_ID } from "../scripts/fixture.js";
let mf: Miniflare;
const read = randomBytes(32).toString("hex"),
  admin = randomBytes(32).toString("hex");
let active: Awaited<ReturnType<typeof fixture>>,
  old: Awaited<ReturnType<typeof fixture>>,
  young: Awaited<ReturnType<typeof fixture>>;
let fenceId: string;
beforeAll(async () => {
  const bundle = await build({
    entryPoints: ["test/remote-retention-worker.ts"],
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
      compatibilityDate: "2026-10-29",
      d1Databases: { DB: "retention" },
      r2Buckets: { SOURCE: "retention" },
      ratelimits: {
        REQUEST_LIMITER: {
          namespace_id: "1001",
          simple: { limit: 10000, period: 60 },
        },
      },
      bindings: {
        READ_TOKEN: read,
        ADMIN_TOKEN: admin,
        VAULT_ID,
        INCLUDE_PATHS: '["."]',
        EXCLUDE_PATHS: "[]",
        ALLOWED_ORIGINS: "[]",
        PROFILE_VALUE_ALLOWLIST: "[]",
        INGESTION_ENABLED: "true",
        EXTERNAL_EMBEDDING_CONSENT: "false",
        EMBEDDING_MODEL_REVISION: "operator-v1",
        SYNTHETIC_RETENTION: "true",
      },
    }),
  );
  const db = await mf.getD1Database("DB"),
    bucket = await mf.getR2Bucket("SOURCE");
  for (const file of [
    "0001_retrieval.sql",
    "0002_semantic.sql",
    "0003_ingestion.sql",
  ])
    for (const sql of (await readFile("migrations/" + file, "utf8"))
      .replace(/--[^\n]*/g, "")
      .split(";")
      .filter((s) => s.trim()))
      await db.prepare(sql).run();
  await db
    .prepare(
      "CREATE TABLE synthetic_telemetry(kind TEXT,wall_ms INTEGER,counts TEXT)",
    )
    .run();
  active = await fixture();
  young = await fixture({
    "Guide/Young.md": "# Young\nSynthetic young note.\n",
  });
  old = await fixture({
    "Guide/Legacy.md": "# Legacy\nSynthetic old apple note.\n",
  });
  for (const seed of [old, young, active]) {
    for (const sql of seed.statements) await db.prepare(sql).run();
    for (const object of seed.objects)
      await bucket.put(object.key, object.content);
  }
  await db
    .prepare("UPDATE snapshots SET created=? WHERE revision=?")
    .bind(Date.now(), active.revision)
    .run();
  await db
    .prepare("UPDATE snapshots SET created=? WHERE revision=?")
    .bind(Date.now(), young.revision)
    .run();
  const id = randomUUID();
  fenceId = id;
  await db
    .prepare(
      "INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,lease,lease_until,created) VALUES(?,?,'scan','scanning',?,'synthetic-retention-fence',?,?)",
    )
    .bind(
      id,
      id,
      JSON.stringify({
        revision: "f".repeat(64),
        parent: active.revision,
        manifest: active.manifest,
      }),
      Date.now() + 3600000,
      Date.now(),
    )
    .run();
  await db
    .prepare("UPDATE ingestion_state SET job=? WHERE id=1")
    .bind(id)
    .run();
  await bucket.put(
    `${VAULT_ID}/source/Guide/Current.md`,
    "Synthetic mutable source",
  );
  await bucket.put(
    "unrelated/source/Guide/Foreign.md",
    "Synthetic unrelated source",
  );
});
afterAll(async () => mf?.dispose());
const tick = (token: string, origin?: string) =>
  mf.dispatchFetch("https://synthetic.example.invalid/__retention/tick", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(origin ? { Origin: origin } : {}),
    },
  });
it("rejects read tokens and unlisted origins before executing cleanup", async () => {
  expect((await tick(read)).status).toBe(403);
  expect((await tick(admin, "https://unlisted.example.invalid")).status).toBe(
    403,
  );
  const db = await mf.getD1Database("DB");
  expect(
    (await db.prepare("SELECT count(*) AS n FROM synthetic_telemetry").first())!
      .n,
  ).toBe(0);
});
it("cleans expired native snapshot rows/FTS/objects but preserves active/source/unrelated data", async () => {
  const db = await mf.getD1Database("DB"),
    bucket = await mf.getR2Bucket("SOURCE");
  for (let n = 0; n < 6; n++) expect((await tick(admin)).status).toBe(200);
  expect(
    await db
      .prepare("SELECT revision FROM snapshots WHERE revision=?")
      .bind(old.revision)
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT name FROM sqlite_master WHERE name=?")
      .bind(`fts_${old.revision}`)
      .first(),
  ).toBeNull();
  expect(
    (await db.prepare("SELECT revision FROM deployment").first())!.revision,
  ).toBe(active.revision);
  expect(
    (await bucket.list({ prefix: `${VAULT_ID}/${old.revision}/` })).objects,
  ).toHaveLength(0);
  expect(await bucket.head(active.objects[0]!.key)).not.toBeNull();
  expect(await bucket.head(young.objects[0]!.key)).not.toBeNull();
  expect(
    await db
      .prepare("SELECT revision FROM snapshots WHERE revision=?")
      .bind(young.revision)
      .first(),
  ).not.toBeNull();
  expect(
    await bucket.head(`${VAULT_ID}/source/Guide/Current.md`),
  ).not.toBeNull();
  expect(await bucket.head("unrelated/source/Guide/Foreign.md")).not.toBeNull();
});

it("reclaims expired staging and guards cache eviction with active work", async () => {
  const db = await mf.getD1Database("DB"),
    bucket = await mf.getR2Bucket("SOURCE");
  const id = randomUUID();
  await db
    .prepare(
      "INSERT INTO ingestion_jobs(id,request_hash,kind,state,data,created) VALUES(?,?,'upload','complete',?,0)",
    )
    .bind(
      id,
      id,
      JSON.stringify({
        revision: "e".repeat(64),
        parent: active.revision,
        manifest: active.manifest,
      }),
    )
    .run();
  await db
    .prepare(
      "INSERT INTO ingestion_entries(job,path,kind,size,updated) VALUES(?,'Guide/Expired.md','note',9,'2026-01-01')",
    )
    .bind(id)
    .run();
  const staged = `${VAULT_ID}/staging/${id}/Guide/Expired.md`;
  await bucket.put(staged, "Synthetic");
  await db
    .prepare("INSERT INTO embedding_cache VALUES('synthetic-orphan','[1]',0)")
    .run();
  for (let n = 0; n < 3; n++) expect((await tick(admin)).status).toBe(200);
  expect(await bucket.head(staged)).toBeNull();
  expect(
    await db
      .prepare("SELECT id FROM ingestion_jobs WHERE id=?")
      .bind(id)
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT job FROM ingestion_entries WHERE job=?")
      .bind(id)
      .first(),
  ).toBeNull();
  expect(
    await db
      .prepare("SELECT key FROM embedding_cache WHERE key='synthetic-orphan'")
      .first(),
  ).not.toBeNull();
  await db
    .prepare(
      "UPDATE ingestion_jobs SET state='complete',lease=NULL,lease_until=0 WHERE id=?",
    )
    .bind(fenceId)
    .run();
  expect((await tick(admin)).status).toBe(200);
  expect(
    await db
      .prepare("SELECT key FROM embedding_cache WHERE key='synthetic-orphan'")
      .first(),
  ).toBeNull();
});

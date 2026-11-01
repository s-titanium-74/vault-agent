import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import * as core from "../../core/src/portable/index.js";
import { VAULT_ID } from "../scripts/fixture.js";
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let bucket: Awaited<ReturnType<Miniflare["getR2Bucket"]>>;
const read = randomBytes(32).toString("hex"),
  admin = randomBytes(32).toString("hex");
const prefix = `${VAULT_ID}/source/`;
const sha = (v: string) => createHash("sha256").update(v).digest("hex");
async function request(
  route: string,
  method = "GET",
  input?: unknown,
  token = admin,
  id?: string,
) {
  const response = await mf.dispatchFetch(
    "https://vault.example.invalid" + route,
    {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(id ? { "Idempotency-Key": id } : {}),
      },
      ...(input !== undefined ? { body: JSON.stringify(input) } : {}),
    },
  );
  const result = (await response.json()) as any;
  return { status: response.status, ...result };
}
async function tick() {
  return request("/__tick");
}
async function settle() {
  for (let n = 0; n < 100; n++) {
    const applying = await db
      .prepare(
        "SELECT id FROM ingestion_jobs WHERE kind='upload' AND state='applying'",
      )
      .first();
    if (!applying) break;
    await tick();
  }
  await request("/index", "POST", {});
  for (let i = 0; i < 120; i++) {
    await tick();
    const state = await db
      .prepare(
        "SELECT j.state,j.error FROM ingestion_state s JOIN ingestion_jobs j ON s.job=j.id",
      )
      .first<{ state: string; error: string }>();
    if (state?.state === "failed")
      throw new Error(`scan failed: ${state.error}`);
    const uploading = await db
      .prepare(
        "SELECT id FROM ingestion_jobs WHERE kind='upload' AND state='applying'",
      )
      .first();
    if (state?.state === "complete" && !uploading) return;
  }
  throw new Error("did not settle");
}
async function note(path: string) {
  const id = await core.noteIdFromPath(path);
  return request(`/notes/${id}`);
}
async function search(query: string) {
  return request("/search", "POST", { query, mode: "lexical", limit: 10 });
}
async function create(
  entries: Record<string, string>,
  deletes: string[] = [],
  id = randomUUID(),
) {
  const parent = await db
    .prepare(
      "SELECT coalesce(p.snapshot,d.revision) AS revision FROM deployment d LEFT JOIN publications p ON p.store=d.revision WHERE d.id=1",
    )
    .first<{ revision: string }>();
  const input = {
    vaultId: VAULT_ID,
    parentRevision: parent?.revision ?? null,
    includes: ["Notes", "images"],
    entries: Object.entries(entries).map(([path, text]) => ({
      path,
      kind: path.endsWith(".md") ? "note" : "attachment",
      size: Buffer.byteLength(text),
      digest: sha(text),
      updated: "2026-01-01T00:00:00.000Z",
    })),
    deletes,
  };
  const result = await request("/uploads", "POST", input, admin, id);
  expect(result.status).toBe(200);
  return { id, input, result };
}
async function put(id: string, path: string, text: string) {
  return mf.dispatchFetch(
    `https://vault.example.invalid/uploads/${id}/files/${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${admin}` },
      body: text,
    },
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
      d1Databases: { DB: "ingestion" },
      r2Buckets: { SOURCE: "ingestion" },
      ratelimits: {
        REQUEST_LIMITER: {
          namespace_id: "1002",
          simple: { limit: 100000, period: 60 },
        },
      },
      bindings: {
        VAULT_ID,
        READ_TOKEN: read,
        ADMIN_TOKEN: admin,
        INCLUDE_PATHS: '["Notes","images"]',
        EXCLUDE_PATHS: '["**/secret.md"]',
        ALLOWED_ORIGINS: "[]",
        PROFILE_VALUE_ALLOWLIST: "[]",
        INGESTION_ENABLED: "true",
        EXTERNAL_EMBEDDING_CONSENT: "false",
        EMBEDDING_MODEL_REVISION: "operator-v1",
      },
    }),
  );
  db = await mf.getD1Database("DB");
  bucket = await mf.getR2Bucket("SOURCE");
  for (const file of [
    "0001_retrieval.sql",
    "0002_semantic.sql",
    "0003_ingestion.sql",
    "0004_incremental.sql",
    "0005_source_observations.sql",
  ])
    for (const sql of (await readFile("migrations/" + file, "utf8"))
      .replace(/--[^\n]*/g, "")
      .split(";")
      .filter((s) => s.trim()))
      await db.prepare(sql).run();
});
afterAll(async () => mf?.dispose());
describe("durable scoped ingestion", () => {
  it("authenticates all mutation and job surfaces, accepts no read token for uploads", async () => {
    expect(
      (await request("/uploads", "POST", {}, read, randomUUID())).status,
    ).toBe(403);
    expect(
      (
        await request(
          `/jobs/${randomUUID()}/advance`,
          "POST",
          { checkpoint: 0 },
          read,
        )
      ).status,
    ).toBe(403);
    const status = await request("/status", "GET", undefined, read);
    expect(status.status).toBe(200);
    expect(status.data.server.running).toBe(true);
    expect(status.data.deployment.activeRevision).toBeNull();
    expect(status.data.deployment.capabilities.upload).toBe(true);
    expect(status.data.index.freshness.state).toBe("unknown");
  });
  it("uploads notes/attachments, survives retries, and publishes consistent search/get/links", async () => {
    const files = {
      "Notes/Apple.md":
        "# Apple\nOrchard apples. [[Pear]] ![[images/chart.png]]\n",
      "Notes/Pear.md": "# Pear\nPear trees.\n",
      "images/chart.png": "synthetic-image",
    };
    const { id, input } = await create(files);
    expect(
      (await request("/uploads", "POST", input, admin, id)).data.jobId,
    ).toBe(id);
    expect(
      (
        await request(
          "/uploads",
          "POST",
          { ...input, includes: ["images"] },
          admin,
          id,
        )
      ).status,
    ).toBe(409);
    expect((await request(`/uploads/${id}/commit`, "POST")).error.code).toBe(
      "UPLOAD_INCOMPLETE",
    );
    expect((await put(id, "Notes/Apple.md", "wrong")).status).toBe(409);
    for (const [path, text] of Object.entries(files))
      expect((await put(id, path, text)).status).toBe(200);
    expect(
      (await put(id, "Notes/Apple.md", files["Notes/Apple.md"])).status,
    ).toBe(200);
    const committed = await request(`/uploads/${id}/commit`, "POST");
    // Duplicate/outdated checkpoints cannot repeat work.
    await request(`/jobs/${id}/advance`, "POST", {
      checkpoint: committed.data.checkpoint,
    });
    const before = (await request(`/jobs/${id}`)).data.checkpoint;
    await request(`/jobs/${id}/advance`, "POST", {
      checkpoint: committed.data.checkpoint,
    });
    expect((await request(`/jobs/${id}`)).data.checkpoint).toBe(before);
    await settle();
    expect((await note("Notes/Apple.md")).status).toBe(200);
    const found = await search("orchard");
    expect(found.status).toBe(200);
    expect(JSON.stringify(found.data)).toContain("Apple");
    expect((await request("/attachments/images%2Fchart.png")).status).toBe(200);
    expect((await request("/links/broken")).status).toBe(200);
    expect(
      (await request(`/jobs/${id}`, "GET", undefined, read)).data.state,
    ).toBe("complete");
  });
  it("detects direct create/overwrite/delete/rename with no CLI and ignores unrelated/self/excluded objects", async () => {
    await bucket.put(
      prefix + "Notes/Apple.md",
      "# Apple\nRevised citrus orchard. [[Plum]]\n",
    );
    await bucket.delete(prefix + "Notes/Pear.md");
    await bucket.put(prefix + "Notes/Plum.md", "# Plum\nRenamed fruit.\n");
    await bucket.put(prefix + "images/chart.png", "revised-image");
    for (const path of [
      "Notes/secret.md",
      "Notes/.hidden.md",
      ".git/config",
      "Other/foreign.md",
      "Notes/unsupported.exe",
    ])
      await bucket.put(prefix + path, "forbidden-synthetic-marker");
    await bucket.put(
      "another-vault/source/Notes/Alien.md",
      "forbidden-synthetic-marker",
    );
    await settle();
    expect((await note("Notes/Pear.md")).status).toBe(404);
    expect(
      (await request(`/chunks/${await core.noteIdFromPath("Notes/Pear.md")}/0`))
        .status,
    ).toBe(404);
    expect((await note("Notes/Plum.md")).status).toBe(200);
    expect(JSON.stringify(await note("Notes/Apple.md"))).toContain("citrus");
    expect(
      JSON.stringify(await search("forbidden-synthetic-marker")),
    ).not.toContain("Alien");
    const sources = (
      await db
        .prepare(
          "SELECT path FROM sources WHERE revision=(SELECT revision FROM deployment WHERE id=1)",
        )
        .all()
    ).results;
    expect(sources.map((s: any) => s.path).sort()).toEqual([
      "Notes/Apple.md",
      "Notes/Plum.md",
      "images/chart.png",
    ]);
    const pointer = (await db
      .prepare("SELECT revision FROM deployment")
      .first())!.revision;
    // Internal snapshot writes do not trigger another rebuild; a second scan is a no-op.
    await settle();
    expect(
      (await db.prepare("SELECT revision FROM deployment").first())!.revision,
    ).toBe(pointer);
    expect(
      await bucket.head("another-vault/source/Notes/Alien.md"),
    ).not.toBeNull();
  });
  it("rejects excluded uploads and unsafe paths before any R2 staging write", async () => {
    const parent = (await db
      .prepare("SELECT revision FROM deployment")
      .first())!.revision;
    for (const path of [
      "Notes/secret.md",
      "Notes/../Escape.md",
      "Notes/.hidden.md",
      "Other/out.md",
    ]) {
      const result = await request(
        "/uploads",
        "POST",
        {
          vaultId: VAULT_ID,
          parentRevision: parent,
          includes: ["Notes"],
          entries: [
            {
              path,
              kind: "note",
              size: 0,
              digest: sha(""),
              updated: "2026-01-01",
            },
          ],
          deletes: [],
        },
        admin,
        randomUUID(),
      );
      expect(result.status).toBeGreaterThanOrEqual(400);
    }
  });
  it("refuses to overwrite direct edits racing an upload and preserves published bytes", async () => {
    const { id } = await create({
      "Notes/Apple.md": "# Planned\nclient version\n",
    });
    await put(id, "Notes/Apple.md", "# Planned\nclient version\n");
    await bucket.put(
      prefix + "Notes/Apple.md",
      "# Concurrent\ndirect version\n",
    );
    await request(`/uploads/${id}/commit`, "POST");
    const result = await request(`/jobs/${id}/advance`, "POST", {
      checkpoint: 1,
    });
    expect(result.data.state).toBe("failed");
    expect(result.data.error.code).toBe("REVISION_CONFLICT");
    expect(
      await (await bucket.get(prefix + "Notes/Apple.md"))!.text(),
    ).toContain("direct version");
    await settle();
    expect(JSON.stringify(await note("Notes/Apple.md"))).toContain(
      "direct version",
    );
  });
  it("fails a target changed during validation, retries on the next cron, and never mixes bytes", async () => {
    await bucket.put(
      prefix + "Notes/Plum.md",
      "# Plum\nintermediate version\n",
    );
    const result = await request("/index", "POST", {});
    let job = result.data;
    for (let n = 0; n < 80 && job.state !== "validating"; n++)
      job = (
        await request(`/jobs/${job.jobId}/advance`, "POST", {
          checkpoint: job.checkpoint,
        })
      ).data;
    expect(job.state).toBe("validating");
    await bucket.put(
      prefix + "Notes/Plum.md",
      "# Plum\nauthoritative version\n",
    );
    for (let n = 0; n < 10 && job.state !== "failed"; n++)
      job = (
        await request(`/jobs/${job.jobId}/advance`, "POST", {
          checkpoint: job.checkpoint,
        })
      ).data;
    expect(job.state).toBe("failed");
    expect(JSON.stringify(await note("Notes/Plum.md"))).toContain(
      "Renamed fruit",
    );
    await settle();
    expect(JSON.stringify(await note("Notes/Plum.md"))).toContain(
      "authoritative version",
    );
  });
  it("applies explicit deletion tombstones idempotently without deleting unrelated source objects", async () => {
    const { id } = await create({}, ["Notes/Plum.md"]);
    const job = (await request(`/uploads/${id}/commit`, "POST")).data;
    await request(`/jobs/${id}/advance`, "POST", {
      checkpoint: job.checkpoint,
    });
    await request(`/uploads/${id}/commit`, "POST");
    await settle();
    expect((await note("Notes/Plum.md")).status).toBe(404);
    expect(
      (await bucket.head(prefix + "Notes/Plum.md"))!.customMetadata?.deleted,
    ).toBe("true");
    expect(await bucket.head(prefix + "Notes/Apple.md")).not.toBeNull();
  });
});

it("resumes durable checkpoints after a simulated terminated worker and bounds repeated termination", async () => {
  const started = (await request("/index", "POST", {})).data;
  await db
    .prepare(
      "UPDATE ingestion_jobs SET lease='synthetic-expired',lease_until=1,attempts=1 WHERE id=?",
    )
    .bind(started.jobId)
    .run();
  const advanced = await request(`/jobs/${started.jobId}/advance`, "POST", {
    checkpoint: started.checkpoint,
  });
  expect(advanced.data.checkpoint).toBeGreaterThan(started.checkpoint);
  await db
    .prepare(
      "UPDATE ingestion_jobs SET lease='synthetic-expired',lease_until=1,attempts=3 WHERE id=?",
    )
    .bind(started.jobId)
    .run();
  const failed = await request(`/jobs/${started.jobId}/advance`, "POST", {
    checkpoint: advanced.data.checkpoint,
  });
  expect(failed.data.error.code).toBe("INDEX_BUDGET_EXCEEDED");
  await settle();
});

it("reclaims expired snapshots/staging incrementally and preserves active/unrelated objects", async () => {
  const before = (await db.prepare("SELECT revision FROM deployment").first())!
    .revision;
  await db
    .prepare("UPDATE snapshots SET created=0 WHERE revision<>?")
    .bind(before)
    .run();
  for (let n = 0; n < 60; n++) {
    const old = await db
      .prepare("SELECT revision FROM snapshots WHERE revision<>?")
      .bind(before)
      .first();
    if (!old) break;
    await tick();
  }
  expect(
    (await db.prepare("SELECT count(*) AS n FROM snapshots").first())!.n,
  ).toBe(1);
  expect(
    (await db.prepare("SELECT revision FROM deployment").first())!.revision,
  ).toBe(before);
  expect((await note("Notes/Apple.md")).status).toBe(200);
  expect(
    await bucket.head("another-vault/source/Notes/Alien.md"),
  ).not.toBeNull();
  const completed = await db
    .prepare(
      "SELECT id FROM ingestion_jobs WHERE kind='upload' AND state='complete' LIMIT 1",
    )
    .first<{ id: string }>();
  await db
    .prepare("UPDATE ingestion_jobs SET created=0 WHERE id=?")
    .bind(completed!.id)
    .run();
  await tick();
  await tick();
  expect(
    await db
      .prepare("SELECT id FROM ingestion_jobs WHERE id=?")
      .bind(completed!.id)
      .first(),
  ).toBeNull();
});

it("accepts immutable manifest pages idempotently and bounds source listing pages", async () => {
  const { id } = await create({});
  const entries = Array.from({ length: 100 }, (_, n) => ({
    path: `images/page-${n}.png`,
    kind: "attachment",
    size: 0,
    digest: sha(""),
    updated: "2026-01-01",
  }));
  const first = await request(`/uploads/${id}/manifest`, "PUT", {
    entries,
    deletes: [],
  });
  expect(first.status).toBe(200);
  expect(
    (await request(`/uploads/${id}/manifest`, "PUT", { entries, deletes: [] }))
      .status,
  ).toBe(200);
  const changed = [{ ...entries[0], digest: sha("changed") }];
  expect(
    (
      await request(`/uploads/${id}/manifest`, "PUT", {
        entries: changed,
        deletes: [],
      })
    ).error.code,
  ).toBe("IDEMPOTENCY_CONFLICT");
  expect(
    (await db
      .prepare("SELECT count(*) AS n FROM ingestion_entries WHERE job=?")
      .bind(id)
      .first())!.n,
  ).toBe(100);
  // A listing can include many excluded keys; only scoped allowed entries are staged.
  for (let n = 0; n < 101; n++)
    await bucket.put(prefix + `Other/excluded-${n}.md`, "synthetic excluded");
  const scan = (await request("/index", "POST", {})).data;
  let job = scan;
  job = (
    await request(`/jobs/${job.jobId}/advance`, "POST", {
      checkpoint: job.checkpoint,
    })
  ).data;
  expect(job.state).toBe("scanning");
  await settle();
  const sources = (
    await db
      .prepare(
        "SELECT path FROM sources WHERE revision=(SELECT revision FROM deployment)",
      )
      .all()
  ).results;
  expect(sources.every((s: any) => !s.path.startsWith("Other/"))).toBe(true);
});

it("fences a policy change during a job before parsing/provider writes", async () => {
  const started = (await request("/index", "POST", {})).data;
  const response = await mf.dispatchFetch(
    `https://vault.example.invalid/jobs/${started.jobId}/advance`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${admin}`,
        "Content-Type": "application/json",
        "X-Synthetic-Policy-Change": "true",
      },
      body: JSON.stringify({ checkpoint: started.checkpoint }),
    },
  );
  const result = (await response.json()) as any;
  expect(result.data.error.code).toBe("CONFIGURATION_CHANGED");
  await settle();
});
it("requires semantic consent when embeddings are mandatory and removes unreferenced expired cache", async () => {
  expect(
    (await request("/index", "POST", { requireEmbeddings: true })).error.code,
  ).toBe("EMBEDDING_UNAVAILABLE");
  await db
    .prepare(
      "INSERT INTO embedding_cache VALUES('synthetic-unreferenced','[]',0)",
    )
    .run();
  await tick();
  expect(
    await db
      .prepare(
        "SELECT key FROM embedding_cache WHERE key='synthetic-unreferenced'",
      )
      .first(),
  ).toBeNull();
});

it("validates guidance UTF-8 before publication and recovers from an invalid direct source", async () => {
  await bucket.put(prefix + "Notes/AGENTS.md", new Uint8Array([255]));
  const initial = (await request("/index", "POST", {})).data;
  let job = initial;
  for (let n = 0; n < 20 && !["complete", "failed"].includes(job.state); n++)
    job = (
      await request(`/jobs/${job.jobId}/advance`, "POST", {
        checkpoint: job.checkpoint,
      })
    ).data;
  expect(job.state).toBe("failed");
  expect(job.error.code).toBe("SOURCE_NOT_UTF8");
  expect((await note("Notes/Apple.md")).status).toBe(200);
  await bucket.put(
    prefix + "Notes/AGENTS.md",
    "# Synthetic guidance\nUse explicit retrieval.\n",
  );
  await settle();
  const guidance = await request("/agent-guidance/Notes%2FAGENTS.md");
  expect(guidance.status).toBe(200);
});

it("returns INDEX_BUSY when an explicit rebuild loses writer admission", async () => {
  const parent = (await db.prepare("SELECT revision FROM deployment").first())!
    .revision;
  for (const [route, input] of [
    ["/reindex", {}],
    ["/index", { newScan: true }],
  ] as const) {
    const response = await mf.dispatchFetch(
      "https://vault.example.invalid" + route,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${admin}`,
          "Content-Type": "application/json",
          "X-Synthetic-Lost-Admission": "true",
        },
        body: JSON.stringify(input),
      },
    );
    const result = (await response.json()) as any;
    expect(response.status).toBe(409);
    expect(result.error.code).toBe("INDEX_BUSY");
  }
  expect(
    (await db.prepare("SELECT revision FROM deployment").first())!.revision,
  ).toBe(parent);
});

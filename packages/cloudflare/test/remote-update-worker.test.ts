import { it, expect } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { randomBytes, randomUUID } from "node:crypto";

it("guards synthetic setup/cleanup and bounds fixture writes", async () => {
  const bundle = await build({
    entryPoints: ["test/remote-update-worker.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    tsconfig: "tsconfig.json",
  });
  const admin = randomBytes(32).toString("hex"),
    vault = randomUUID();
  for (const enabled of [false, true]) {
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundle.outputFiles[0]!.text,
        compatibilityDate: "2026-10-28",
        d1Databases: { DB: "verification-guard" },
        r2Buckets: { SOURCE: "verification-guard" },
        ratelimits: {
          REQUEST_LIMITER: {
            namespace_id: "1049",
            simple: { limit: 1000, period: 60 },
          },
        },
        bindings: {
          VAULT_ID: vault,
          READ_TOKEN: randomBytes(32).toString("hex"),
          ADMIN_TOKEN: admin,
          INCLUDE_PATHS: '["Notes","images"]',
          EXCLUDE_PATHS: "[]",
          ALLOWED_ORIGINS: "[]",
          PROFILE_VALUE_ALLOWLIST: "[]",
          EXTERNAL_EMBEDDING_CONSENT: "false",
          INGESTION_ENABLED: "true",
          EMBEDDING_MODEL_REVISION: "operator-v1",
          SYNTHETIC_VERIFICATION: String(enabled),
          TRIAL_NAME: "vault-agent-trial-0000000000",
        },
      }),
    );
    try {
      const bucket = await mf.getR2Bucket("SOURCE");
      await bucket.put(
        "synthetic-sentinel",
        "Keep unless authorized for this disposable trial",
      );
      const request = (route: string, body?: unknown, authenticated = true) =>
        mf.dispatchFetch("https://synthetic.example.invalid" + route, {
          method: body === undefined ? "GET" : "POST",
          headers: {
            ...(authenticated ? { Authorization: `Bearer ${admin}` } : {}),
            "Content-Type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
      expect((await request("/__verify/purge", {}, false)).status).toBe(403);
      expect(await bucket.head("synthetic-sentinel")).not.toBeNull();
      if (!enabled) {
        expect((await request("/__verify/purge", {})).status).toBe(403);
        expect(await bucket.head("synthetic-sentinel")).not.toBeNull();
        continue;
      }
      expect(
        (await request("/__verify/seed", { start: 0, count: 11 })).status,
      ).toBe(400);
      expect(
        (await request("/__verify/seed", { start: -1, count: 1 })).status,
      ).toBe(400);
      expect(
        (await request("/__verify/seed", { start: 0, count: 1 })).status,
      ).toBe(200);
      const note = await bucket.get(`${vault}/source/Notes/Note-0000.md`);
      expect(note!.size).toBe(1521);
      expect(
        (await request("/__verify/change", { kind: "invalid" })).status,
      ).toBe(400);
      expect((await request("/__verify/purge", {})).status).toBe(200);
      expect((await bucket.list()).objects).toHaveLength(0);
    } finally {
      await mf.dispose();
    }
  }
});

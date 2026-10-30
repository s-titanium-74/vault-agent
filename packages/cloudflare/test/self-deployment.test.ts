import { describe, it, expect } from "vitest";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

describe("operator deployment tools", () => {
  it("generates a private config, preserves vault identity and requires explicit semantic selection", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vault-agent-setup-"));
    try {
      const scripts = path.join(root, "packages/cloudflare/scripts");
      await mkdir(scripts, { recursive: true });
      await copyFile("../../wrangler.json", path.join(root, "wrangler.json"));
      await copyFile(
        "scripts/configure-deployment.mjs",
        path.join(scripts, "configure-deployment.mjs"),
      );
      const run = (...args: string[]) =>
        spawnSync(
          process.execPath,
          [path.join(scripts, "configure-deployment.mjs"), ...args],
          { encoding: "utf8" },
        );
      expect(
        run("test-trial", "00000000-0000-0000-0000-000000000000").status,
      ).toBe(2);
      expect(
        run("test-trial", "11111111-1111-4111-8111-111111111111").status,
      ).toBe(0);
      const file = path.join(root, ".cloudflare/wrangler.jsonc");
      const before = await readFile(file, "utf8");
      const config = JSON.parse(before);
      expect(config.vars.VAULT_ID).toMatch(/^[a-f0-9-]{36}$/);
      expect(config.vars.EXTERNAL_EMBEDDING_CONSENT).toBe("false");
      expect(config.ai).toBeUndefined();
      expect(config.vectorize).toBeUndefined();
      expect(config.limits).toBeUndefined();
      expect(config.triggers.crons).toEqual(["* * * * *"]);
      expect(path.resolve(root, ".cloudflare", config.main)).toBe(
        path.join(root, "packages/cloudflare/src/index.ts"),
      );
      expect(
        run(
          "other-trial",
          "22222222-2222-4222-8222-222222222222",
          "semantic",
          "paid",
        ).status,
      ).not.toBe(0);
      expect(await readFile(file, "utf8")).toBe(before);
      await rm(file);
      expect(
        run(
          "test-trial",
          "11111111-1111-4111-8111-111111111111",
          "semantic",
          "paid",
        ).status,
      ).toBe(0);
      const semantic = JSON.parse(await readFile(file, "utf8"));
      expect(semantic.ai.binding).toBe("AI");
      expect(semantic.vectorize[0].binding).toBe("VECTORS");
      expect(semantic.vars.EXTERNAL_EMBEDDING_CONSENT).toBe("true");
      expect(semantic.limits.cpu_ms).toBe(1000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("never deploys after failed migrations and forwards the same binding configuration", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vault-agent-deploy-"));
    try {
      const scripts = path.join(root, "scripts"),
        bin = path.join(root, "node_modules/wrangler/bin");
      await mkdir(scripts, { recursive: true });
      await mkdir(bin, { recursive: true });
      await copyFile("scripts/deploy.mjs", path.join(scripts, "deploy.mjs"));
      await copyFile(
        "scripts/wrangler.mjs",
        path.join(scripts, "wrangler.mjs"),
      );
      await writeFile(
        path.join(bin, "wrangler.js"),
        `const fs=require('node:fs');fs.appendFileSync(process.env.TRACE, JSON.stringify(process.argv.slice(2))+'\\n');if(process.argv[2]==='d1' && process.env.FAIL==='true')process.exit(1);`,
      );
      const trace = path.join(root, "trace");
      const run = (fail: boolean) =>
        spawnSync(
          process.execPath,
          [
            path.join(scripts, "deploy.mjs"),
            "--config",
            path.resolve("operator.jsonc"),
          ],
          { env: { ...process.env, TRACE: trace, FAIL: String(fail) } },
        );
      const dry = spawnSync(
        process.execPath,
        [path.join(scripts, "deploy.mjs"), "--dry-run"],
        { env: { ...process.env, TRACE: trace } },
      );
      expect(dry.status).toBe(2);
      await expect(readFile(trace, "utf8")).rejects.toThrow();
      expect(run(true).status).toBe(1);
      expect(
        (await readFile(trace, "utf8"))
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l)),
      ).toEqual([
        [
          "d1",
          "migrations",
          "apply",
          "DB",
          "--remote",
          "--config",
          path.resolve("operator.jsonc"),
        ],
      ]);
      await rm(trace);
      expect(run(false).status).toBe(0);
      const calls = (await readFile(trace, "utf8"))
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l));
      expect(calls[1]).toEqual([
        "deploy",
        "--config",
        path.resolve("operator.jsonc"),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("refuses to overwrite an existing sample vault", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "vault-agent-sample-"));
    try {
      const vault = path.join(root, "vault");
      const run = () =>
        spawnSync(process.execPath, ["scripts/sample-vault.mjs", vault], {
          encoding: "utf8",
        });
      expect(run().status).toBe(0);
      const file = path.join(vault, "Notes/Note-0000.md");
      await writeFile(file, "operator-edited synthetic note");
      expect(run().status).not.toBe(0);
      expect(await readFile(file, "utf8")).toBe(
        "operator-edited synthetic note",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { expect, it, vi } from "vitest";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import { readFile, readdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SyntheticPCloud } from "../../core/test/helpers/pcloud.js";
import { DEFAULT_CONFIG } from "../../core/src/config.js";
import { indexVault } from "../../core/src/indexer.js";
import { IndexStore, getIndexPath } from "../../core/src/index-store.js";
import * as core from "../../core/src/portable/index.js";

it.each(["review", "direct"] as const)(
  "indexes the same pCloud corpus in SQLite and D1 without an R2 binding with %s writes",
  async (mode) => {
    const api = new SyntheticPCloud();
    api.set("Notes/Apple.md", "# Apple\n\nSynthetic orchard. [[Pear]]\n");
    api.set("Notes/Pear.md", "# Pear\n\nSynthetic fruit.\n");
    api.set("Private/Skip.md", "# Excluded synthetic note\n");
    api.set("Notes/AGENTS.md", "# Synthetic rule");
    api.set("Private/AGENTS.md", "# Excluded synthetic rule");
    api.setBytes("Notes/synthetic.pdf", Uint8Array.of(0, 255, 128, 65));
    const bundle = await build({
      entryPoints: ["test/ingestion-worker.ts"],
      bundle: true,
      write: false,
      format: "esm",
      platform: "browser",
      tsconfig: "tsconfig.json",
    });
    const admin = "a".repeat(64);
    let loseUploadResponse = false;
    const mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: bundle.outputFiles[0]!.text,
        compatibilityDate: "2026-10-29",
        d1Databases: { DB: "pcloud-synthetic" },
        // Deliberately no r2Buckets option.
        outboundService: async (request) => {
          const response = await api.fetch(request.url, {
            method: request.method,
            body: request.headers
              .get("Content-Type")
              ?.startsWith("multipart/form-data")
              ? await request.formData()
              : request.method === "POST"
                ? await request.text()
                : undefined,
          });
          if (
            loseUploadResponse &&
            new URL(request.url).pathname === "/uploadfile"
          ) {
            loseUploadResponse = false;
            return new Response(null, { status: 502 });
          }
          return response;
        },
        ratelimits: {
          REQUEST_LIMITER: {
            namespace_id: "1051",
            simple: { limit: 100000, period: 60 },
          },
        },
        bindings: {
          VAULT_ID: "11111111-1111-4111-8111-111111111111",
          READ_TOKEN: "b".repeat(64),
          ADMIN_TOKEN: admin,
          INCLUDE_PATHS: '["Notes"]',
          EXCLUDE_PATHS: "[]",
          ALLOWED_ORIGINS: "[]",
          PROFILE_VALUE_ALLOWLIST: "[]",
          INGESTION_ENABLED: "true",
          WRITE_ENABLED: "true",
          WRITE_MODE: mode,
          READWRITE_TOKEN: "c".repeat(64),
          EXTERNAL_EMBEDDING_CONSENT: "false",
          EMBEDDING_MODEL_REVISION: "operator-v1",
          SOURCE_PROVIDER: "pcloud",
          PCLOUD_REGION: "eu",
          PCLOUD_FOLDER_ID: "1",
          PCLOUD_ACCESS_TOKEN: "synthetic-token",
        },
      }),
    );
    const dir = await mkdtemp(path.join(os.tmpdir(), "pcloud-parity-"));
    let local: IndexStore | undefined;
    try {
      const db = await mf.getD1Database("DB");
      for (const file of (await readdir("migrations"))
        .filter((f) => f.endsWith(".sql"))
        .sort())
        for (const sql of (await readFile("migrations/" + file, "utf8"))
          .replace(/--[^\n]*/g, "")
          .split(";")
          .filter((s) => s.trim()))
          await db.prepare(sql).run();
      const request = async (route: string, input?: unknown) => {
        const response = await mf.dispatchFetch(
          "https://vault.example.invalid" + route,
          {
            method: input === undefined ? "GET" : "POST",
            headers: {
              Authorization: `Bearer ${admin}`,
              "Content-Type": "application/json",
            },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
          },
        );
        return { status: response.status, ...((await response.json()) as any) };
      };

      const metadataStart = api.requests.length;
      expect(await request("/agent-guidance")).toMatchObject({
        status: 200,
        data: {
          guidance: [
            expect.objectContaining({
              path: "Notes/AGENTS.md",
              scope: "Notes",
            }),
          ],
        },
        revision: { snapshot: null },
      });
      expect(await request("/attachments/Notes/synthetic.pdf")).toMatchObject({
        status: 200,
        data: {
          contentType: "application/pdf",
          size: 4,
          downloadAvailable: true,
        },
      });
      expect(
        api.requests
          .slice(metadataStart)
          .every((r) => r.method === "/listfolder"),
      ).toBe(true);
      expect(await request("/agent-guidance/Private/AGENTS.md")).toMatchObject({
        status: 403,
        error: { code: "SOURCE_EXCLUDED" },
      });
      expect(await request("/agent-guidance/Notes/AGENTS.md")).toMatchObject({
        status: 200,
        data: { content: "# Synthetic rule" },
      });
      const bytes = await mf.dispatchFetch(
        "https://vault.example.invalid/attachments/Notes/synthetic.pdf?download=true",
        { headers: { Authorization: `Bearer ${admin}` } },
      );
      expect(bytes.status).toBe(200);
      expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(
        Uint8Array.of(0, 255, 128, 65),
      );
      expect(bytes.headers.get("X-Vault-Source-Version")).toMatch(
        /^[a-f0-9]{64}$/,
      );
      expect(await request("/status")).toMatchObject({
        data: {
          deployment: {
            capabilities: {
              attachments: true,
              guidance: true,
              attachmentMutations: true,
            },
          },
        },
      });
      const run = async () => {
        let job = (await request("/index", {})).data;
        for (
          let n = 0;
          n < 100 && !["complete", "failed"].includes(job.state);
          n++
        )
          job = (
            await request(`/jobs/${job.jobId}/advance`, {
              checkpoint: job.checkpoint,
            })
          ).data;
        return job;
      };
      const config = structuredClone(DEFAULT_CONFIG);
      config.index.dir = dir;
      config.vault.pcloud = {
        region: "eu",
        folder_id: "1",
        access_token: "synthetic-token",
        includes: ["Notes"],
        poll_seconds: 300,
      };
      vi.stubGlobal("fetch", api.fetch);
      const compare = async () => {
        await indexVault(config);
        local ??= await IndexStore.open(getIndexPath(config));
        const cloudRows = (
          await db
            .prepare(
              "SELECT data FROM notes WHERE revision=(SELECT revision FROM deployment) ORDER BY path",
            )
            .all<{ data: string }>()
        ).results.map((r) => JSON.parse(r.data));
        const normalize = (r: core.IndexRow) => ({
          path: r.path,
          note_id: r.note_id,
          content_hash: r.content_hash,
          links_json: r.links_json,
          body_text: r.body_text,
        });
        expect(cloudRows.map(normalize)).toEqual(
          local
            .getAllNotes()
            .sort((a, b) => String(a.path).localeCompare(String(b.path)))
            .map(normalize),
        );
      };
      const initial = await run();
      expect(initial.error).toBeNull();
      expect(initial.state).toBe("complete");
      await compare();
      const id = await core.noteIdFromPath("Notes/Apple.md");
      const searchStart = api.requests.length;
      expect(
        (await request("/search", { query: "orchard", mode: "lexical" }))
          .status,
      ).toBe(200);
      expect(api.requests).toHaveLength(searchStart);
      expect((await request(`/notes/${id}`)).data.content).toContain(
        "Synthetic orchard",
      );
      const note = (await request(`/notes/${id}`)).data;
      expect(
        (await request(`/chunks/${id}/0?expected_version=${note.version}`))
          .status,
      ).toBe(200);
      const before = await db
        .prepare("SELECT data FROM notes WHERE path='Notes/Pear.md'")
        .first();
      api.set("Notes/Apple.md", "# Apple\n\nSynthetic gardens. [[Pear]]\n");
      expect(
        (await request(`/chunks/${id}/0?expected_version=${note.version}`))
          .status,
      ).toBe(409);
      expect((await request(`/notes/${id}`)).data.index_state).toBe("pending");
      api.requests.length = 0;
      const update = await run();
      expect(
        api.requests.filter((r) => r.host === api.downloadHost),
      ).toHaveLength(1);
      expect(update.state).toBe("complete");
      expect(update.updatePath).toBe("incremental");
      await compare();
      expect(
        await db
          .prepare("SELECT data FROM notes WHERE path='Notes/Pear.md'")
          .first(),
      ).toEqual(before);
      await db
        .prepare(
          "INSERT INTO delta_fallbacks SELECT signature FROM ingestion_state WHERE id=1",
        )
        .run();
      await db
        .prepare("UPDATE ingestion_state SET signature=NULL WHERE id=1")
        .run();
      api.requests.length = 0;
      expect(await run()).toMatchObject({
        state: "complete",
        updatePath: "rebuild-recovery",
      });
      expect(
        api.requests.filter((r) => r.host === api.downloadHost),
      ).toHaveLength(0);
      await compare();
      // Metadata-only polling intentionally skips a body whose provider marker did not change.
      const pear = api.files.get("Notes/Pear.md")!;
      pear.text = "# Pear\n\nSynthetic plant.\n";
      api.requests.length = 0;
      expect(await run()).toMatchObject({ state: "complete" });
      expect(
        api.requests.filter((r) => r.host === api.downloadHost),
      ).toHaveLength(0);
      await compare();
      api.set("Notes/Plum.md", api.files.get("Notes/Pear.md")!.text);
      api.files.delete("Notes/Pear.md");
      expect(await run()).toMatchObject({ state: "complete" });
      await compare();
      const prior = (await request("/status")).data.deployment.activeRevision;
      api.partial = true;
      expect((await run()).state).toBe("failed");
      expect((await request("/status")).data.deployment.activeRevision).toBe(
        prior,
      );
      api.partial = false;
      expect(await run()).toMatchObject({ state: "complete" });
      // Stop between validation and publication, then mutate the source.
      api.set("Notes/New.md", "# New\n");
      let job = (await request("/index", {})).data;
      for (
        let n = 0;
        n < 100 &&
        job.state !== "publishing" &&
        !["failed", "complete"].includes(job.state);
        n++
      )
        job = (
          await request(`/jobs/${job.jobId}/advance`, {
            checkpoint: job.checkpoint,
          })
        ).data;
      expect(job.state).toBe("publishing");
      api.set("Notes/Race.md", "# Race\n");
      job = (
        await request(`/jobs/${job.jobId}/advance`, {
          checkpoint: job.checkpoint,
        })
      ).data;
      expect(job.state).toBe("failed");
      expect((await request("/status")).data.deployment.activeRevision).toBe(
        prior,
      );
      expect(await run()).toMatchObject({ state: "complete" });
      await compare();
      expect(
        (await db.prepare("SELECT count(*) AS n FROM source_objects").first())!
          .n,
      ).toBe(0);
      expect(
        (await db.prepare("SELECT count(*) AS n FROM retired_objects").first())!
          .n,
      ).toBe(0);
      await db
        .prepare(
          "UPDATE snapshots SET created=0 WHERE revision NOT IN (SELECT revision FROM deployment)",
        )
        .run();
      await db
        .prepare(
          "UPDATE ingestion_jobs SET created=0 WHERE id IS NOT (SELECT job FROM ingestion_state)",
        )
        .run();
      for (let n = 0; n < 12; n++)
        expect((await request("/__tick")).status).toBe(200);
      // Cron checks pCloud metadata without requiring a bucket.
      api.set("Notes/Plum.md", "# Pear\n\nSynthetic bloom.\n");
      for (let n = 0; n < 12; n++)
        expect((await request("/__tick")).status).toBe(200);
      expect(
        (await db
          .prepare(
            "SELECT data FROM notes WHERE path='Notes/Plum.md' AND revision=(SELECT revision FROM deployment)",
          )
          .first<{ data: string }>())!.data,
      ).toContain("Synthetic bloom.");
      await compare();
      const tool = async (
        name: string,
        args: unknown,
        token = "c".repeat(64),
      ) => {
        const response = await mf.dispatchFetch(
          "https://vault.example.invalid/mcp",
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
              Accept: "application/json, text/event-stream",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name, arguments: args },
            }),
          },
        );
        const body = (await response.json()) as any;
        if (body.error) return { error: body.error };
        return JSON.parse(body.result.content[0].text);
      };

      expect(await tool("vault_guidance_list", {})).toMatchObject({
        guidance: [expect.objectContaining({ path: "Notes/AGENTS.md" })],
      });
      expect(
        await tool("vault_guidance_get", { path: "Notes/AGENTS.md" }),
      ).toMatchObject({
        content: "# Synthetic rule",
      });
      const attachmentPath = "Notes/synthetic.pdf";
      const fileArgs = { vaultRelativePath: attachmentPath };
      const metadata = await tool("get_attachment", fileArgs, "b".repeat(64));
      expect(metadata).toMatchObject({
        size: 4,
        contentType: "application/pdf",
      });
      expect(metadata.content).toBeUndefined();
      const download = await tool("get_attachment", {
        ...fileArgs,
        download: true,
      });
      expect(download).toMatchObject({
        content: "AP+AQQ==",
        version: bytes.headers.get("X-Vault-Source-Version"),
        encoding: "base64",
      });
      const changeAttachment = async (operation: unknown) => {
        const operations = [operation];
        const plan = await tool("preview_changes", {
          operations,
          preview: mode === "review",
        });
        return (
          await tool("apply_changes", {
            operations,
            operation_id: plan.operation_id,
            preview_binding: plan.preview_binding,
          })
        ).results[0];
      };
      const replace = {
        type: "upload_attachment",
        path: attachmentPath,
        content_base64: "gAH/",
        replace: true,
        expected_version: download.version,
      };
      expect(
        await tool(
          "preview_changes",
          { operations: [replace] },
          "b".repeat(64),
        ),
      ).toMatchObject({ error: { code: "READWRITE_REQUIRED" } });
      const replaced = await changeAttachment(replace);
      expect(replaced.status).toBe("applied");
      expect(replaced.index_state).toBeUndefined();
      expect(
        await tool("get_attachment", { ...fileArgs, download: true }),
      ).toMatchObject({
        content: replace.content_base64,
        version: replaced.version,
      });
      expect(
        await changeAttachment({
          type: "delete_file",
          path: attachmentPath,
          expected_version: download.version,
        }),
      ).toMatchObject({ status: "failed", code: "SOURCE_REVISION_MISMATCH" });
      expect(
        await changeAttachment({
          type: "delete_file",
          path: attachmentPath,
          expected_version: replaced.version,
        }),
      ).toMatchObject({ status: "applied" });
      expect(await request("/attachments/Notes/synthetic.pdf")).toMatchObject({
        status: 404,
      });
      const target = "Notes/Created/Synthetic.md";
      const operations = [
        {
          type: "create_note",
          path: target,
          content: "# Synthetic\n\nUnique mutation marker.",
        },
      ];
      const uploadsBefore = api.requests.filter(
        (r) => r.method === "/uploadfile",
      ).length;
      expect(
        await tool(
          "preview_changes",
          { operations, preview: false },
          "b".repeat(64),
        ),
      ).toMatchObject({ error: { code: "READWRITE_REQUIRED" } });
      expect(
        api.requests.filter((r) => r.method === "/uploadfile"),
      ).toHaveLength(uploadsBefore);
      const preview = async (operations: unknown[]) =>
        tool("preview_changes", { operations, preview: mode === "review" });
      if (mode === "review")
        expect(
          await tool("preview_changes", { operations, preview: false }),
        ).toMatchObject({ error: { data: { errorCode: "PREVIEW_REQUIRED" } } });
      const proposal = await preview(operations);
      if (mode === "direct") {
        expect(proposal.preview).toBeUndefined();
        expect(proposal.preview_binding).toBeUndefined();
      }
      const mismatched = await tool("apply_changes", {
        operations: [
          { ...operations[0], content: "# Different synthetic request" },
        ],
        operation_id: proposal.operation_id,
        preview_binding: proposal.preview_binding,
      });
      expect(mismatched).toMatchObject({
        error: { data: { errorCode: "IDEMPOTENCY_CONFLICT" } },
      });
      const applied = await tool("apply_changes", {
        operations,
        operation_id: proposal.operation_id,
        preview_binding: proposal.preview_binding,
      });
      expect(applied.results[0]).toMatchObject({
        status: "applied",
        index_state: "pending",
      });
      expect(
        api.requests.filter((r) => r.method === "/uploadfile"),
      ).toHaveLength(uploadsBefore + 1);
      expect(
        await tool("apply_changes", {
          operations,
          operation_id: proposal.operation_id,
          preview_binding: proposal.preview_binding,
        }),
      ).toEqual(applied);
      expect(await run()).toMatchObject({ state: "complete" });
      expect(
        (
          await tool("get_change_status", {
            operation_id: proposal.operation_id,
          })
        ).results[0],
      ).toMatchObject({
        status: "applied",
        index_state: "fresh",
      });
      await compare();
      const createdId = await core.noteIdFromPath(target);
      const saved = (await request(`/notes/${createdId}`)).data;
      const raced = [
        {
          type: "replace_note",
          path: target,
          expected_version: saved.version,
          content: "# Replacement",
        },
      ];
      const racedPlan = await preview(raced);
      api.set(target, "# External synthetic edit");
      const racedResult = await tool("apply_changes", {
        operations: raced,
        operation_id: racedPlan.operation_id,
        preview_binding: racedPlan.preview_binding,
      });
      expect(racedResult.results[0]).toMatchObject({
        status: "failed",
        code: "SOURCE_REVISION_MISMATCH",
      });
      expect(
        api.requests.filter((r) => r.method === "/uploadfile"),
      ).toHaveLength(uploadsBefore + 1);
      const latest = (await request(`/notes/${createdId}`)).data;
      const stale = [
        {
          type: "replace_note",
          path: target,
          expected_version: "0".repeat(64),
          content: "# Stale",
        },
      ];
      const stalePreview = await preview(stale);
      const staleResult = await tool("apply_changes", {
        operations: stale,
        operation_id: stalePreview.operation_id,
        preview_binding: stalePreview.preview_binding,
      });
      expect(staleResult.results[0]).toMatchObject({
        status: "failed",
        code: "SOURCE_REVISION_MISMATCH",
      });
      const deletion = [
        { type: "delete_file", path: target, expected_version: latest.version },
      ];
      const deletePreview = await preview(deletion);
      const deleted = await tool("apply_changes", {
        operations: deletion,
        operation_id: deletePreview.operation_id,
        preview_binding: deletePreview.preview_binding,
      });
      expect(deleted.results[0]).toMatchObject({ status: "applied" });
      expect((await request(`/notes/${createdId}`)).status).toBe(404);
      expect(await run()).toMatchObject({ state: "complete" });
      expect(
        (
          await tool("get_change_status", {
            operation_id: deletePreview.operation_id,
          })
        ).results[0],
      ).toMatchObject({
        status: "applied",
        index_state: "fresh",
      });
      await compare();
      const countUploads = () =>
        api.requests.filter((r) => r.method === "/uploadfile").length;
      const uploadedBefore = countUploads();
      const interrupted = await preview(operations);
      loseUploadResponse = true;
      const interruptedResult = await tool("apply_changes", {
        operations,
        operation_id: interrupted.operation_id,
        preview_binding: interrupted.preview_binding,
      });
      expect(interruptedResult.results[0]).toMatchObject({
        status: "reconciling",
      });
      expect(
        await tool("apply_changes", {
          operations,
          operation_id: interrupted.operation_id,
          preview_binding: interrupted.preview_binding,
        }),
      ).toEqual(interruptedResult);
      expect(countUploads()).toBe(uploadedBefore + 1);
      await db
        .prepare(
          "UPDATE r2_mutation_items SET retry_after=0 WHERE operation_id=?",
        )
        .bind(interrupted.operation_id)
        .run();
      expect((await request("/__tick")).status).toBe(200);
      expect(
        (
          await tool("get_change_status", {
            operation_id: interrupted.operation_id,
          })
        ).results[0],
      ).toMatchObject({
        status: "applied",
      });
      expect(countUploads()).toBe(uploadedBefore + 1);
      expect(await run()).toMatchObject({ state: "complete" });
      await compare();
      expect(
        (await request("/status")).data.deployment.capabilities.upload,
      ).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      local?.close();
      await mf.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  },
  60000,
);

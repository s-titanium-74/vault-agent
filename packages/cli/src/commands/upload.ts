import { Command } from "commander";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { loadConfig, envPaths } from "@vault-agent/core";
import { FilesystemSource } from "@vault-agent/core/local";
import {
  sourcePolicy,
  uploadKind,
  uploadLimit,
  DEFAULT_EXCLUDE_PATTERNS,
  type SourceEntry,
} from "@vault-agent/core/portable";
import type { CliContext } from "../context.js";
import { headersWithAuth } from "../http.js";

type Plan = {
  id: string;
  vaultId: string;
  endpoint: string;
  root: string;
  includes: string[];
  excludes: string[];
  entries: SourceEntry[];
  deletes: string[];
  parentRevision?: string | null;
  requireEmbeddings: boolean;
  indexJobId?: string;
  complete?: boolean;
};
type Job = {
  jobId: string;
  state: string;
  checkpoint: number;
  targetRevision: string;
  error: { code: string } | null;
};
const uuid =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export function uploadEndpoint(value: string) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error("INVALID_UPLOAD_ENDPOINT");
  return url.origin;
}
export async function selectUpload(
  root: string,
  vaultId: string,
  includes: string[],
  excludes: string[],
) {
  if (!uuid.test(vaultId) || !includes.length)
    throw new Error("UPLOAD_SCOPE_REQUIRED");
  sourcePolicy(includes, excludes);
  const source = new FilesystemSource(root, vaultId, includes, excludes);
  const entries: SourceEntry[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await source.list({ limit: 100, cursor });
    for (const entry of page.items) {
      const kind = uploadKind(entry.path);
      if (!kind) {
        skipped.push({ path: entry.path, reason: "unsupported_type" });
        continue;
      }
      if (entry.size > uploadLimit(kind)) {
        skipped.push({ path: entry.path, reason: "too_large" });
        continue;
      }
      entries.push(entry);
      if (entries.length > 500) throw new Error("INDEX_BUDGET_EXCEEDED");
    }
    cursor = page.cursor;
  } while (cursor);
  return { entries, skipped };
}
const wireEntry = (e: SourceEntry) => ({
  path: e.path,
  kind: e.kind,
  size: e.size,
  digest: e.revision,
  updated: e.updated,
});
export async function driveCloudJob(
  endpoint: string,
  key: string,
  initial: Job,
) {
  let job = initial;
  for (let n = 0; n < 20000; n++) {
    if (job.state === "complete") return job;
    if (job.state === "failed")
      throw new Error(job.error?.code ?? "INGESTION_FAILED");
    await new Promise((resolve) => setTimeout(resolve, 1000));
    job = (await cloudRequest(
      endpoint,
      key,
      `/jobs/${job.jobId}/advance`,
      "POST",
      { checkpoint: job.checkpoint },
    )) as Job;
  }
  throw new Error("UPLOAD_PENDING_USE_RESUME");
}
export async function uploadFetch(url: string, init: RequestInit) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(30000),
    });
    if (attempt === 2 || (response.status !== 429 && response.status < 500))
      return response;
    const retry = response.headers.get("Retry-After");
    const delay = retry
      ? /^\d+(\.\d+)?$/.test(retry)
        ? Number(retry) * 1000
        : Date.parse(retry) - Date.now()
      : 1000 * 2 ** attempt;
    if (!Number.isFinite(delay) || delay < 0 || delay > 300000) return response;
    await response.body?.cancel();
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  throw new Error("UPLOAD_FAILED");
}
export async function cloudRequest(
  endpoint: string,
  key: string,
  route: string,
  method = "GET",
  body?: unknown,
  id?: string,
) {
  const response = await uploadFetch(endpoint + route, {
    method,
    redirect: "error",
    signal: AbortSignal.timeout(30000),
    headers: {
      ...headersWithAuth(key),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(id ? { "Idempotency-Key": id } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      typeof result?.error?.code === "string"
        ? result.error.code
        : "UPLOAD_FAILED",
    );
  return result.data;
}
async function save(file: string, data: unknown) {
  const temp = file + "." + randomUUID() + ".tmp";
  await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
  await rename(temp, file);
}
export function registerUploadCommand(program: Command, context: CliContext) {
  program
    .command("upload")
    .description("Explicitly publish selected files to a cloud deployment")
    .option("--vault-id <uuid>", "Cloud deployment vault identity")
    .option("--include <path...>", "Explicit relative paths or directories")
    .option("--exclude <pattern...>", "Additional exclusion rules")
    .option("--dry-run", "Save an offline upload plan without network requests")
    .option(
      "--delete-removed",
      "Remove previously managed paths missing from the selected scope",
    )
    .option("--require-embeddings", "Require a complete semantic generation")
    .option("--resume <plan-id>", "Resume a saved user-local plan")
    .option("--json", "Output compact metadata as JSON")
    .action(async (opts) => {
      let resumeId: string | undefined;
      try {
        const cfg = loadConfig(context.resolveConfigPath());
        const endpoint = uploadEndpoint(context.resolveEndpoint(cfg));
        const key = context.resolveApiKey(cfg);
        const dir = path.join(envPaths().data, "uploads");
        await mkdir(dir, { recursive: true, mode: 0o700 });
        let plan: Plan;
        let skipped: { path: string; reason: string }[] = [];
        if (opts.resume) {
          if (!uuid.test(opts.resume)) throw new Error("INVALID_PLAN");
          plan = JSON.parse(
            await readFile(path.join(dir, opts.resume + ".json"), "utf8"),
          );
          if (
            plan.endpoint !== endpoint ||
            plan.root !== cfg.vault.root ||
            (opts.vaultId && opts.vaultId !== plan.vaultId)
          )
            throw new Error("UPLOAD_PLAN_CHANGED");
          const selected = await selectUpload(
            plan.root,
            plan.vaultId,
            plan.includes,
            plan.excludes,
          );
          if (
            JSON.stringify(selected.entries) !== JSON.stringify(plan.entries) ||
            selected.skipped.some((e) => e.reason === "too_large")
          )
            throw new Error("UPLOAD_PLAN_CHANGED");
          skipped = selected.skipped;
        } else {
          const includes = opts.include ?? [];
          const excludes = [...cfg.vault.exclude, ...(opts.exclude ?? [])];
          const selection = await selectUpload(
            cfg.vault.root,
            opts.vaultId ?? "",
            includes,
            excludes,
          );
          skipped = selection.skipped;
          plan = {
            id: randomUUID(),
            vaultId: opts.vaultId,
            endpoint,
            root: cfg.vault.root,
            includes,
            excludes,
            entries: selection.entries,
            deletes: [],
            requireEmbeddings: !!opts.requireEmbeddings,
          };
          if (opts.deleteRemoved) {
            const previousFile = path.join(
              dir,
              createHash("sha256")
                .update(JSON.stringify([endpoint, plan.vaultId]))
                .digest("hex") + ".manifest.json",
            );
            let previous: string[] = [];
            try {
              previous = JSON.parse(await readFile(previousFile, "utf8"));
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
            const selected = new Set(plan.entries.map((e) => e.path));
            const allowed = sourcePolicy(includes, excludes);
            plan.deletes = previous.filter(
              (p) => allowed(p) && uploadKind(p) && !selected.has(p),
            );
          }
        }
        const planFile = path.join(dir, plan.id + ".json");
        await save(planFile, plan);
        resumeId = plan.id;
        if (opts.dryRun) {
          console.log(
            JSON.stringify(
              {
                planId: plan.id,
                target: endpoint,
                vaultId: plan.vaultId,
                files: plan.entries.map(({ path, kind, size }) => ({
                  path,
                  kind,
                  size,
                })),
                count: plan.entries.length,
                bytes: plan.entries.reduce((sum, e) => sum + e.size, 0),
                deletes: plan.deletes,
                excludes: [...DEFAULT_EXCLUDE_PATTERNS, ...plan.excludes],
                skipped,
                destinations: {
                  storage: "Cloudflare R2 and D1",
                  semantic:
                    "Workers AI and Vectorize only if separately enabled in the deployment; remote setting unverified offline",
                },
              },
              null,
              2,
            ),
          );
          return;
        }
        if (skipped.some((e) => e.reason === "too_large"))
          throw new Error("UPLOAD_TOO_LARGE");
        if (!key) throw new Error("ADMIN_TOKEN_REQUIRED");
        if (plan.complete) {
          console.log(JSON.stringify({ planId: plan.id, state: "complete" }));
          return;
        }
        if (plan.parentRevision === undefined) {
          const status = await cloudRequest(endpoint, key, "/status");
          plan.parentRevision = status.deployment?.activeRevision ?? null;
          await save(planFile, plan);
        }
        // Both create and additional manifest pages contain at most 100 operations.
        const operations = [
          ...plan.entries.map((entry) => ({ entry })),
          ...plan.deletes.map((deleted) => ({ deleted })),
        ] as { entry?: SourceEntry; deleted?: string }[];
        const page = (offset: number) => ({
          entries: operations
            .slice(offset, offset + 100)
            .flatMap((o) => (o.entry ? [wireEntry(o.entry)] : [])),
          deletes: operations
            .slice(offset, offset + 100)
            .flatMap((o) => (o.deleted ? [o.deleted] : [])),
        });
        let job = (await cloudRequest(
          endpoint,
          key,
          "/uploads",
          "POST",
          {
            vaultId: plan.vaultId,
            parentRevision: plan.parentRevision,
            includes: plan.includes,
            ...page(0),
            requireEmbeddings: plan.requireEmbeddings,
          },
          plan.id,
        )) as Job;
        if (job.state === "uploading") {
          for (let offset = 100; offset < operations.length; offset += 100)
            await cloudRequest(
              endpoint,
              key,
              `/uploads/${plan.id}/manifest`,
              "PUT",
              page(offset),
            );
          const source = new FilesystemSource(
            plan.root,
            plan.vaultId,
            plan.includes,
            plan.excludes,
          );
          for (const entry of plan.entries) {
            const bytes = await new Response(
              await source.readBytes(entry.path, {
                expectedRevision: entry.revision,
                maxBytes: uploadLimit(entry.kind),
              }),
            ).arrayBuffer();
            const response = await uploadFetch(
              `${endpoint}/uploads/${plan.id}/files/${encodeURIComponent(entry.path)}`,
              {
                method: "PUT",
                redirect: "error",
                headers: headersWithAuth(key),
                body: bytes,
                signal: AbortSignal.timeout(30000),
              },
            );
            if (!response.ok) throw new Error("UPLOAD_FILE_FAILED");
          }
          job = (await cloudRequest(
            endpoint,
            key,
            `/uploads/${plan.id}/commit`,
            "POST",
          )) as Job;
        }
        await driveCloudJob(endpoint, key, job);
        // Persist managed paths as soon as the source intent has completed, including
        // if publication subsequently fails. Deletion never sweeps other clients.
        const previousFile = path.join(
          dir,
          createHash("sha256")
            .update(JSON.stringify([endpoint, plan.vaultId]))
            .digest("hex") + ".manifest.json",
        );
        let previous: string[] = [];
        try {
          previous = JSON.parse(await readFile(previousFile, "utf8"));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await save(
          previousFile,
          Array.from(
            new Set([
              ...previous.filter((p) => !plan.deletes.includes(p)),
              ...plan.entries.map((e) => e.path),
            ]),
          ),
        );
        if (!plan.indexJobId) {
          let index: Job | undefined;
          for (let n = 0; n < 100 && !index; n++) {
            try {
              index = (await cloudRequest(endpoint, key, "/index", "POST", {
                newScan: true,
                requireEmbeddings: plan.requireEmbeddings,
              })) as Job;
            } catch (error) {
              if (!(error instanceof Error) || error.message !== "INDEX_BUSY")
                throw error;
              const status = await cloudRequest(endpoint, key, "/status");
              const pending = status.deployment?.activeJobId;
              if (pending)
                await driveCloudJob(
                  endpoint,
                  key,
                  (await cloudRequest(
                    endpoint,
                    key,
                    `/jobs/${pending}`,
                  )) as Job,
                );
              else await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
          if (!index) throw new Error("INDEX_BUSY");
          plan.indexJobId = index.jobId;
          await save(planFile, plan);
        }
        const published = await driveCloudJob(
          endpoint,
          key,
          (await cloudRequest(
            endpoint,
            key,
            `/jobs/${plan.indexJobId}`,
          )) as Job,
        );
        plan.complete = true;
        await save(planFile, plan);
        console.log(JSON.stringify({ planId: plan.id, ...published }, null, 2));
      } catch (error) {
        const code =
          error instanceof Error && /^[A-Z][A-Z0-9_]{2,64}$/.test(error.message)
            ? error.message
            : "UPLOAD_FAILED";
        console.error(code);
        if (resumeId) console.error(`RESUME_PLAN: ${resumeId}`);
        process.exitCode = 1;
      }
    });
}

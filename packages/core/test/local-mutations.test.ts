import { SyntheticPCloud } from "./helpers/pcloud.js";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { DEFAULT_CONFIG, type Config } from "../src/config.js";
import { indexVault, reindexVault } from "../src/indexer.js";
import { IndexStore, getIndexPath } from "../src/index-store.js";
import { noteIdFromPath } from "../src/identifiers.js";
import {
  LocalMutationService,
  LocalMutationInterruption,
  type LocalMutationOptions,
  type MutationCheckpoint,
} from "../src/local/mutations.js";
import {
  mutationStatePath,
  mutationSequence,
  withMutationPublication,
} from "../src/local/mutation-state.js";
import { SqliteMetadataStore } from "../src/local/sqlite.js";
import { updateLocalIndex } from "../src/local/index-updates.js";
import { configuredVaultIdentity } from "../src/local/source.js";
import { EmbeddingProvider } from "../src/embedding.js";

const create = (
  relative: string,
  content = "# Synthetic note\n\nSearchmarker content.",
) => ({ type: "create_note", path: relative, content });
const replace = (
  relative: string,
  version: string,
  content = "# Updated\n\nNewmarker content.",
) => ({
  type: "replace_note",
  path: relative,
  expected_version: version,
  content,
});
const remove = (relative: string, version: string) => ({
  type: "delete_file",
  path: relative,
  expected_version: version,
});
const batch = (...operations: unknown[]) => ({ operations });

describe("coordinated filesystem mutations", () => {
  let directory: string, root: string, config: Config;
  let services: LocalMutationService[];
  let stores: IndexStore[];
  let clock: number;
  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-local-mutation-"),
    );
    root = path.join(directory, "vault");
    fs.mkdirSync(root);
    config = structuredClone(DEFAULT_CONFIG);
    config.vault.root = root;
    config.index.dir = path.join(directory, "indexes");
    config.embedding.enabled = false;
    services = [];
    stores = [];
    clock = 1800000000000;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const store of stores) {
      try {
        store.close();
      } catch {
        /* already closed */
      }
    }
    for (const service of services) {
      try {
        service.close();
      } catch {
        /* already closed */
      }
    }
    fs.rmSync(directory, { recursive: true, force: true });
  });
  function service(options: LocalMutationOptions = {}) {
    const result = new LocalMutationService(config, {
      settings: { enabled: true },
      now: () => clock,
      ...options,
    });
    services.push(result);
    return result;
  }
  async function store() {
    const result = await IndexStore.open(getIndexPath(config));
    stores.push(result);
    return result;
  }
  async function apply(svc: LocalMutationService, input: unknown) {
    const proposal = await svc.allocate(input);
    return svc.apply(proposal.operation_id, input, proposal.preview_binding);
  }
  function file(relative: string, content: string) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }

  it("requires explicit enablement without disabled side effects or an editor-coordination assertion", () => {
    expect(() => new LocalMutationService(config)).toThrowError(
      expect.objectContaining({ code: "WRITE_DISABLED" }),
    );
    expect(fs.existsSync(config.index.dir)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
    services.push(
      new LocalMutationService(config, { settings: { enabled: true } }),
    );
  });
  it("rejects a private state directory inside a filesystem source", () => {
    config.index.dir = path.join(root, "generated");
    expect(() => service()).toThrowError(
      expect.objectContaining({ code: "SOURCE_EXCLUDED" }),
    );
    expect(fs.existsSync(config.index.dir)).toBe(false);
  });
  it.each(["review", "direct"] as const)(
    "reconciles pCloud %s mutations to SQLite and recovers a lost upload response",
    async (mode) => {
      const api = new SyntheticPCloud();
      config.vault.pcloud = {
        region: "us",
        folder_id: "1",
        access_token: "synthetic",
        includes: ["Notes"],
        poll_seconds: 60,
      };
      let loseResponse = true;
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input, init) => {
          const response = await api.fetch(input, init);
          if (loseResponse && String(input).endsWith("/uploadfile")) {
            loseResponse = false;
            throw new Error("synthetic lost response");
          }
          return response;
        });
      const svc = service({ settings: { enabled: true, mode } });
      const relative = "Notes/New/Apple.md";
      const id = noteIdFromPath(relative);
      const input = batch(create(relative, "# Apple\n\nSynthetic orchard."));
      if (mode === "review")
        await expect(
          svc.allocate(input, { preview: false }),
        ).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
      const plan = await svc.allocate(input, { preview: mode === "review" });
      if (mode === "direct") {
        expect(plan).not.toHaveProperty("preview");
        expect(plan).not.toHaveProperty("preview_binding");
      }
      await expect(
        svc.apply(
          plan.operation_id,
          batch(create(relative, "# Different request")),
          plan.preview_binding,
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      const outcome = await svc.apply(
        plan.operation_id,
        input,
        plan.preview_binding,
      );
      expect(outcome.results[0]).toMatchObject({ status: "reconciling" });
      expect(
        await svc.apply(plan.operation_id, input, plan.preview_binding),
      ).toEqual(outcome);
      expect(await svc.getNote(id)).toBeNull();
      clock += 61000;
      expect(await svc.flushIndex()).toEqual({ processed: 1 });
      expect(svc.getStatus(plan.operation_id).results[0]).toMatchObject({
        status: "applied",
        index_state: "fresh",
      });
      expect(
        fetchMock.mock.calls.filter(([input]) =>
          String(input).endsWith("/uploadfile"),
        ),
      ).toHaveLength(1);
      for (const denied of [
        create("Outside/Forbidden.md"),
        {
          type: "upload_attachment",
          path: "Notes/Pixel.png",
          content_base64: "AA==",
        },
      ]) {
        const input = batch(denied);
        const plan = await svc.allocate(input, { preview: mode === "review" });
        expect(
          (await svc.apply(plan.operation_id, input, plan.preview_binding))
            .results[0],
        ).toMatchObject({ status: "failed", code: "SOURCE_EXCLUDED" });
      }
      await expect(
        svc.allocate(
          batch(create("Notes/Large.md", "x".repeat(2 * 1024 * 1024 + 1))),
          { preview: mode === "review" },
        ),
      ).rejects.toMatchObject({ code: "SIZE_LIMIT_EXCEEDED" });
      const version = (await svc.getNote(id))!.version;
      const stale = batch(replace(relative, version));
      const stalePlan = await svc.allocate(stale, {
        preview: mode === "review",
      });
      api.set(relative, "# External synthetic change");
      expect(
        (
          await svc.apply(
            stalePlan.operation_id,
            stale,
            stalePlan.preview_binding,
          )
        ).results[0],
      ).toMatchObject({ status: "failed", code: "SOURCE_REVISION_MISMATCH" });
      const latest = (await svc.getNote(id))!.version;
      const removed = await apply(svc, batch(remove(relative, latest)));
      expect(removed.results[0]).toMatchObject({ status: "applied" });
      expect(await svc.flushIndex()).toEqual({ processed: 1 });
      expect((await store()).getNote(id)).toBeFalsy();
    },
  );

  it("creates parent directories, exposes current notes before indexing and applies one atomic ordered patch", async () => {
    const svc = service();
    const content = "\ufeff---\r\ndate: unchanged\r\n---\r\nOld\r\n";
    const input = batch(create("Notes/New.md", content));
    const proposal = await svc.allocate(input);
    expect(fs.existsSync(path.join(root, "Notes"))).toBe(false);
    const result = await svc.apply(
      proposal.operation_id,
      input,
      proposal.preview_binding,
    );
    expect(result.results[0]).toMatchObject({
      status: "applied",
      index_state: "pending",
      note_id: noteIdFromPath("Notes/New.md"),
    });
    const note = await svc.getNote(noteIdFromPath("Notes/New.md"));
    expect(note).toMatchObject({
      content,
      version: result.results[0]!.version,
      index_state: "pending",
      indexed_version: null,
    });
    const patch = batch({
      type: "patch_note",
      path: "Notes/New.md",
      expected_version: note!.version,
      replacements: [
        { match_type: "literal", pattern: "Old", replacement: "Intermediate" },
        {
          match_type: "regex",
          pattern: "(Intermediate)",
          replacement: "$1 新しい",
        },
      ],
    });
    expect((await apply(svc, patch)).results[0]?.status).toBe("applied");
    expect(fs.readFileSync(path.join(root, "Notes/New.md"), "utf8")).toBe(
      content.replace("Old", "Intermediate 新しい"),
    );
    expect(fs.statSync(path.join(root, "Notes/New.md")).mode & 0o777).toBe(
      0o600,
    );
    expect(fs.readdirSync(path.join(root, "Notes"))).toEqual(["New.md"]);
  });
  it("uses content and file generation, rejects stale preview versions and no-clobber races", async () => {
    file("A.md", "One");
    const svc = service();
    await indexVault(config);
    const note = await svc.getNote(noteIdFromPath("A.md"));
    const proposal = await svc.allocate(batch(replace("A.md", note!.version)));
    const stat = fs.statSync(path.join(root, "A.md"));
    fs.writeFileSync(path.join(root, "A.md"), "Two");
    fs.utimesSync(path.join(root, "A.md"), stat.atime, stat.mtime);
    const conflict = await svc.apply(
      proposal.operation_id,
      batch(replace("A.md", note!.version)),
      proposal.preview_binding,
    );
    expect(conflict.results[0]).toMatchObject({
      status: "failed",
      code: "SOURCE_REVISION_MISMATCH",
    });
    expect(fs.readFileSync(path.join(root, "A.md"), "utf8")).toBe("Two");
    const original = (await svc.getNote(noteIdFromPath("A.md")))!.version;
    fs.renameSync(path.join(root, "A.md"), path.join(directory, "retired.md"));
    file("A.md", "Two");
    expect((await svc.getNote(noteIdFromPath("A.md")))!.version).not.toBe(
      original,
    );
    const createInput = batch(create("B.md"));
    const plan = await svc.allocate(createInput);
    file("B.md", "External");
    expect(
      (await svc.apply(plan.operation_id, createInput, plan.preview_binding))
        .results[0]?.code,
    ).toBe("FILE_ALREADY_EXISTS");
    expect(fs.readFileSync(path.join(root, "B.md"), "utf8")).toBe("External");
  });
  it("rejects stale changes at the final controlled checkpoint without replacing source bytes", async () => {
    file("A.md", "Old");
    await indexVault(config);
    let mutate = false;
    const svc = service({
      checkpoint: (phase) => {
        if (mutate && phase === "stage") file("A.md", "External");
      },
    });
    const version = (await svc.getNote(noteIdFromPath("A.md")))!.version;
    const planInput = batch(replace("A.md", version));
    const plan = await svc.allocate(planInput);
    mutate = true;
    const result = await svc.apply(
      plan.operation_id,
      planInput,
      plan.preview_binding,
    );
    expect(result.results[0]).toMatchObject({
      status: "failed",
      code: "SOURCE_REVISION_MISMATCH",
    });
    expect(fs.readFileSync(path.join(root, "A.md"), "utf8")).toBe("External");
    expect(fs.readdirSync(root)).toEqual(["A.md"]);
  });
  it("handles explicit binary create, replace and delete without indexing attachments", async () => {
    const svc = service();
    const uploaded = await apply(
      svc,
      batch({
        type: "upload_attachment",
        path: "Images/pixel.png",
        content_base64: "AAEC/w==",
      }),
    );
    expect(uploaded.results[0]?.status).toBe("applied");
    const attachment = svc.getAttachment("Images/pixel.png")!;
    expect(Array.from(attachment.bytes)).toEqual([0, 1, 2, 255]);
    const replaced = await apply(
      svc,
      batch({
        type: "upload_attachment",
        path: attachment.path,
        replace: true,
        expected_version: attachment.version,
        content_base64: "AQID",
      }),
    );
    expect(replaced.results[0]?.status).toBe("applied");
    expect((await svc.flushIndex()).processed).toBe(1);
    expect((await store()).getAllNotes()).toEqual([]);
    const deleted = await apply(
      svc,
      batch(
        remove(attachment.path, svc.getAttachment(attachment.path)!.version),
      ),
    );
    expect(deleted.results[0]).toMatchObject({
      status: "applied",
      index_state: "pending",
    });
    expect(svc.getAttachment(attachment.path)).toBeNull();
    expect((await svc.flushIndex()).processed).toBe(1);
  });
  it("documents the accepted missed race when an external write occurs after the last version check", async () => {
    file("A.md", "Old");
    const svc = service();
    const target = path.join(root, "A.md");
    const version = svc.getFileVersion("A.md")!.version;
    const rename = fs.renameSync;
    let raced = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (String(to) === target) {
        raced = true;
        fs.writeFileSync(target, "Late external edit");
      }
      rename(from, to);
    });
    const result = await apply(
      svc,
      batch(replace("A.md", version, "Requested edit")),
    );
    expect(raced).toBe(true);
    expect(result.results[0]?.status).toBe("applied");
    expect(fs.readFileSync(target, "utf8")).toBe("Requested edit");
  });
  it("rejects all-file size/duplicate admission before target or parent creation", async () => {
    const svc = service({ settings: { enabled: true, max_file_bytes: 8 } });
    await expect(
      svc.allocate(
        batch(create("New/A.md", "ok"), create("New/B.md", "123456789")),
      ),
    ).rejects.toMatchObject({ code: "SIZE_LIMIT_EXCEEDED" });
    await expect(
      svc.allocate(batch(create("New/A.md", "ok"), create("new/a.MD", "ok"))),
    ).rejects.toMatchObject({ code: "DUPLICATE_PATH" });
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("applies size limits to final payloads, while deletion and smaller full replacement need no retained original body", async () => {
    file("A.md", "A".repeat(4096));
    file("B.md", "B".repeat(4096));
    const svc = service({
      settings: {
        enabled: true,
        mode: "direct",
        max_file_bytes: 8,
        max_batch_bytes: 8,
      },
    });
    const a = svc.getFileVersion("A.md")!;
    const b = svc.getFileVersion("B.md")!;
    expect(a.size).toBe(4096);
    const input = batch(
      remove("A.md", a.version),
      replace("B.md", b.version, "Small"),
    );
    const proposal = await svc.allocate(input, { preview: false });
    const result = await svc.apply(proposal.operation_id, input);
    expect(result.results.map((item) => item.status)).toEqual([
      "applied",
      "applied",
    ]);
    expect(fs.existsSync(path.join(root, "A.md"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "B.md"), "utf8")).toBe("Small");
  });
  it("keeps successful files and rolls back a note's entire failed patch", async () => {
    file("A.md", "Old");
    await indexVault(config);
    const svc = service();
    const version = (await svc.getNote(noteIdFromPath("A.md")))!.version;
    const result = await apply(
      svc,
      batch(
        {
          type: "patch_note",
          path: "A.md",
          expected_version: version,
          replacements: [
            { match_type: "literal", pattern: "Old", replacement: "New" },
            { match_type: "literal", pattern: "Missing", replacement: "X" },
          ],
        },
        create("B.md", "Success"),
      ),
    );
    expect(result.results.map((item) => item.status)).toEqual([
      "failed",
      "applied",
    ]);
    expect(fs.readFileSync(path.join(root, "A.md"), "utf8")).toBe("Old");
    expect(fs.readFileSync(path.join(root, "B.md"), "utf8")).toBe("Success");
  });
  it("binds review content and requires a preview while direct mode still allocates IDs first", async () => {
    const svc = service();
    const input = batch(create("A.md"));
    const proposal = await svc.allocate(input);
    await expect(svc.apply(proposal.operation_id, input)).rejects.toMatchObject(
      { code: "PREVIEW_REQUIRED" },
    );
    await expect(
      svc.apply(proposal.operation_id, input, "0".repeat(64)),
    ).rejects.toMatchObject({ code: "PREVIEW_REQUIRED" });
    await expect(
      svc.apply(
        proposal.operation_id,
        batch(create("A.md", "Different")),
        proposal.preview_binding,
      ),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(svc.allocate(input, { preview: false })).rejects.toMatchObject(
      { code: "PREVIEW_REQUIRED" },
    );
    expect(fs.readdirSync(root)).toEqual([]);
    const direct = service({ settings: { enabled: true, mode: "direct" } });
    const directPlan = await direct.allocate(input, { preview: false });
    expect(directPlan).not.toHaveProperty("preview");
    expect(
      (await direct.apply(directPlan.operation_id, input)).results[0]?.status,
    ).toBe("applied");
  });
  it("deduplicates overlapping calls, restart and lost-response replay without snapshot reads", async () => {
    const svc = service();
    const input = batch(create("A.md"));
    const plan = await svc.allocate(input);
    const [one, two] = await Promise.all([
      svc.apply(plan.operation_id, input, plan.preview_binding),
      svc.apply(plan.operation_id, input, plan.preview_binding),
    ]);
    expect(one).toEqual(two);
    const inode = fs.statSync(path.join(root, "A.md")).ino;
    const restarted = service();
    expect(
      await restarted.apply(plan.operation_id, input, plan.preview_binding),
    ).toEqual(one);
    expect(fs.statSync(path.join(root, "A.md")).ino).toBe(inode);
    file("A.md", "External changed after success");
    expect(
      await restarted.apply(plan.operation_id, input, plan.preview_binding),
    ).toEqual(one);
    expect(fs.readFileSync(path.join(root, "A.md"), "utf8")).toBe(
      "External changed after success",
    );
  });
  it("rejects tampered, unknown, expired and future IDs and cannot resurrect them by increasing retention", async () => {
    const svc = service();
    const input = batch(create("A.md"));
    const plan = await svc.allocate(input);
    await expect(
      svc.apply(
        plan.operation_id.slice(0, -1) +
          (plan.operation_id.endsWith("0") ? "1" : "0"),
        input,
        plan.preview_binding,
      ),
    ).rejects.toMatchObject({ code: "OPERATION_INVALID" });
    clock -= 30001;
    await expect(
      svc.apply(plan.operation_id, input, plan.preview_binding),
    ).rejects.toMatchObject({ code: "OPERATION_INVALID" });
    clock = plan.expires_at;
    await expect(
      svc.apply(plan.operation_id, input, plan.preview_binding),
    ).rejects.toMatchObject({ code: "OPERATION_EXPIRED" });
    const longer = service({
      settings: { enabled: true, history_retention_days: 14 },
    });
    await expect(
      longer.apply(plan.operation_id, input, plan.preview_binding),
    ).rejects.toMatchObject({ code: "OPERATION_EXPIRED" });
    expect(svc.cleanup()).toBe(1);
    await expect(
      svc.apply(plan.operation_id, input, plan.preview_binding),
    ).rejects.toMatchObject({ code: "OPERATION_EXPIRED" });
    expect(fs.existsSync(path.join(root, "A.md"))).toBe(false);
  });
  it("invalidates unused preview when source policy or signing key changes", async () => {
    const svc = service();
    const input = batch(create("A.md"));
    const plan = await svc.allocate(input);
    config.vault.exclude = ["A.md"];
    const changed = service();
    await expect(
      changed.apply(plan.operation_id, input, plan.preview_binding),
    ).rejects.toMatchObject({ code: "PREVIEW_CHANGED" });
    expect(fs.existsSync(path.join(root, "A.md"))).toBe(false);
  });
  it("binds journal and source identity to the root directory generation", async () => {
    const svc = service();
    const plan = await svc.allocate(batch(create("A.md")));
    fs.renameSync(root, path.join(directory, "retired-vault"));
    fs.mkdirSync(root);
    expect(() => service()).toThrowError(
      expect.objectContaining({ code: "SOURCE_WRITE_UNSUPPORTED" }),
    );
    expect(() => svc.getFileVersion("A.md")).toThrowError(
      expect.objectContaining({ code: "SOURCE_REVISION_MISMATCH" }),
    );
    expect(plan.operation_id).toMatch(/^m1\./);
    expect(fs.readdirSync(root)).toEqual([]);
  });
  it("never allocates an unknown signed ID and checks the current signing key on every call", async () => {
    const svc = service();
    const input = batch(create("A.md"));
    const unknown = await svc.allocate(input);
    const db = new Database(mutationStatePath(getIndexPath(config)));
    try {
      db.prepare("DELETE FROM mutation_operations WHERE id=?").run(
        unknown.operation_id,
      );
      await expect(
        svc.apply(unknown.operation_id, input, unknown.preview_binding),
      ).rejects.toMatchObject({ code: "OPERATION_UNKNOWN" });
      const plan = await svc.allocate(input);
      db.prepare("UPDATE mutation_meta SET value=? WHERE key='secret'").run(
        "0".repeat(64),
      );
      await expect(
        svc.apply(plan.operation_id, input, plan.preview_binding),
      ).rejects.toMatchObject({ code: "OPERATION_INVALID" });
      expect(() => svc.getStatus(plan.operation_id)).toThrowError(
        expect.objectContaining({ code: "OPERATION_INVALID" }),
      );
      expect(fs.existsSync(path.join(root, "A.md"))).toBe(false);
    } finally {
      db.close();
    }
  });
  it.each(["file", "parent", "hardlink"])(
    "denies %s aliases without touching their source",
    async (kind) => {
      const external = path.join(directory, "external");
      fs.mkdirSync(external);
      fs.writeFileSync(path.join(external, "A.md"), "External");
      if (kind === "parent") fs.symlinkSync(external, path.join(root, "Alias"));
      else if (kind === "file")
        fs.symlinkSync(path.join(external, "A.md"), path.join(root, "A.md"));
      else fs.linkSync(path.join(external, "A.md"), path.join(root, "A.md"));
      const svc = service();
      const result = await apply(
        svc,
        batch(create(kind === "parent" ? "Alias/New.md" : "A.md")),
      );
      expect(result.results[0]?.status).toBe("failed");
      expect(fs.readdirSync(external)).toEqual(["A.md"]);
      expect(fs.readFileSync(path.join(external, "A.md"), "utf8")).toBe(
        "External",
      );
    },
  );
  it("rejects parent replacement at the stage checkpoint and does not follow a new symlink", async () => {
    const external = path.join(directory, "external");
    fs.mkdirSync(external);
    let changed = false;
    const svc = service({
      checkpoint: (phase) => {
        if (phase === "stage" && !changed) {
          changed = true;
          fs.renameSync(path.join(root, "Notes"), path.join(root, "Retired"));
          fs.symlinkSync(external, path.join(root, "Notes"));
        }
      },
    });
    const result = await apply(svc, batch(create("Notes/A.md")));
    expect(result.results[0]?.status).toBe("failed");
    expect(fs.readdirSync(external)).toEqual([]);
    expect(fs.existsSync(path.join(root, "Retired/A.md"))).toBe(false);
  });

  it("queues shared indexing, rejects old chunks, and suppresses old candidates until publication", async () => {
    file("A.md", "# Old\n\nOldmarker searchable.");
    await indexVault(config);
    const oldStore = await store();
    const svc = service();
    const id = noteIdFromPath("A.md");
    const before = (await svc.getNote(id))!;
    expect((await svc.getChunk(id, 0, before.version))?.content).toContain(
      "Oldmarker",
    );
    const result = await apply(svc, batch(replace("A.md", before.version)));
    expect(result.results[0]?.status).toBe("applied");
    expect((await svc.getNote(id))?.content).toContain("Newmarker");
    await expect(svc.getChunk(id, 0, before.version)).rejects.toMatchObject({
      code: "REVISION_CHANGED",
    });
    expect(oldStore.searchLexical("Oldmarker", 10)).toEqual([]);
    expect(oldStore.getAllNotes()).toEqual([]);
    expect((await svc.flushIndex()).processed).toBe(1);
    expect((await svc.getNote(id))?.index_state).toBe("fresh");
    expect((await svc.getChunk(id, 0))?.content).toContain("Newmarker");
    expect(oldStore.searchLexical("Newmarker", 10)).toHaveLength(1);
    expect(svc.getStatus(result.operation_id).results[0]?.index_state).toBe(
      "fresh",
    );
  });
  it("suppresses deletion across stale stores and rebuilds, warns backlinks and retains tombstones after audit expiry", async () => {
    file("A.md", "# A\n\nSearchmarker.");
    file("B.md", "# B\n\n[[A]]");
    await indexVault(config);
    const oldStore = await store();
    const svc = service();
    const id = noteIdFromPath("A.md");
    const result = await apply(
      svc,
      batch(remove("A.md", (await svc.getNote(id))!.version)),
    );
    expect(result.results[0]).toMatchObject({
      status: "applied",
      warnings: [
        { code: "BACKLINKS_MAY_BE_STALE" },
        {
          code: "INCOMING_LINKS",
          references: [{ note_id: noteIdFromPath("B.md"), path: "B.md" }],
          truncated: false,
        },
      ],
    });
    expect(oldStore.getNote(id)).toBeNull();
    expect(oldStore.getChunk(id, 0)).toBeNull();
    expect(oldStore.getChunkById(`${id}:0`)).toBeNull();
    expect(oldStore.getChunks(id)).toEqual([]);
    expect(oldStore.searchLexical("Searchmarker", 10)).toEqual([]);
    expect(oldStore.searchTrigrams("Searchmarker", 10)).toEqual([]);
    expect(oldStore.getAllNotePaths()).toEqual(["B.md"]);
    const metadata = new SqliteMetadataStore(oldStore, "synthetic");
    expect(
      (await metadata.listNotes({ limit: 10 })).items.map((row) => row.path),
    ).toEqual(["B.md"]);
    expect(await svc.getNote(id)).toBeNull();
    expect(await svc.getChunk(id, 0)).toBeNull();
    clock += 8 * 86400000;
    expect(svc.cleanup()).toBe(1);
    expect(oldStore.getNote(id)).toBeNull();
    oldStore.close();
    await reindexVault(config);
    expect((await store()).getNote(id)).toBeNull();
    // Even injecting an obsolete snapshot into an old index cannot release a durable tombstone.
    file("A.md", "# External recreation\n\nSearchmarker.");
    await indexVault(config);
    expect((await store()).getNote(id)).toBeNull();
    expect((await svc.getNote(id))?.content).toContain("External recreation");
  });
  it("allows explicit re-creation only for the newly saved/indexed bytes", async () => {
    const svc = service();
    await apply(svc, batch(create("A.md", "Old")));
    await svc.flushIndex();
    const id = noteIdFromPath("A.md");
    await apply(svc, batch(remove("A.md", (await svc.getNote(id))!.version)));
    const recreated = await apply(svc, batch(create("A.md", "New")));
    expect(recreated.results[0]?.status).toBe("applied");
    expect((await svc.getNote(id))?.content).toBe("New");
    expect((await store()).getNote(id)).toBeNull();
    await svc.flushIndex();
    expect((await store()).getNote(id)).not.toBeNull();
  });
  it("fences stale source publication and keeps saved bytes when required indexing fails", async () => {
    const svc = service();
    const oldSequence = mutationSequence(getIndexPath(config));
    await apply(svc, batch(create("A.md")));
    expect(() =>
      withMutationPublication(getIndexPath(config), oldSequence, () => {
        throw new Error("must not publish");
      }),
    ).toThrowError(
      expect.objectContaining({ code: "SOURCE_REVISION_MISMATCH" }),
    );
    const failing = service();
    config.embedding.enabled = true;
    config.embedding.require = true;
    config.embedding.model = "";
    const failure = service();
    await expect(failure.flushIndex()).rejects.toMatchObject({
      code: "EMBEDDING_CONFIG_INVALID",
    });
    expect((await svc.getNote(noteIdFromPath("A.md")))?.index_state).toBe(
      "failed",
    );
    expect((await svc.getNote(noteIdFromPath("A.md")))?.content).toContain(
      "Searchmarker",
    );
    expect((await failing.flushIndex()).processed).toBe(1);
  });
  it.each(["incremental", "rebuild"])(
    "prevents a delayed %s publication from reviving a deleted source",
    async (mode) => {
      config.embedding.enabled = true;
      config.embedding.model = "synthetic-model";
      let enter!: () => void, resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const resumed = new Promise<void>((resolve) => {
        resume = resolve;
      });
      let paused = false;
      vi.spyOn(EmbeddingProvider.prototype, "embed").mockImplementation(
        async (texts) => {
          if (paused) {
            enter();
            await resumed;
          }
          return {
            model: "synthetic-model",
            dimension: 2,
            embeddings: texts.map(() => new Float32Array([1, 0])),
          };
        },
      );
      file("A.md", "# A\n\nOriginal searchable text.");
      await indexVault(config);
      const svc = service();
      const active = await store();
      file("A.md", "# A\n\nObsolete prepared text.");
      paused = true;
      const update =
        mode === "rebuild"
          ? reindexVault(config)
          : updateLocalIndex(active, config, {
              paths: ["A.md"],
              vaultIdentity: configuredVaultIdentity(config),
            });
      const outcome = update.then(
        () => "unexpected-publication",
        (error: { code: string }) => error.code,
      );
      await entered;
      const removed = await apply(
        svc,
        batch(remove("A.md", svc.getFileVersion("A.md")!.version)),
      );
      expect(removed.results[0]?.status).toBe("applied");
      resume();
      expect(await outcome).toBe("SOURCE_REVISION_MISMATCH");
      expect(active.getNote(noteIdFromPath("A.md"))).toBeNull();
      expect((await store()).getNote(noteIdFromPath("A.md"))).toBeNull();
      expect(fs.existsSync(path.join(root, "A.md"))).toBe(false);
    },
  );
  it("persists only private metadata in audit and cleans terminal staging, never source content", async () => {
    const svc = service();
    const input = batch(create("A.md", "UNIQUE_SYNTHETIC_BODY"));
    const result = await apply(svc, input);
    const statePath = mutationStatePath(getIndexPath(config));
    expect(fs.statSync(statePath).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(statePath)).mode & 0o777).toBe(0o700);
    for (const file of fs
      .readdirSync(path.dirname(statePath))
      .filter((name) => name.startsWith("mutations.sqlite"))) {
      expect(
        fs
          .readFileSync(path.join(path.dirname(statePath), file))
          .includes(Buffer.from("UNIQUE_SYNTHETIC_BODY")),
      ).toBe(false);
    }
    expect(JSON.stringify(result)).not.toContain("UNIQUE_SYNTHETIC_BODY");
    expect(JSON.stringify(result)).not.toContain(root);
    expect(fs.readdirSync(root)).toEqual(["A.md"]);
  });
  it.each([
    "intent",
    "stage",
    "committing",
    "published",
    "applied",
  ] as MutationCheckpoint[])(
    "recovers real process termination at %s without repeating saved files",
    async (phase) => {
      const svc = service();
      const input = batch(create("A.md", "Process crash synthetic content"));
      const proposal = await svc.allocate(input);
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `
      import fs from 'node:fs';
      const {LocalMutationService} = await import(process.argv[1]);
      const data = JSON.parse(fs.readFileSync(0, 'utf8'));
      const service = new LocalMutationService(data.config, {settings:{enabled:true},now:()=>data.now,
        checkpoint:(phase)=>{ if(phase===data.phase)process.exit(73); }});
      await service.apply(data.id,data.input,data.binding);
    `,
          new URL("../src/local/mutations.ts", import.meta.url).href,
        ],
        {
          input: JSON.stringify({
            config,
            now: clock,
            phase,
            id: proposal.operation_id,
            input,
            binding: proposal.preview_binding,
          }),
          encoding: "utf8",
          timeout: 15000,
        },
      );
      expect(child.status, String(child.error) + child.stderr).toBe(73);
      const restarted = service();
      restarted.recover();
      const status = restarted.getStatus(proposal.operation_id);
      const desired = phase === "published" || phase === "applied";
      expect(status.results[0]?.status).toBe(
        desired ? "applied" : phase === "committing" ? "reconciling" : "failed",
      );
      if (desired) {
        const inode = fs.statSync(path.join(root, "A.md")).ino;
        expect(
          (
            await restarted.apply(
              proposal.operation_id,
              input,
              proposal.preview_binding,
            )
          ).results[0]?.status,
        ).toBe("applied");
        expect(fs.statSync(path.join(root, "A.md")).ino).toBe(inode);
        expect((await restarted.getNote(noteIdFromPath("A.md")))?.content).toBe(
          "Process crash synthetic content",
        );
      } else expect(fs.existsSync(path.join(root, "A.md"))).toBe(false);
      expect(
        fs.readdirSync(root).filter((name) => name.startsWith(".vault-agent")),
      ).toEqual([]);
    },
  );
  it("keeps ambiguous outcomes suppressed and unresolved beyond expiry instead of repeating writes", async () => {
    const svc = service({
      checkpoint: (phase) => {
        if (phase === "published") {
          file("A.md", "External ambiguous content");
          throw new LocalMutationInterruption();
        }
      },
    });
    const input = batch(create("A.md"));
    const plan = await svc.allocate(input);
    await expect(
      svc.apply(plan.operation_id, input, plan.preview_binding),
    ).rejects.toBeInstanceOf(LocalMutationInterruption);
    const restarted = service();
    restarted.recover();
    expect(restarted.getStatus(plan.operation_id).results[0]?.status).toBe(
      "reconciling",
    );
    expect(await restarted.getNote(noteIdFromPath("A.md"))).toBeNull();
    clock += 8 * 86400000;
    expect(restarted.cleanup()).toBe(0);
    expect(restarted.getStatus(plan.operation_id).results[0]?.status).toBe(
      "reconciling",
    );
    await expect(
      restarted.apply(plan.operation_id, input, plan.preview_binding),
    ).rejects.toMatchObject({ code: "OPERATION_EXPIRED" });
    expect(fs.readFileSync(path.join(root, "A.md"), "utf8")).toBe(
      "External ambiguous content",
    );
  });
  it.each(["replace", "delete"])(
    "recovers a published %s while old indexed content stays suppressed",
    async (action) => {
      file("A.md", "# Old\n\nOldmarker.");
      await indexVault(config);
      const active = await store();
      const svc = service({
        checkpoint: (phase) => {
          if (phase === "published") throw new LocalMutationInterruption();
        },
      });
      const version = svc.getFileVersion("A.md")!.version;
      const input = batch(
        action === "replace"
          ? replace("A.md", version)
          : remove("A.md", version),
      );
      const proposal = await svc.allocate(input);
      await expect(
        svc.apply(proposal.operation_id, input, proposal.preview_binding),
      ).rejects.toBeInstanceOf(LocalMutationInterruption);
      expect(active.getNote(noteIdFromPath("A.md"))).toBeNull();
      const restarted = service();
      restarted.recover();
      const result = restarted.getStatus(proposal.operation_id).results[0]!;
      expect(result).toMatchObject({
        status: "applied",
        expected_version: version,
        index_state: "pending",
      });
      if (action === "replace")
        expect(
          (await restarted.getNote(noteIdFromPath("A.md")))?.content,
        ).toContain("Newmarker");
      else expect(await restarted.getNote(noteIdFromPath("A.md"))).toBeNull();
      expect((await restarted.flushIndex()).processed).toBe(1);
      expect(active.searchLexical("Oldmarker", 10)).toEqual([]);
      expect(
        (
          await restarted.apply(
            proposal.operation_id,
            input,
            proposal.preview_binding,
          )
        ).results[0]?.status,
      ).toBe("applied");
    },
  );
  it("finishes durable post-publication recovery after expiry while refusing another client apply", async () => {
    const svc = service({
      checkpoint: (phase) => {
        if (phase === "published") throw new LocalMutationInterruption();
      },
    });
    const input = batch(create("A.md"));
    const plan = await svc.allocate(input);
    await expect(
      svc.apply(plan.operation_id, input, plan.preview_binding),
    ).rejects.toBeInstanceOf(LocalMutationInterruption);
    clock = plan.expires_at;
    const restarted = service();
    restarted.recover();
    expect(restarted.getStatus(plan.operation_id).results[0]?.status).toBe(
      "applied",
    );
    await expect(
      restarted.apply(plan.operation_id, input, plan.preview_binding),
    ).rejects.toMatchObject({ code: "OPERATION_EXPIRED" });
    expect(
      (await restarted.getNote(noteIdFromPath("A.md")))?.content,
    ).toContain("Searchmarker");
  });
  it("retains completed audit metadata after apply expiry for the original retention period", async () => {
    const svc = service();
    const input = batch(create("A.md"));
    const plan = await svc.allocate(input);
    clock += 6 * 86400000;
    await svc.apply(plan.operation_id, input, plan.preview_binding);
    clock = plan.expires_at + 1;
    expect(svc.cleanup()).toBe(0);
    expect(svc.getStatus(plan.operation_id).state).toBe("completed");
    await expect(
      svc.apply(plan.operation_id, input, plan.preview_binding),
    ).rejects.toMatchObject({ code: "OPERATION_EXPIRED" });
    clock += 7 * 86400000;
    expect(svc.cleanup()).toBe(1);
    expect(() => svc.getStatus(plan.operation_id)).toThrowError(
      expect.objectContaining({ code: "OPERATION_EXPIRED" }),
    );
    expect((await svc.getNote(noteIdFromPath("A.md")))?.content).toContain(
      "Searchmarker",
    );
  });
});

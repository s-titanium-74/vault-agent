import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type { Config } from "../config.js";
import { IndexError } from "../errors.js";
import { DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT } from "../schemas.js";
import { IndexStore, getIndexPath } from "../index-store.js";
import { configuredVaultIdentity } from "./source.js";
import { updateLocalIndex } from "./index-updates.js";
import { noteIdFromPath, isValidNoteId } from "../identifiers.js";
import { parseMarkdown } from "../markdown-shared.js";
import { chunkFromRows } from "../retrieval-shared.js";
import { indexedChunkVersion } from "../result-shared.js";
import { sourcePolicy } from "../portable/source-policy.js";
import {
  prepareMutationBatch,
  mutationRequestDigest,
  type MutationPreparationContext,
  type PreparedMutationItem,
} from "../portable/mutations.js";
import { previewMutationBatch } from "../portable/mutation-preview.js";
import {
  mutationSettingsSchema,
  MutationError,
  type MutationSettings,
} from "../portable/mutation-schemas.js";
import {
  MutationFilesystem,
  digestBytes,
  type FileFingerprint,
} from "./mutation-filesystem.js";
import {
  MutationJournal,
  LocalMutationError,
  type MutationResult,
  type ItemRow,
} from "./mutation-journal.js";
import { mutationStatePath, type MutationPathState } from "./mutation-state.js";

export type MutationCheckpoint =
  "intent" | "stage" | "committing" | "published" | "applied";
/** Test-only simulated process interruption; it deliberately bypasses error recovery. */
export class LocalMutationInterruption extends Error {}
interface RecoveryIntent {
  action: "create" | "replace" | "delete";
  expected?: string;
  stage?: string;
  desired?: FileFingerprint;
  indexHash?: string;
  prior?: MutationPathState;
}
export interface LocalMutationOptions {
  settings?: Partial<MutationSettings>;
  now?: () => number;
  /** Internal fault injection; never a transport/config setting. */
  checkpoint?: (
    phase: MutationCheckpoint,
    item: { index: number; path: string },
  ) => void;
}

export class LocalMutationService {
  private readonly journal: MutationJournal;
  private readonly source: MutationFilesystem;
  private readonly settings: MutationSettings;
  private readonly config: Config;
  private readonly context: MutationPreparationContext;
  private readonly allowed: ReturnType<typeof sourcePolicy>;
  private readonly now: () => number;
  private readonly indexPath: string;
  private readonly policy: string;
  private observationCursor = "";
  constructor(
    config: Config,
    private readonly options: LocalMutationOptions = {},
  ) {
    let openedJournal: MutationJournal | undefined;
    try {
      const parsed = mutationSettingsSchema.safeParse(options.settings ?? {});
      if (!parsed.success) throw new LocalMutationError("INVALID_REQUEST");
      this.settings = parsed.data;
      if (!this.settings.enabled)
        throw new LocalMutationError("WRITE_DISABLED");
      if (config.vault.pcloud)
        throw new LocalMutationError("SOURCE_WRITE_UNSUPPORTED");
      this.config = structuredClone(config);
      this.now = options.now ?? Date.now;
      this.source = new MutationFilesystem(
        config.vault.root,
        configuredVaultIdentity(config),
      );
      this.indexPath = getIndexPath(config);
      const directory = path.resolve(path.dirname(this.indexPath));
      if (
        directory === this.source.root ||
        directory.startsWith(this.source.root + path.sep)
      )
        throw new LocalMutationError("SOURCE_EXCLUDED");
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (
        fs.realpathSync(directory) !== directory ||
        !fs.lstatSync(directory).isDirectory()
      )
        throw new LocalMutationError("SOURCE_EXCLUDED");
      fs.chmodSync(directory, 0o700);
      this.allowed = sourcePolicy(["."], config.vault.exclude);
      const identity = digestBytes(
        JSON.stringify([
          configuredVaultIdentity(config),
          this.source.identityKey(),
        ]),
      );
      this.policy = digestBytes(
        JSON.stringify([
          identity,
          config.vault.exclude,
          this.settings,
          "filesystem-version-check-v2",
        ]),
      );
      this.journal = openedJournal = new MutationJournal(
        mutationStatePath(this.indexPath),
        identity,
        this.now,
      );
      this.source.syncDirectory(directory);
      this.context = {
        vaultId: configuredVaultIdentity(config),
        sourceId: identity,
        sourceKind: "filesystem",
        policyRevision: this.policy,
        includes: ["."],
        excludes: config.vault.exclude,
        settings: this.settings,
        // Conservative collision rejection across filesystem spelling conventions.
        collisionKey: (value) => value.normalize("NFC").toLowerCase(),
        snapshot: async (relative, read) => {
          this.assertAllowed(relative);
          if (this.journal.path(relative)?.blocked)
            throw new MutationError("SOURCE_UNAVAILABLE");
          if (!read.readContent) {
            const stat = this.source.stat(relative);
            return stat ? { version: stat.version } : null;
          }
          const snapshot = this.source.read(relative, read.maxBytes);
          return snapshot
            ? {
                version: snapshot.version,
                ...(read.readContent
                  ? { content: this.decode(snapshot.bytes) }
                  : {}),
              }
            : null;
        },
      };
    } catch (error) {
      openedJournal?.close();
      if (error instanceof LocalMutationError || error instanceof MutationError)
        throw error;
      throw new LocalMutationError("SOURCE_UNAVAILABLE");
    }
  }
  private assertAllowed(relative: string) {
    if (
      relative.split("/").some((segment) => segment.startsWith(".")) ||
      !this.allowed(relative)
    )
      throw new LocalMutationError("SOURCE_EXCLUDED");
  }
  private decode(bytes: Uint8Array) {
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        bytes,
      );
    } catch {
      throw new MutationError("INVALID_UTF8");
    }
  }
  private indexHash(bytes: Uint8Array) {
    return digestBytes(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ).slice(0, 32);
  }
  private checkpoint(
    phase: MutationCheckpoint,
    item: { index: number; path: string },
  ) {
    this.options.checkpoint?.(phase, item);
  }
  async allocate(input: unknown, options: { preview?: boolean } = {}) {
    const preview = options.preview ?? true;
    if (!preview && this.settings.mode !== "direct")
      throw new LocalMutationError("PREVIEW_REQUIRED");
    this.recover();
    const prepared = await prepareMutationBatch(this.context, input, {
      preview,
    });
    return this.journal.exclusive(() => {
      this.cleanupLocked(100);
      const operation = this.journal.allocate(
        prepared.request_digest,
        this.policy,
        this.now(),
        this.settings.history_retention_days,
        preview,
      );
      return {
        operation_id: operation.id,
        expires_at: operation.expires,
        ...(preview
          ? {
              preview_binding: this.journal.binding(operation.id),
              preview: previewMutationBatch(prepared),
            }
          : {}),
      };
    });
  }
  async apply(id: string, input: unknown, previewBinding?: string) {
    const verified = this.journal.verify(id, this.now());
    const operation = this.journal.operation(id);
    if (!operation) throw new LocalMutationError("OPERATION_UNKNOWN");
    if (operation.policy !== this.policy)
      throw new LocalMutationError("PREVIEW_CHANGED");
    if ((await mutationRequestDigest(this.context, input)) !== verified.digest)
      throw new LocalMutationError("IDEMPOTENCY_CONFLICT");
    if (
      this.settings.mode === "review" &&
      (!operation.preview || !this.journal.checkBinding(id, previewBinding))
    )
      throw new LocalMutationError("PREVIEW_REQUIRED");
    this.recover();
    if (this.journal.operation(id)?.state !== "issued")
      return this.getStatus(id);
    const prepared = await prepareMutationBatch(this.context, input);
    return this.journal.exclusive(() => {
      this.journal.verify(id, this.now());
      if (this.journal.operation(id)?.state !== "issued")
        return this.getStatus(id);
      this.journal.db
        .transaction(() => {
          this.journal.db
            .prepare(
              "UPDATE mutation_operations SET state='applying' WHERE id=?",
            )
            .run(id);
          for (const item of prepared.items) {
            const result: MutationResult = {
              index: item.index,
              path: item.path,
              type: item.type,
              status: item.status === "failed" ? "failed" : "pending",
              ...(item.code ? { code: item.code } : {}),
              ...(item.note_id ? { note_id: item.note_id } : {}),
              ...(item.expected_version
                ? { expected_version: item.expected_version }
                : {}),
              warnings: [],
            };
            this.journal.putItem(id, result, result.status);
          }
        })
        .immediate();
      for (const item of prepared.items)
        if (item.status === "prepared") this.applyItem(id, item);
      this.journal.finish(id);
      return this.getStatus(id);
    });
  }
  private applyItem(id: string, item: PreparedMutationItem) {
    const result: MutationResult = {
      index: item.index,
      path: item.path,
      type: item.type,
      status: "pending",
      ...(item.note_id ? { note_id: item.note_id } : {}),
      ...(item.expected_version
        ? { expected_version: item.expected_version }
        : {}),
      warnings: [],
    };
    const action = item.action!;
    const stage =
      action === "delete"
        ? undefined
        : path.posix.join(
            path.posix.dirname(item.path),
            `.vault-agent-mutation-${randomUUID()}.tmp`,
          );
    const intent: RecoveryIntent = {
      action,
      expected: item.expected_version,
      stage,
      prior: this.journal.path(item.path),
    };
    let committing = false;
    let publicationAttempted = false;
    try {
      this.assertAllowed(item.path);
      const parents = this.source.parents(item.path, action !== "delete");
      this.journal.putItem(id, result, "staging", intent);
      this.checkpoint("intent", item);
      if (stage && item.bytes) {
        intent.desired = this.source.writeStage(stage, item.bytes);
        if (item.note_id) intent.indexHash = this.indexHash(item.bytes);
        this.journal.putItem(id, result, "staged", intent);
      }
      this.checkpoint("stage", item);
      this.source.checkParents(parents);
      const current = this.source.stat(item.path);
      if (
        action === "create"
          ? !!current
          : current?.version !== item.expected_version
      )
        throw new MutationError(
          action === "create"
            ? "FILE_ALREADY_EXISTS"
            : "SOURCE_REVISION_MISMATCH",
        );
      if (action === "delete" && item.note_id)
        result.warnings = this.backlinkWarnings(item.note_id);
      this.journal.db
        .transaction(() => {
          this.journal.putItem(id, result, "committing", intent);
          this.journal.putPath({
            path: item.path,
            note_id: item.note_id ?? null,
            version: null,
            index_hash: null,
            blocked: 1,
            deleted: Number(action === "delete"),
            pending: 1,
          });
        })
        .immediate();
      committing = true;
      this.checkpoint("committing", item);
      // Last conditional check and file publication are synchronous under the shared writer lock.
      this.journal.db
        .transaction(() => {
          this.source.checkParents(parents);
          const latest = this.source.stat(item.path);
          if (
            action === "create"
              ? !!latest
              : latest?.version !== item.expected_version
          )
            throw new MutationError(
              action === "create"
                ? "FILE_ALREADY_EXISTS"
                : "SOURCE_REVISION_MISMATCH",
            );
          const target = path.join(this.source.root, item.path);
          publicationAttempted = true;
          if (action === "delete") fs.unlinkSync(target);
          else if (action === "create")
            fs.linkSync(path.join(this.source.root, stage!), target);
          else fs.renameSync(path.join(this.source.root, stage!), target);
          this.checkpoint("published", item);
          this.cleanStage(intent);
          this.source.syncDirectory(path.dirname(target));
          this.completeItem(id, result, intent);
        })
        .immediate();
      this.checkpoint("applied", item);
    } catch (error) {
      if (error instanceof LocalMutationInterruption) throw error;
      result.status = publicationAttempted ? "reconciling" : "failed";
      result.code =
        error instanceof MutationError || error instanceof LocalMutationError
          ? error.code
          : "SOURCE_UNAVAILABLE";
      if (!publicationAttempted) {
        if (committing)
          this.journal.db
            .transaction(() =>
              this.journal.restorePath(item.path, intent.prior),
            )
            .immediate();
        try {
          this.cleanStage(intent);
        } catch {
          /* retain recovery metadata for bounded cleanup */
        }
      }
      this.journal.putItem(id, result, result.status, intent);
    }
  }
  private completeItem(
    id: string,
    result: MutationResult,
    intent: RecoveryIntent,
  ) {
    const current = this.source.stat(result.path);
    if (
      intent.action === "delete"
        ? current !== null
        : !current ||
          JSON.stringify(current.fingerprint) !== JSON.stringify(intent.desired)
    )
      throw new LocalMutationError("OUTCOME_UNKNOWN");
    result.status = "applied";
    delete result.code;
    result.version = current?.version;
    result.index_state = "pending";
    this.journal.putPath({
      path: result.path,
      note_id: result.note_id ?? null,
      version: current?.version ?? null,
      index_hash: intent.indexHash ?? null,
      blocked: 0,
      deleted: Number(intent.action === "delete"),
      pending: 1,
    });
    this.journal.putItem(id, result, "applied");
  }
  private cleanStage(intent: RecoveryIntent) {
    if (!intent.stage) return;
    this.source.parents(intent.stage);
    const stage = path.join(this.source.root, intent.stage);
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(stage, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (
      !/^\.vault-agent-mutation-[0-9a-f-]{36}\.tmp$/.test(
        path.basename(stage),
      ) ||
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (intent.desired &&
        (String(stat.dev) !== intent.desired.dev ||
          String(stat.ino) !== intent.desired.ino ||
          String(stat.birthtimeNs) !== intent.desired.birth))
    )
      throw new LocalMutationError("OUTCOME_UNKNOWN");
    fs.unlinkSync(stage);
    this.source.syncDirectory(path.dirname(stage));
  }
  recover() {
    return this.journal.exclusive(() => {
      const rows = this.journal.db
        .prepare(
          "SELECT * FROM mutation_items WHERE state NOT IN ('applied','failed') ORDER BY operation_id,item_index",
        )
        .all() as ItemRow[];
      for (const row of rows) {
        const result = JSON.parse(row.result) as MutationResult;
        const intent = row.recovery
          ? (JSON.parse(row.recovery) as RecoveryIntent)
          : null;
        try {
          this.assertAllowed(row.path);
          if (intent) this.cleanStage(intent);
          if (row.state === "committing" || row.state === "reconciling") {
            if (!intent) throw new LocalMutationError("OUTCOME_UNKNOWN");
            this.source.syncDirectory(
              path.dirname(path.join(this.source.root, row.path)),
            );
            this.journal.db
              .transaction(() =>
                this.completeItem(row.operation_id, result, intent),
              )
              .immediate();
          } else {
            result.status = "failed";
            result.code = "OPERATION_INTERRUPTED";
            this.journal.putItem(row.operation_id, result, "failed");
          }
        } catch {
          result.status = "reconciling";
          result.code = "OUTCOME_UNKNOWN";
          this.journal.putItem(row.operation_id, result, "reconciling", intent);
        }
        this.journal.finish(row.operation_id);
      }
      return rows.length;
    });
  }
  getStatus(id: string) {
    const verified = this.journal.verify(id, this.now(), true);
    const row = this.journal.operation(id);
    if (!row)
      throw new LocalMutationError(
        this.now() >= verified.expires
          ? "OPERATION_EXPIRED"
          : "OPERATION_UNKNOWN",
      );
    if (row.policy !== this.policy)
      throw new LocalMutationError("PREVIEW_CHANGED");
    return {
      operation_id: id,
      expires_at: row.expires,
      state: row.state,
      results: this.journal.items(id).map((item) => {
        const result = JSON.parse(item.result) as MutationResult;
        const current = this.journal.path(item.path);
        if (
          result.status === "applied" &&
          current?.pending &&
          current.index_error
        )
          result.index_state = "failed";
        if (
          result.status === "applied" &&
          current &&
          !current.pending &&
          !current.blocked &&
          current.version === (result.version ?? null)
        )
          result.index_state = "fresh";
        return result;
      }),
    };
  }
  private backlinkWarnings(id: string): MutationResult["warnings"] {
    let db: Database.Database | undefined;
    try {
      if (!fs.existsSync(this.indexPath))
        return [{ code: "BACKLINKS_MAY_BE_STALE" }];
      db = new Database(this.indexPath, {
        readonly: true,
        fileMustExist: true,
      });
      const rows = db
        .prepare(
          "SELECT note_id,path,links_json FROM notes WHERE links_json IS NOT NULL",
        )
        .iterate() as Iterable<{
        note_id: string;
        path: string;
        links_json: string;
      }>;
      const references: { note_id: string; path: string }[] = [];
      let truncated = false;
      for (const row of rows) {
        if (row.note_id === id || !this.allowed(row.path)) continue;
        const state = this.journal.path(row.path);
        if (state?.blocked || state?.deleted) continue;
        const links = JSON.parse(row.links_json) as { resolved?: string }[];
        if (links.some((link) => link.resolved === id)) {
          if (references.length === 20) {
            truncated = true;
            break;
          }
          references.push({ note_id: row.note_id, path: row.path });
        }
      }
      return [
        { code: "BACKLINKS_MAY_BE_STALE" },
        ...(references.length
          ? [{ code: "INCOMING_LINKS", references, truncated }]
          : []),
      ];
    } catch {
      return [{ code: "BACKLINKS_MAY_BE_STALE" }];
    } finally {
      db?.close();
    }
  }
  private cleanupLocked(limit: number) {
    const rows = this.journal.db
      .prepare(
        "SELECT id FROM mutation_operations WHERE COALESCE(cleanup_after,expires)<=? AND state IN ('issued','completed') LIMIT ?",
      )
      .all(this.now(), limit) as { id: string }[];
    let removed = 0;
    for (const row of rows) {
      try {
        for (const item of this.journal.items(row.id))
          if (item.recovery) this.cleanStage(JSON.parse(item.recovery));
        this.journal.db
          .prepare("DELETE FROM mutation_operations WHERE id=?")
          .run(row.id);
        removed++;
      } catch {
        /* unresolved staging cleanup must survive audit expiry */
      }
    }
    return removed;
  }
  cleanup(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
      throw new LocalMutationError("INVALID_REQUEST");
    return this.journal.exclusive(() => this.cleanupLocked(limit));
  }
  private resolveNote(id: string, store: IndexStore): string | null {
    if (!isValidNoteId(id)) return null;
    const registered = this.journal.db
      .prepare("SELECT path FROM mutation_paths WHERE note_id=?")
      .get(id) as { path: string } | undefined;
    const relative = registered?.path ?? store.getNote(id)?.path;
    return typeof relative === "string" && noteIdFromPath(relative) === id
      ? relative
      : null;
  }
  async getNote(id: string) {
    const store = await IndexStore.open(this.indexPath);
    try {
      const relative = this.resolveNote(id, store);
      if (!relative) return null;
      this.assertAllowed(relative);
      this.refreshPath(relative);
      const state = this.journal.path(relative);
      if (state?.blocked || state?.deleted) return null;
      const snapshot = this.source.read(relative, 20 * 1024 * 1024);
      if (!snapshot) return null;
      const indexed = store
        .getDb()
        .prepare("SELECT * FROM notes WHERE note_id=?")
        .get(id) as
        (Record<string, unknown> & { content_hash: string }) | undefined;
      const fresh =
        indexed?.content_hash === this.indexHash(snapshot.bytes) &&
        (!state || state.version === snapshot.version);
      const content = this.decode(snapshot.bytes);
      const md = parseMarkdown(content.replace(/^\uFEFF/, ""));
      return {
        id,
        path: relative,
        content,
        title: md.frontmatter?.title ?? md.title,
        contentType: "text/markdown; charset=utf-8",
        metadata: {
          aliases: md.aliases,
          tags: md.tags,
          date: md.frontmatter?.date ?? null,
          created: md.frontmatter?.created ?? null,
          updated: md.frontmatter?.updated ?? null,
          attachmentCount: md.attachmentReferences.length,
        },
        attachments: md.attachmentReferences,
        size: snapshot.bytes.length,
        version: snapshot.version,
        indexed_version: fresh ? snapshot.version : null,
        indexed_content_hash: indexed?.content_hash ?? null,
        index_state: fresh
          ? "fresh"
          : state?.index_error
            ? "failed"
            : "pending",
        ...(state?.index_error ? { index_error: state.index_error } : {}),
      };
    } finally {
      store.close();
    }
  }
  getAttachment(relative: string, allowLarge = false) {
    this.assertAllowed(relative);
    this.refreshPath(relative);
    if (/\.(md|markdown)$/i.test(relative))
      throw new LocalMutationError("SOURCE_EXCLUDED");
    const state = this.journal.path(relative);
    if (state?.blocked || state?.deleted) return null;
    let snapshot;
    try {
      snapshot = this.source.read(
        relative,
        allowLarge ? 20 * 1024 * 1024 : DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT,
      );
    } catch (error) {
      if (
        error instanceof MutationError &&
        error.code === "SIZE_LIMIT_EXCEEDED"
      )
        throw new LocalMutationError("ATTACHMENT_TOO_LARGE");
      throw error;
    }
    return snapshot
      ? {
          path: relative,
          version: snapshot.version,
          size: snapshot.bytes.length,
          bytes: snapshot.bytes,
        }
      : null;
  }
  getFileVersion(relative: string) {
    this.assertAllowed(relative);
    this.refreshPath(relative);
    const state = this.journal.path(relative);
    if (state?.blocked || state?.deleted) return null;
    const snapshot = this.source.stat(relative);
    return snapshot
      ? { path: relative, version: snapshot.version, size: snapshot.size }
      : null;
  }
  async getChunk(id: string, index: number, expectedVersion?: string) {
    if (!Number.isSafeInteger(index) || index < 0)
      throw new LocalMutationError("INVALID_REQUEST");
    const store = await IndexStore.open(this.indexPath);
    try {
      const relative = this.resolveNote(id, store);
      if (!relative) return null;
      this.assertAllowed(relative);
      this.refreshPath(relative);
      const state = this.journal.path(relative);
      if (state?.blocked || state?.deleted) return null;
      const current = this.source.read(relative, 20 * 1024 * 1024);
      if (!current) return null;
      const indexed = store
        .getDb()
        .prepare("SELECT * FROM notes WHERE note_id=?")
        .get(id) as
        (Record<string, unknown> & { content_hash: string }) | undefined;
      if (
        indexed?.content_hash !== this.indexHash(current.bytes) ||
        (state && state.version !== current.version)
      )
        throw new LocalMutationError("REVISION_CHANGED");
      const chunk = store.getChunk(id, index);
      if (
        expectedVersion &&
        expectedVersion !== current.version &&
        (!chunk ||
          !indexed ||
          expectedVersion !== indexedChunkVersion(indexed, chunk))
      )
        throw new LocalMutationError("REVISION_CHANGED");
      return chunk
        ? {
            ...chunkFromRows(id, index, chunk, store.getNote(id)),
            version: current.version,
          }
        : null;
    } finally {
      store.close();
    }
  }
  async flushIndex() {
    this.recover();
    this.refreshSources();
    const pending = this.journal.db
      .prepare(
        "SELECT * FROM mutation_paths WHERE pending=1 AND blocked=0 ORDER BY sequence LIMIT 100",
      )
      .all() as MutationPathState[];
    if (!pending.length) return { processed: 0 };
    const store = await IndexStore.open(this.indexPath);
    try {
      await updateLocalIndex(store, this.config, {
        paths: pending.map((item) => item.path),
        vaultIdentity: configuredVaultIdentity(this.config),
      });
      let processed = 0;
      this.journal.db
        .transaction(() => {
          for (const item of pending) {
            const current = this.journal.path(item.path);
            if (
              !current ||
              current.sequence !== item.sequence ||
              current.blocked
            )
              continue;
            const row = store
              .getDb()
              .prepare("SELECT content_hash FROM notes WHERE path=?")
              .get(item.path) as { content_hash: string } | undefined;
            const snapshot = this.source.stat(item.path);
            if (
              item.deleted
                ? snapshot !== null || row !== undefined
                : snapshot?.version !== item.version ||
                  (item.note_id && row?.content_hash !== item.index_hash)
            )
              continue;
            this.journal.db
              .prepare(
                "UPDATE mutation_paths SET pending=0,index_error=NULL WHERE path=? AND sequence=?",
              )
              .run(item.path, item.sequence);
            processed++;
          }
        })
        .immediate();
      return { processed };
    } catch (error) {
      const code =
        error instanceof IndexError ? error.code : "INDEX_UPDATE_FAILED";
      this.journal.db
        .transaction(() => {
          for (const item of pending)
            this.journal.db
              .prepare(
                "UPDATE mutation_paths SET index_error=? WHERE path=? AND sequence=?",
              )
              .run(code, item.path, item.sequence);
        })
        .immediate();
      throw new LocalMutationError(code);
    } finally {
      store.close();
    }
  }
  private refreshPath(relative: string) {
    this.journal.db
      .transaction(() => {
        const known = this.journal.path(relative);
        if (!known || known.blocked === 1) return;
        try {
          this.assertAllowed(relative);
          const current = this.source.stat(
            relative,
            !!known.note_id,
            20 * 1024 * 1024,
          );
          if (!current) {
            if (!known.deleted || known.blocked)
              this.journal.putPath({
                path: relative,
                note_id: known.note_id,
                version: null,
                index_hash: null,
                deleted: 1,
                blocked: 0,
                pending: 1,
              });
          } else if (
            known.version !== current.version ||
            known.deleted ||
            known.blocked
          ) {
            this.journal.putPath({
              path: relative,
              note_id: known.note_id,
              version: current.version,
              index_hash: current.textHash ?? null,
              deleted: 0,
              blocked: 0,
              pending: 1,
            });
          }
        } catch (error) {
          if (known.blocked !== 2)
            this.journal.putPath({ ...known, blocked: 2, pending: 1 });
          this.journal.db
            .prepare("UPDATE mutation_paths SET index_error=? WHERE path=?")
            .run(
              error instanceof MutationError ||
                error instanceof LocalMutationError
                ? error.code
                : "SOURCE_UNAVAILABLE",
              relative,
            );
        }
      })
      .immediate();
  }
  refreshSources(limit = 100) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new LocalMutationError("INVALID_REQUEST");
    const rows = this.journal.db
      .prepare(
        "SELECT path FROM mutation_paths WHERE path>? AND blocked<>1 ORDER BY path LIMIT ?",
      )
      .all(this.observationCursor, limit) as { path: string }[];
    for (const row of rows) this.refreshPath(row.path);
    this.observationCursor = rows.length === limit ? rows.at(-1)!.path : "";
    return rows.length;
  }
  pendingCount() {
    return Number(
      (
        this.journal.db
          .prepare(
            "SELECT COUNT(*) AS count FROM mutation_paths WHERE pending=1",
          )
          .get() as { count: number }
      ).count,
    );
  }
  close() {
    this.journal.close();
  }
}

export { LocalMutationError } from "./mutation-journal.js";
export type { MutationResult } from "./mutation-journal.js";

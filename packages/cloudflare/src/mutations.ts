import { isPCloud, pcloudSource } from "./source.js";
import * as core from "@vault-agent/core/portable";
import { config, type Env } from "./config.js";
import { boundedBytes, CloudError } from "./errors.js";
import {
  mutationPath,
  mutationSuppression,
  r2SourceVersion,
  type R2MutationPath,
} from "./mutation-state.js";

type Result = {
  index: number;
  path: string;
  type: string;
  note_id?: string;
  status: "pending" | "applied" | "failed" | "reconciling";
  code?: string;
  version?: string;
  index_state?: "pending" | "fresh";
  oversized_for_index?: boolean;
  warnings: {
    code: string;
    references?: { note_id: string; path: string }[];
    truncated?: boolean;
  }[];
};
type Operation = {
  id: string;
  nonce: string;
  digest: string;
  policy: string;
  issued: number;
  expires: number;
  preview: number;
  state: string;
  lease: string | null;
  lease_until: number;
  retention_ms: number;
};
type OperationClaim = Pick<
  Operation,
  "id" | "nonce" | "digest" | "policy" | "issued" | "expires" | "preview"
>;
type Item = {
  operation_id: string;
  item_index: number;
  path: string;
  state: string;
  result: string;
  recovery: string | null;
};
type Intent = {
  action: string;
  digest: string | null;
  etag: string | null;
  before: string | null;
  prior: R2MutationPath | null;
};
export interface R2MutationOptions {
  settings: Partial<core.MutationSettings>;
  now?: () => number;
  /** Internal synthetic interruption hook. Never exposed through configuration/HTTP. */
  checkpoint?: (
    phase: "claimed" | "staged" | "committing" | "published" | "applied",
    index: number,
  ) => void | Promise<void>;
}
/** Test interruption deliberately bypasses ordinary failure handling. */
export class R2MutationInterruption extends Error {}
function fail(code: string, status = 409): never {
  throw new CloudError(code, status);
}
const text = (value: string) => new TextEncoder().encode(value);
const hex = (value: ArrayBuffer) =>
  Array.from(new Uint8Array(value), (n) =>
    n.toString(16).padStart(2, "0"),
  ).join("");
const MAX_SOURCE = 20 * 1024 * 1024;

/** Durable mutation journal for the configured Workers source. */
export class R2MutationService {
  private constructor(
    readonly env: Env,
    readonly settings: core.MutationSettings,
    private readonly policy: string,
    private readonly options: R2MutationOptions,
  ) {}
  static async open(env: Env, options: R2MutationOptions) {
    config(env);
    const parsed = core.mutationSettingsSchema.safeParse(options.settings);
    if (!parsed.success || parsed.data.max_batch_bytes > 20 * 1024 * 1024)
      fail("INVALID_REQUEST", 400);
    if (!parsed.data.enabled) fail("WRITE_DISABLED", 403);
    if (
      !(await env.DB.prepare(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name='r2_mutation_maintenance'",
      ).first())
    )
      fail("MUTATION_UPGRADE_REQUIRED", 503);
    const policy = await core.contentRevision(
      JSON.stringify([
        "internal-r2-v1",
        env.VAULT_ID,
        ...(isPCloud(env)
          ? ["pcloud", env.PCLOUD_REGION, env.PCLOUD_FOLDER_ID]
          : []),
        env.INCLUDE_PATHS,
        env.EXCLUDE_PATHS,
        parsed.data,
      ]),
    );
    return new R2MutationService(env, parsed.data, policy, options);
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private key(path: string) {
    return `${this.env.VAULT_ID}/source/${path}`;
  }
  private check(path: string) {
    core.canonicalSourcePath(path);
    if (
      !config(this.env).allowed(path) ||
      path.split("/").some((p) => p.startsWith(".")) ||
      !core.uploadKind(path)
    )
      fail("SOURCE_EXCLUDED", 403);
  }
  private async sign(value: string) {
    const key = await crypto.subtle.importKey(
      "raw",
      text(this.env.ADMIN_TOKEN),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    return hex(
      await crypto.subtle.sign(
        "HMAC",
        key,
        text(`${this.env.VAULT_ID}\0${value}`),
      ),
    );
  }
  private async verifies(value: string, signature: string) {
    if (!/^[a-f0-9]{64}$/.test(signature)) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      text(this.env.ADMIN_TOKEN),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"],
    );
    const bytes = Uint8Array.from(signature.match(/../g)!, (s) =>
      parseInt(s, 16),
    );
    return crypto.subtle.verify(
      "HMAC",
      key,
      bytes,
      text(`${this.env.VAULT_ID}\0${value}`),
    );
  }
  private async verify(id: string, allowExpired = false) {
    if (typeof id !== "string" || id.length > 300) fail("OPERATION_INVALID");
    const parts = id.split(".");
    const deferred = parts[0] === "r2m2";
    const nonce = parts[3]!;
    const digest = parts[4]!;
    const policy = parts[5]!;
    const preview = parts[6];
    if (
      (deferred
        ? parts.length !== 8 ||
          !/^[a-f0-9]{64}$/.test(policy) ||
          (preview !== "0" && preview !== "1")
        : parts.length !== 6 || parts[0] !== "r2m1") ||
      !/^\d{1,16}$/.test(parts[1]!) ||
      !/^\d{1,16}$/.test(parts[2]!) ||
      !/^[a-f0-9-]{36}$/.test(nonce) ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      !(await this.verifies(parts.slice(0, -1).join("."), parts.at(-1)!))
    )
      fail("OPERATION_INVALID");
    const issued = Number(parts[1]),
      expires = Number(parts[2]);
    if (
      !Number.isSafeInteger(issued) ||
      !Number.isSafeInteger(expires) ||
      expires <= issued ||
      issued > this.now() + core.MUTATION_CLOCK_SKEW_MS
    )
      fail("OPERATION_INVALID");
    if (!allowExpired && this.now() >= expires) fail("OPERATION_EXPIRED");
    const claim: OperationClaim | undefined = deferred
      ? { id, nonce, digest, policy, issued, expires, preview: Number(preview) }
      : undefined;
    return { digest, claim };
  }
  private operation(id: string) {
    return this.env.DB.prepare(
      "SELECT * FROM r2_mutation_operations WHERE id=?",
    )
      .bind(id)
      .first<Operation>();
  }
  private context(): core.MutationPreparationContext {
    return {
      vaultId: this.env.VAULT_ID,
      sourceId: `${isPCloud(this.env) ? "pcloud" : "r2"}:${this.env.VAULT_ID}`,
      sourceKind: isPCloud(this.env) ? "pcloud" : "r2",
      policyRevision: this.policy,
      includes: JSON.parse(this.env.INCLUDE_PATHS),
      excludes: JSON.parse(this.env.EXCLUDE_PATHS),
      settings: this.settings,
      attachmentAllowed: (p) =>
        !isPCloud(this.env) && core.uploadKind(p) === "attachment",
      snapshot: async (path, opts) => {
        const row = await mutationPath(this.env, path);
        if (row?.state === "uncertain") fail("SOURCE_UNAVAILABLE", 503);
        let value: Awaited<ReturnType<R2MutationService["read"]>>;
        try {
          value = await this.read(path, opts.readContent, opts.maxBytes);
        } catch (error) {
          if (error instanceof CloudError && error.code === "SOURCE_TOO_LARGE")
            throw new core.SourceError(
              "SOURCE_TOO_LARGE",
              "Source exceeds the admitted size.",
            );
          if (error instanceof CloudError && error.code === "INVALID_UTF8")
            throw new core.MutationError("INVALID_UTF8");
          throw error;
        }
        return value
          ? {
              version: value.version,
              ...(opts.readContent ? { content: value.content! } : {}),
            }
          : null;
      },
    };
  }
  /** Current bytes and generation are always read together and bounded. */
  async read(path: string, content = false, maxBytes = MAX_SOURCE) {
    this.check(path);
    return readRawMutationSource(this.env, path, content, maxBytes);
  }
  async preview(input: unknown, includePreview = true) {
    const batch = await core.prepareMutationBatch(this.context(), input, {
      preview: includePreview,
    });
    const issued = this.now(),
      expires = issued + this.settings.history_retention_days * 86400000;
    const nonce = crypto.randomUUID();
    const base = [
      "r2m2",
      issued,
      expires,
      nonce,
      batch.request_digest,
      this.policy,
      Number(includePreview),
    ].join(".");
    const id = `${base}.${await this.sign(base)}`;
    return {
      operation_id: id,
      expires,
      ...(includePreview
        ? {
            preview_binding: await this.sign(`preview\0${id}`),
            preview: core.previewMutationBatch(batch),
          }
        : { summary: core.mutationBatchSummary(batch) }),
    };
  }
  async status(id: string) {
    const { claim } = await this.verify(id, true);
    return this.durableStatus(id, claim);
  }
  private async durableStatus(id: string, claim?: OperationClaim) {
    const op = await this.operation(id);
    if (!op) {
      if (!claim || this.now() >= claim.expires) fail("OPERATION_UNKNOWN", 404);
      if (claim.policy !== this.policy) fail("PREVIEW_CHANGED");
      return {
        operation_id: id,
        state: "issued",
        expires: claim.expires,
        results: [],
      };
    }
    const rows = await this.env.DB.prepare(
      "SELECT state,result FROM r2_mutation_items WHERE operation_id=? ORDER BY item_index LIMIT 101",
    )
      .bind(id)
      .all<{ state: string; result: string }>();
    if (rows.results.length > 100) fail("INVALID_REQUEST", 400);
    const publication = await this.env.DB.prepare(
      "SELECT m.item_index,m.state,m.digest,m.object_version,d.revision AS store,s.path AS indexed_path,s.digest AS indexed_digest,o.object_version AS indexed_version FROM r2_mutation_paths m LEFT JOIN deployment d ON d.id=1 LEFT JOIN sources s ON s.revision=d.revision AND s.path=m.path LEFT JOIN source_observations o ON o.revision=s.revision AND o.path=s.path WHERE m.owner=? LIMIT 101",
    )
      .bind(id)
      .all<{
        item_index: number;
        state: string;
        digest: string | null;
        object_version: string | null;
        store: string | null;
        indexed_path: string | null;
        indexed_digest: string | null;
        indexed_version: string | null;
      }>();
    const fresh = new Set(
      publication.results
        .filter(
          (p) =>
            p.store &&
            (p.state === "deleted"
              ? p.indexed_path === null
              : p.state === "saved" &&
                p.digest === p.indexed_digest &&
                (isPCloud(this.env) || p.object_version === p.indexed_version)),
        )
        .map((p) => `${p.item_index}:${p.state}`),
    );
    return {
      operation_id: id,
      state: op.state,
      expires: op.expires,
      results: rows.results.map((r) => {
        const result = JSON.parse(r.result) as Result;
        if (
          result.status === "applied" &&
          fresh.has(
            `${result.index}:${result.type === "delete_file" ? "deleted" : "saved"}`,
          )
        )
          result.index_state = "fresh";
        return r.state === "committing" && op.lease_until < this.now()
          ? {
              ...result,
              status: "reconciling" as const,
              code: "SOURCE_UNAVAILABLE",
            }
          : result;
      }),
    };
  }
  private guard(op: Pick<Operation, "id">, token: string) {
    return this.env.DB.prepare(
      "INSERT OR REPLACE INTO ingestion_guard VALUES(1,COALESCE((SELECT 1 FROM r2_mutation_operations WHERE id=? AND lease=? AND lease_until>?),0))",
    ).bind(op.id, token, this.now());
  }
  private pathGuard(id: string, index: number, path: string) {
    return this.env.DB.prepare(
      "INSERT OR REPLACE INTO ingestion_guard VALUES(1,COALESCE((SELECT 1 FROM r2_mutation_paths WHERE path=? AND owner=? AND item_index=? AND state='uncertain'),0))",
    ).bind(path, id, index);
  }
  async apply(id: string, input: unknown, binding?: string) {
    const verified = await this.verify(id);
    const recorded = await this.operation(id);
    const op = recorded ?? verified.claim;
    if (!op) fail("OPERATION_UNKNOWN", 404);
    if (op.policy !== this.policy) fail("PREVIEW_CHANGED");
    if (
      (await core.mutationRequestDigest(this.context(), input)) !==
      verified.digest
    )
      fail("IDEMPOTENCY_CONFLICT");
    if (
      this.settings.mode === "review" &&
      (!op.preview ||
        !binding ||
        !(await this.verifies(`preview\0${id}`, binding)))
    )
      fail("PREVIEW_REQUIRED");
    if (recorded && recorded.state !== "issued") return this.durableStatus(id);
    const batch = await core.prepareMutationBatch(this.context(), input);
    const token = crypto.randomUUID();
    const results = batch.items.map(
      (item) =>
        ({
          index: item.index,
          path: item.path,
          type: item.type,
          status: item.status === "failed" ? "failed" : "pending",
          ...(item.code ? { code: item.code } : {}),
          ...(item.note_id ? { note_id: item.note_id } : {}),
          ...(item.oversized_for_index ? { oversized_for_index: true } : {}),
          warnings: [],
        }) as Result,
    );
    try {
      await this.env.DB.batch([
        ...(!recorded
          ? [
              this.env.DB.prepare(
                "INSERT INTO r2_mutation_operations(id,nonce,digest,policy,issued,expires,preview,state,retention_ms) VALUES(?,?,?,?,?,?,?,'issued',?) ON CONFLICT(id) DO NOTHING",
              ).bind(
                id,
                op.nonce,
                op.digest,
                op.policy,
                op.issued,
                op.expires,
                op.preview,
                op.expires - op.issued,
              ),
            ]
          : []),
        this.env.DB.prepare(
          "INSERT OR REPLACE INTO ingestion_guard VALUES(1,COALESCE((SELECT 1 FROM r2_mutation_operations WHERE id=? AND state='issued' AND expires>?),0))",
        ).bind(id, this.now()),
        this.env.DB.prepare(
          "UPDATE r2_mutation_operations SET state='applying',lease=?,lease_until=? WHERE id=?",
        ).bind(token, this.now() + 120000, id),
        ...results.map((r) =>
          this.env.DB.prepare(
            "INSERT INTO r2_mutation_items(operation_id,item_index,path,state,result,recovery) VALUES(?,?,?,?,?,NULL)",
          ).bind(id, r.index, r.path, r.status, JSON.stringify(r)),
        ),
      ]);
    } catch (error) {
      const current = await this.operation(id);
      if (current && current.state !== "issued") return this.durableStatus(id);
      await this.verify(id);
      throw error;
    }
    await this.options.checkpoint?.("claimed", -1);
    for (const item of batch.items)
      if (item.status === "prepared")
        await this.applyItem(op, token, item, results[item.index]!);
    await this.finish(id);
    return this.durableStatus(id);
  }
  private async applyItem(
    op: Pick<Operation, "id" | "nonce">,
    token: string,
    item: core.PreparedMutationItem,
    result: Result,
  ) {
    let intent: Intent | undefined;
    let committing = false;
    try {
      const prior = await mutationPath(this.env, item.path);
      if (prior?.state === "uncertain") fail("SOURCE_UNAVAILABLE", 503);
      if (item.action === "delete")
        result.warnings = await this.deletionWarnings(item.path, item.note_id);
      const current = await this.read(item.path);
      if (
        item.action === "create"
          ? !!current
          : current?.version !== item.expected_version
      )
        fail(
          item.action === "create"
            ? "FILE_ALREADY_EXISTS"
            : "SOURCE_REVISION_MISMATCH",
        );
      const physical = isPCloud(this.env)
        ? null
        : (current?.object ??
          (await this.env.SOURCE!.head(this.key(item.path))));
      const digest =
        item.action === "delete"
          ? null
          : await core.contentRevision(item.bytes!);
      const stage = `${this.env.VAULT_ID}/mutations/${op.nonce}/${item.index}`;
      if (item.action !== "delete" && !isPCloud(this.env))
        await this.env.SOURCE!.put(stage, item.bytes!, { sha256: digest! });
      await this.options.checkpoint?.("staged", item.index);
      intent = {
        action: item.action!,
        digest,
        etag: physical?.etag ?? null,
        before: current?.version ?? null,
        prior,
      };
      await this.env.DB.batch([
        this.guard(op, token),
        ...(isPCloud(this.env)
          ? [
              this.env.DB.prepare(
                "UPDATE r2_mutation_operations SET lease_until=? WHERE id=?",
              ).bind(this.now() + 120000, op.id),
            ]
          : []),
        this.env.DB.prepare(
          "INSERT INTO r2_mutation_paths(path,note_id,owner,item_index,state,updated) VALUES(?,?,?,?,'uncertain',?) ON CONFLICT(path) DO UPDATE SET note_id=excluded.note_id,owner=excluded.owner,item_index=excluded.item_index,state='uncertain',digest=NULL,object_version=NULL,version=NULL,updated=excluded.updated WHERE r2_mutation_paths.state<>'uncertain' AND r2_mutation_paths.owner IS ? AND r2_mutation_paths.item_index IS ?",
        ).bind(
          item.path,
          item.note_id ?? null,
          op.id,
          item.index,
          this.now(),
          prior?.owner ?? null,
          prior?.item_index ?? null,
        ),
        this.pathGuard(op.id, item.index, item.path),
        this.env.DB.prepare(
          "UPDATE r2_mutation_items SET state='committing',recovery=?,result=? WHERE operation_id=? AND item_index=?",
        ).bind(
          JSON.stringify(intent),
          JSON.stringify(result),
          op.id,
          item.index,
        ),
        this.env.DB.prepare(
          "UPDATE r2_mutation_meta SET epoch=epoch+1 WHERE id=1",
        ),
      ]);
      committing = true;
      await this.options.checkpoint?.("committing", item.index);
      if (isPCloud(this.env)) {
        await pcloudSource(this.env, true).writeNote(
          item.path,
          intent.before,
          item.bytes ?? null,
        );
        await this.options.checkpoint?.("published", item.index);
        await this.acknowledge(op.id, result, intent, null);
        await this.options.checkpoint?.("applied", item.index);
        return;
      }
      // Recheck generation after staging/intent, immediately before conditional PUT.
      const latest = await this.read(item.path);
      const latestPhysical =
        latest?.object ?? (await this.env.SOURCE!.head(this.key(item.path)));
      if (
        (latest?.version ?? null) !== intent.before ||
        (latestPhysical?.version ?? null) !== (physical?.version ?? null)
      ) {
        await this.restore(op.id, result, intent, "SOURCE_REVISION_MISMATCH");
        return;
      }
      const object = await this.env.SOURCE!.put(
        this.key(item.path),
        item.bytes ?? new Uint8Array(),
        {
          onlyIf: physical
            ? { etagMatches: physical.etag }
            : { etagDoesNotMatch: "*" },
          sha256: digest ?? (await core.contentRevision(new Uint8Array())),
          customMetadata: {
            mutation: op.nonce,
            item: String(item.index),
            ...(item.action === "delete" ? { deleted: "true" } : {}),
          },
        },
      );
      if (!object) {
        await this.restore(op.id, result, intent, "SOURCE_REVISION_MISMATCH");
        return;
      }
      await this.options.checkpoint?.("published", item.index);
      await this.acknowledge(op.id, result, intent, object);
      await this.options.checkpoint?.("applied", item.index);
    } catch (error) {
      if (error instanceof R2MutationInterruption) throw error;
      if (committing && intent && error instanceof core.PCloudWriteConflict) {
        await this.restore(op.id, result, intent, error.code);
      } else if (committing) {
        result.status = "reconciling";
        result.code = "SOURCE_UNAVAILABLE";
        await this.env.DB.prepare(
          "UPDATE r2_mutation_items SET state='reconciling',result=?,retry_after=? WHERE operation_id=? AND item_index=? AND state IN ('committing','reconciling')",
        )
          .bind(
            JSON.stringify(result),
            isPCloud(this.env) ? this.now() + 60000 : 0,
            op.id,
            item.index,
          )
          .run();
      } else {
        result.status = "failed";
        result.code =
          error instanceof CloudError || error instanceof core.SourceError
            ? error.code
            : "SOURCE_UNAVAILABLE";
        await this.env.DB.batch([
          this.guard(op, token),
          this.env.DB.prepare(
            "UPDATE r2_mutation_items SET state='failed',result=? WHERE operation_id=? AND item_index=? AND state='pending'",
          ).bind(JSON.stringify(result), op.id, item.index),
        ]);
      }
    }
  }
  private async deletionWarnings(
    path: string,
    noteId?: string,
  ): Promise<Result["warnings"]> {
    const warnings: Result["warnings"] = [{ code: "BACKLINKS_MAY_BE_STALE" }];
    try {
      const active = await this.env.DB.prepare(
        "SELECT revision FROM deployment WHERE id=1",
      ).first<{ revision: string }>();
      if (!active) return warnings;
      const suppressed = await mutationSuppression(this.env, active.revision);
      const rows = await this.env.DB.prepare(
        `SELECT note_id,path,EXISTS(SELECT 1 FROM json_each(json_extract(notes.data,?)) ref WHERE ${noteId ? "json_extract(ref.value,'$.resolved')" : "ref.value"}=?) AS linked FROM notes WHERE revision=? ORDER BY path LIMIT 501`,
      )
        .bind(
          noteId ? "$.links_json" : "$.attachment_refs_json",
          noteId ?? path,
          active.revision,
        )
        .all<{
          note_id: string;
          path: string;
          linked: number;
        }>();
      const references: { note_id: string; path: string }[] = [];
      let truncated = rows.results.length > 500;
      for (const row of rows.results.slice(0, 500)) {
        if (
          row.note_id === noteId ||
          !config(this.env).allowed(row.path) ||
          suppressed.has(row.path)
        )
          continue;
        if (!row.linked) continue;
        if (references.length === 20) {
          truncated = true;
          break;
        }
        references.push({ note_id: row.note_id, path: row.path });
      }
      if (references.length)
        warnings.push({ code: "INCOMING_LINKS", references, truncated });
    } catch {
      /* Warnings must never block deletion or disclose raw index failures. */
    }
    return warnings;
  }
  private async acknowledge(
    id: string,
    result: Result,
    intent: Intent,
    object: R2Object | null,
  ) {
    const version =
      intent.digest && object
        ? await r2SourceVersion(
            this.env.VAULT_ID,
            result.path,
            object.version,
            intent.digest,
          )
        : (intent.digest ?? undefined);
    result.status = "applied";
    delete result.code;
    result.index_state = "pending";
    if (version) result.version = version;
    await this.env.DB.batch([
      this.pathGuard(id, result.index, result.path),
      this.env.DB.prepare(
        "UPDATE r2_mutation_paths SET state=?,digest=?,object_version=?,version=?,updated=? WHERE path=?",
      ).bind(
        intent.action === "delete" ? "deleted" : "saved",
        intent.digest,
        object?.version ?? null,
        version ?? null,
        this.now(),
        result.path,
      ),
      this.env.DB.prepare(
        "UPDATE r2_mutation_items SET state='applied',result=?,recovery=NULL WHERE operation_id=? AND item_index=?",
      ).bind(JSON.stringify(result), id, result.index),
      this.env.DB.prepare(
        "UPDATE r2_mutation_meta SET epoch=epoch+1 WHERE id=1",
      ),
    ]);
  }
  private async restore(
    id: string,
    result: Result,
    intent: Intent,
    code: string,
  ) {
    result.status = "failed";
    result.code = code;
    const prior = intent.prior;
    await this.env.DB.batch([
      this.pathGuard(id, result.index, result.path),
      prior
        ? this.env.DB.prepare(
            "UPDATE r2_mutation_paths SET note_id=?,owner=?,item_index=?,state=?,digest=?,object_version=?,version=?,updated=? WHERE path=?",
          ).bind(
            prior.note_id,
            prior.owner,
            prior.item_index,
            prior.state,
            prior.digest,
            prior.object_version,
            prior.version,
            prior.updated,
            result.path,
          )
        : this.env.DB.prepare(
            "DELETE FROM r2_mutation_paths WHERE path=?",
          ).bind(result.path),
      this.env.DB.prepare(
        "UPDATE r2_mutation_items SET state='failed',result=?,recovery=NULL WHERE operation_id=? AND item_index=?",
      ).bind(JSON.stringify(result), id, result.index),
      this.env.DB.prepare(
        "UPDATE r2_mutation_meta SET epoch=epoch+1 WHERE id=1",
      ),
    ]);
  }
  private async finish(id: string) {
    await this.env.DB.prepare(
      "UPDATE r2_mutation_operations SET state=CASE WHEN EXISTS(SELECT 1 FROM r2_mutation_items WHERE operation_id=? AND state NOT IN ('applied','failed')) THEN 'reconciling' ELSE 'completed' END,lease=NULL,lease_until=0,completed=CASE WHEN EXISTS(SELECT 1 FROM r2_mutation_items WHERE operation_id=? AND state NOT IN ('applied','failed')) THEN NULL ELSE coalesce(completed,?) END,cleanup_after=CASE WHEN EXISTS(SELECT 1 FROM r2_mutation_items WHERE operation_id=? AND state NOT IN ('applied','failed')) THEN NULL ELSE coalesce(cleanup_after,?+retention_ms) END WHERE id=?",
    )
      .bind(id, id, this.now(), id, this.now(), id)
      .run();
  }
  /** Bounded metadata/receipt recovery; NEVER repeats a source write. */
  async recover(limit = 20, deadline = Infinity) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail("INVALID_REQUEST", 400);
    const rows = await this.env.DB.prepare(
      "SELECT i.* FROM r2_mutation_items i JOIN r2_mutation_operations o ON o.id=i.operation_id WHERE i.state IN ('pending','committing','reconciling') AND o.lease_until<? AND i.retry_after<=? ORDER BY i.checked,o.issued,i.item_index LIMIT ?",
    )
      .bind(this.now(), this.now(), limit)
      .all<Item>();
    const touched = new Set<string>();
    let inspected = 0;
    for (const row of rows.results) {
      if (this.now() >= deadline) break;
      const claim = await this.env.DB.prepare(
        "UPDATE r2_mutation_items SET checked=?,retry_after=? WHERE operation_id=? AND item_index=? AND retry_after<=? AND state IN ('pending','committing','reconciling') AND EXISTS(SELECT 1 FROM r2_mutation_operations WHERE id=? AND lease_until<?)",
      )
        .bind(
          this.now(),
          this.now() + 60000,
          row.operation_id,
          row.item_index,
          this.now(),
          row.operation_id,
          this.now(),
        )
        .run();
      if (!claim.meta.changes) continue;
      inspected++;
      const result = JSON.parse(row.result) as Result;
      touched.add(row.operation_id);
      try {
        if (row.state === "pending") {
          result.status = "failed";
          result.code = "SOURCE_UNAVAILABLE";
          await this.env.DB.prepare(
            "UPDATE r2_mutation_items SET state='failed',result=? WHERE operation_id=? AND item_index=? AND state='pending'",
          )
            .bind(JSON.stringify(result), row.operation_id, row.item_index)
            .run();
          continue;
        }
        const op = await this.operation(row.operation_id);
        if (!op || !row.recovery) continue;
        const intent = JSON.parse(row.recovery) as Intent;
        if (isPCloud(this.env)) {
          const current = await this.read(row.path);
          if ((current?.version ?? null) === intent.digest)
            await this.acknowledge(row.operation_id, result, intent, null);
          else
            await this.restore(
              row.operation_id,
              result,
              intent,
              "OUTCOME_UNKNOWN",
            );
          continue;
        }
        const object = await this.env.SOURCE!.head(this.key(row.path));
        if (
          !object ||
          object.customMetadata?.mutation !== op.nonce ||
          object.customMetadata?.item !== String(row.item_index)
        )
          continue;
        const expected =
          intent.digest ?? (await core.contentRevision(new Uint8Array()));
        if (
          !object.checksums.sha256 ||
          hex(object.checksums.sha256) !== expected ||
          (intent.action === "delete" &&
            (object.size !== 0 || object.customMetadata?.deleted !== "true"))
        )
          continue;
        try {
          await this.acknowledge(row.operation_id, result, intent, object);
        } catch {
          /* A concurrent recovery/path transition wins; never replay. */
        }
      } catch {
        // Binding failures retain suppression and defer this item, not later work.
      }
    }
    for (const id of touched) await this.finish(id);
    if (inspected < limit && this.now() < deadline) {
      const completed = await this.env.DB.prepare(
        "SELECT id FROM r2_mutation_operations o WHERE state IN ('applying','reconciling') AND lease_until<? AND EXISTS(SELECT 1 FROM r2_mutation_items WHERE operation_id=o.id) AND NOT EXISTS(SELECT 1 FROM r2_mutation_items WHERE operation_id=o.id AND state NOT IN ('applied','failed')) ORDER BY issued LIMIT ?",
      )
        .bind(this.now(), limit - inspected)
        .all<{ id: string }>();
      for (const op of completed.results) {
        if (this.now() >= deadline) break;
        await this.finish(op.id);
        inspected++;
      }
    }
    return { inspected };
  }
  /** Only terminal metadata/staging expires. Path suppression is never audit history. */
  async cleanup(limit = 10, deadline = Infinity) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      fail("INVALID_REQUEST", 400);
    const now = this.now();
    const ops = await this.env.DB.prepare(
      "SELECT id,nonce FROM r2_mutation_operations WHERE cleanup_retry_after<=? AND expires<=? AND (state='issued' OR (state='completed' AND cleanup_after<?)) ORDER BY cleanup_checked,issued LIMIT ?",
    )
      .bind(now, now - core.MUTATION_CLOCK_SKEW_MS, now, limit)
      .all<{ id: string; nonce: string }>();
    let inspected = 0;
    for (const op of ops.results) {
      if (this.now() >= deadline) break;
      const claim = await this.env.DB.prepare(
        "UPDATE r2_mutation_operations SET cleanup_checked=?,cleanup_retry_after=? WHERE id=? AND state IN ('issued','completed') AND cleanup_retry_after<=?",
      )
        .bind(this.now(), this.now() + 60000, op.id, this.now())
        .run();
      if (!claim.meta.changes) continue;
      inspected++;
      try {
        const page = await (isPCloud(this.env)
          ? undefined
          : this.env.SOURCE?.list({
              prefix: `${this.env.VAULT_ID}/mutations/${op.nonce}/`,
              limit: 100,
            }));
        if (page?.objects.length)
          await this.env.SOURCE!.delete(page.objects.map((o) => o.key));
        if (page?.truncated) continue;
        await this.env.DB.batch([
          this.env.DB.prepare(
            "DELETE FROM r2_mutation_items WHERE operation_id=?",
          ).bind(op.id),
          this.env.DB.prepare(
            "DELETE FROM r2_mutation_operations WHERE id=? AND state IN ('issued','completed')",
          ).bind(op.id),
        ]);
      } catch {
        // Retain the operation and defer this cleanup while later work progresses.
      }
    }
    return { inspected };
  }
}

/** Read-only source helper: never instantiates/enables mutation capability. */
export async function readMutationSource(
  env: Env,
  path: string,
  content = false,
  maxBytes = MAX_SOURCE,
) {
  core.canonicalSourcePath(path);
  if (
    !config(env).allowed(path) ||
    path.split("/").some((p) => p.startsWith(".")) ||
    !core.uploadKind(path)
  )
    fail("SOURCE_EXCLUDED", 403);
  const state = await mutationPath(env, path);
  if (state?.state === "uncertain") fail("SOURCE_UNAVAILABLE", 503);
  if (state?.state === "deleted") return null;
  return readRawMutationSource(env, path, content, maxBytes);
}
async function readRawMutationSource(
  env: Env,
  path: string,
  content = false,
  maxBytes = MAX_SOURCE,
) {
  if (isPCloud(env)) {
    const source = pcloudSource(env);
    try {
      const current = await source.readCurrent(path, maxBytes);
      if (!current) return null;
      const { entry, bytes } = current;
      return {
        version: entry.revision,
        digest: entry.revision,
        object: null,
        bytes,
        content: content
          ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              bytes,
            )
          : undefined,
      };
    } catch (error) {
      if (error instanceof core.SourceError)
        fail(
          error.code,
          error.code === "SOURCE_TOO_LARGE"
            ? 413
            : error.code === "SOURCE_REVISION_MISMATCH"
              ? 409
              : 503,
        );
      throw error;
    }
  }
  const object = await env.SOURCE!.get(`${env.VAULT_ID}/source/${path}`);
  if (!object) return null;
  if (object.customMetadata?.deleted === "true") {
    await object.body.cancel();
    return null;
  }
  if (object.size > maxBytes) {
    await object.body.cancel();
    fail("SOURCE_TOO_LARGE", 413);
  }
  const bytes = await boundedBytes(object.body, Math.min(maxBytes, MAX_SOURCE));
  if (bytes.length !== object.size) fail("SOURCE_REVISION_MISMATCH");
  const digest = await core.contentRevision(bytes);
  const version = await r2SourceVersion(
    env.VAULT_ID,
    path,
    object.version,
    digest,
  );
  let decoded: string | undefined;
  if (content) {
    try {
      decoded = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      fail("INVALID_UTF8", 400);
    }
  }
  return {
    version,
    digest,
    object,
    bytes,
    content: decoded,
  };
}

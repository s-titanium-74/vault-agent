import { PCLOUD_MAX_NOTE_BYTES } from "./pcloud.js";
import {
  sourcePolicy,
  canonicalSourcePath,
  SourceError,
} from "./source-policy.js";
import { contentRevision, noteIdFromPath } from "./identifiers.js";
import { uploadKind } from "./ingestion.js";
import { MAX_MARKDOWN_SIZE_FOR_INDEXING } from "../schemas.js";
import {
  MutationError,
  mutationBatchSchema,
  mutationSettingsSchema,
  type MutationOperation,
  type MutationSettings,
  type MutationErrorCode,
} from "./mutation-schemas.js";
import {
  checkMutationSize,
  mutationTextBytes,
  decodeMutationBase64,
  prepareMutationText,
  MUTATION_REGEX_WORK_BUDGET,
} from "./mutation-text.js";

export interface MutationSnapshot {
  /** Opaque source-bound content AND identity/generation version. Never mtime/size alone. */
  version: string;
  /** Required only for patch/explicit note preview; BOM and line endings preserved. */
  content?: string;
}
export interface MutationPreparationContext {
  vaultId: string;
  sourceId: string;
  sourceKind: "filesystem" | "r2" | "pcloud";
  /** Change when source identity, scope, attachment or adapter policy changes. */
  policyRevision: string;
  includes: readonly string[];
  excludes?: readonly string[];
  settings?: Partial<MutationSettings>;
  /** Filesystem spelling aliases (e.g. NFC/case folding); must be stable. */
  collisionKey?: (canonicalPath: string) => string;
  /** Additional runtime attachment restrictions, within the existing read scope. */
  attachmentAllowed?: (canonicalPath: string) => boolean;
  /** Coherent current regular-file version/content; byte bounds and safe-parent checks are mandatory. */
  snapshot: (
    path: string,
    options: { readContent: boolean; maxBytes: number },
  ) => Promise<MutationSnapshot | null>;
}
export interface PreparedMutationItem {
  index: number;
  path: string;
  type: MutationOperation["type"];
  status: "prepared" | "failed";
  code?: MutationErrorCode;
  note_id?: string;
  expected_version?: string;
  bytes?: Uint8Array;
  size?: number;
  oversized_for_index?: boolean;
  action?: "create" | "replace" | "delete";
  /** Private ephemeral preview input. Never persist in audit or serialize as status. */
  before?: string;
}
export interface PreparedMutationBatch {
  request_digest: string;
  total_bytes: number;
  items: PreparedMutationItem[];
}

/** Reject aliases unsafe across supported platforms instead of interpreting them. */
function mutationPath(path: string): string {
  try {
    canonicalSourcePath(path);
  } catch {
    throw new MutationError("INVALID_PATH");
  }
  if (
    path
      .split("/")
      .some(
        (part) =>
          /[<>:"|?*]/.test(part) ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new MutationError("INVALID_PATH");
  return path;
}
function isNote(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** No write capability is involved: callers must complete ALL preflight before any save. */
export async function prepareMutationBatch(
  context: MutationPreparationContext,
  input: unknown,
  options: { preview?: boolean } = {},
): Promise<PreparedMutationBatch> {
  const parsedSettings = mutationSettingsSchema.safeParse(
    context.settings ?? {},
  );
  if (!parsedSettings.success) throw new MutationError("INVALID_REQUEST");
  const settings = parsedSettings.data;
  const fileLimit = (attachment: boolean) =>
    context.sourceKind === "pcloud" && !attachment
      ? Math.min(settings.max_file_bytes, PCLOUD_MAX_NOTE_BYTES)
      : settings.max_file_bytes;
  if (!settings.enabled) throw new MutationError("WRITE_DISABLED");
  const parsed = mutationBatchSchema.safeParse(input);
  if (!parsed.success) throw new MutationError("INVALID_REQUEST");
  const batch = parsed.data;
  checkMutationSize(batch.operations.length, settings.max_batch_operations);
  const allowed = sourcePolicy(context.includes, context.excludes);
  const keys = new Set<string>();
  const paths: string[] = [];
  const payloads = new Map<number, Uint8Array>();
  let inputBytes = 0,
    patchBytes = 0;
  // Validate the complete envelope/payload before performing any snapshot I/O.
  for (const [index, op] of batch.operations.entries()) {
    const path = mutationPath(op.path);
    const key = context.collisionKey?.(path) ?? path;
    if (keys.has(key)) throw new MutationError("DUPLICATE_PATH");
    keys.add(key);
    paths.push(key);
    const limit = fileLimit(op.type === "upload_attachment");
    let bytes: Uint8Array | undefined;
    if (op.type === "create_note" || op.type === "replace_note") {
      checkMutationSize(op.content.length, limit);
      bytes = mutationTextBytes(op.content);
    } else if (op.type === "upload_attachment") {
      bytes = decodeMutationBase64(op.content_base64, limit);
    } else if (op.type === "patch_note") {
      for (const replacement of op.replacements) {
        patchBytes += mutationTextBytes(replacement.pattern).length;
        patchBytes += mutationTextBytes(replacement.replacement).length;
        checkMutationSize(patchBytes, 1024 * 1024);
      }
    }
    if (bytes) {
      checkMutationSize(bytes.length, limit);
      inputBytes += bytes.length;
      payloads.set(index, bytes);
    }
    checkMutationSize(inputBytes, settings.max_batch_bytes);
  }
  // A batch cannot both publish a file and a descendant of that file.
  for (const key of paths) {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i++)
      if (keys.has(parts.slice(0, i).join("/")))
        throw new MutationError("DUPLICATE_PATH");
  }

  const budget = { remaining: MUTATION_REGEX_WORK_BUDGET };
  const items: PreparedMutationItem[] = [];
  let totalBytes = inputBytes;
  for (const [index, op] of batch.operations.entries()) {
    const item: PreparedMutationItem = {
      index,
      path: op.path,
      type: op.type,
      status: "failed",
    };
    try {
      if (!allowed(op.path)) throw new MutationError("SOURCE_EXCLUDED");
      if (context.sourceKind === "pcloud" && uploadKind(op.path) === "guidance")
        throw new MutationError("SOURCE_WRITE_UNSUPPORTED");
      if (op.path.split("/").some((part) => part.startsWith(".")))
        throw new MutationError("SOURCE_EXCLUDED");
      const note = isNote(op.path);
      const attachment =
        !note &&
        (context.sourceKind === "filesystem" ||
          uploadKind(op.path) === "attachment") &&
        (context.attachmentAllowed?.(op.path) ?? true);
      if (
        op.type === "upload_attachment"
          ? !attachment
          : op.type === "delete_file"
            ? !note && !attachment
            : !note
      )
        throw new MutationError("SOURCE_EXCLUDED");
      if (note) item.note_id = await noteIdFromPath(op.path);
      const creation =
        op.type === "create_note" ||
        (op.type === "upload_attachment" && !op.replace);
      const readContent =
        op.type === "patch_note" ||
        (!!options.preview && note && op.type !== "delete_file" && !creation);
      const limit = fileLimit(attachment);
      const current = await context.snapshot(op.path, {
        readContent,
        maxBytes: limit,
      });
      if (creation && current) throw new MutationError("FILE_ALREADY_EXISTS");
      if (!creation && !current) throw new MutationError("SOURCE_NOT_FOUND");
      const expected =
        "expected_version" in op ? op.expected_version : undefined;
      if (!creation && current?.version !== expected)
        throw new MutationError("SOURCE_REVISION_MISMATCH");
      if (readContent && current?.content === undefined)
        throw new MutationError("SOURCE_UNAVAILABLE");
      if (current?.content !== undefined) {
        checkMutationSize(mutationTextBytes(current.content).length, limit);
      }
      let bytes = payloads.get(index);
      if (op.type === "patch_note") {
        bytes = mutationTextBytes(
          prepareMutationText(
            current!.content!,
            op.replacements,
            limit,
            budget,
          ),
        );
        totalBytes += bytes.length;
        checkMutationSize(totalBytes, settings.max_batch_bytes);
      }
      Object.assign(item, {
        status: "prepared",
        action:
          op.type === "delete_file"
            ? "delete"
            : creation
              ? "create"
              : "replace",
        ...(expected ? { expected_version: expected } : {}),
        ...(bytes ? { bytes, size: bytes.length } : {}),
        ...(note && bytes
          ? {
              oversized_for_index:
                bytes.length > MAX_MARKDOWN_SIZE_FOR_INDEXING,
            }
          : {}),
        ...(options.preview && note && op.type !== "delete_file"
          ? { before: current?.content ?? "" }
          : {}),
      });
    } catch (error) {
      // Never downgrade envelope size failures to per-item failures.
      if (
        error instanceof MutationError &&
        error.code === "SIZE_LIMIT_EXCEEDED"
      )
        throw error;
      if (error instanceof SourceError && error.code === "SOURCE_TOO_LARGE")
        throw new MutationError("SIZE_LIMIT_EXCEEDED");
      item.code =
        error instanceof MutationError
          ? error.code
          : error instanceof SourceError &&
              (error.code === "SOURCE_EXCLUDED" ||
                error.code === "SOURCE_NOT_FOUND" ||
                error.code === "SOURCE_REVISION_MISMATCH" ||
                error.code === "INVALID_PATH")
            ? error.code
            : "SOURCE_UNAVAILABLE";
    }
    items.push(item);
  }
  // Fixed-order schema output makes omitted defaults and explicit defaults equivalent.
  const request_digest = await mutationRequestDigest(context, batch);
  return { request_digest, total_bytes: totalBytes, items };
}

/** Canonical binding material without reading source bodies (also used for replay). */
export async function mutationRequestDigest(
  context: MutationPreparationContext,
  input: unknown,
): Promise<string> {
  const settings = mutationSettingsSchema.safeParse(context.settings ?? {});
  const batch = mutationBatchSchema.safeParse(input);
  if (!settings.success || !batch.success)
    throw new MutationError("INVALID_REQUEST");
  return contentRevision(
    JSON.stringify({
      vault: context.vaultId,
      source: context.sourceId,
      kind: context.sourceKind,
      policy: context.policyRevision,
      includes: context.includes,
      excludes: context.excludes ?? [],
      settings: settings.data,
      operations: batch.data.operations,
    }),
  );
}

/** Content-free metadata suitable for explicit summaries. Not an applied-operation receipt. */
export function mutationBatchSummary(batch: PreparedMutationBatch) {
  return {
    total_bytes: batch.total_bytes,
    results: batch.items.map((item) => ({
      index: item.index,
      path: item.path,
      type: item.type,
      status: item.status,
      ...(item.code ? { code: item.code } : {}),
      ...(item.note_id ? { note_id: item.note_id } : {}),
      ...(item.expected_version
        ? { expected_version: item.expected_version }
        : {}),
      ...(item.size !== undefined ? { size: item.size } : {}),
      ...(item.action ? { action: item.action } : {}),
      ...(item.oversized_for_index !== undefined
        ? { oversized_for_index: item.oversized_for_index }
        : {}),
    })),
  };
}

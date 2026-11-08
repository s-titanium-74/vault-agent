import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  LocalMutationService,
  LocalMutationError,
} from "@vault-agent/core/local";
import {
  type Config,
  type FreshnessMachine,
  DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT,
} from "@vault-agent/core";
import {
  previewChangesSchema,
  applyChangesSchema,
  changeStatusSchema,
} from "@vault-agent/core/portable";

export {
  MUTATION_NAMES,
  MCP_WRITE_REQUEST_BYTES,
  mutationTools,
} from "./mutation-tool-definitions.js";

const safeCodes = new Set([
  "WRITE_DISABLED",
  "ADMIN_REQUIRED",
  "READWRITE_REQUIRED",
  "INVALID_REQUEST",
  "INVALID_PATH",
  "SOURCE_EXCLUDED",
  "SOURCE_NOT_FOUND",
  "SOURCE_UNAVAILABLE",
  "SOURCE_REVISION_MISMATCH",
  "SOURCE_WRITE_UNSUPPORTED",
  "FILE_ALREADY_EXISTS",
  "INVALID_BASE64",
  "INVALID_UTF8",
  "DUPLICATE_PATH",
  "SIZE_LIMIT_EXCEEDED",
  "MATCH_COUNT_MISMATCH",
  "INVALID_PATTERN",
  "REGEX_BUDGET_EXCEEDED",
  "PREVIEW_CHANGED",
  "PREVIEW_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "OPERATION_UNKNOWN",
  "OPERATION_INVALID",
  "OPERATION_EXPIRED",
  "MUTATION_BUSY",
  "OUTCOME_UNKNOWN",
  "REVISION_CHANGED",
  "NOTE_TOO_LARGE",
  "ATTACHMENT_TOO_LARGE",
]);
export function mutationMcpError(error: unknown): McpError {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "SOURCE_UNAVAILABLE";
  return new McpError(
    -32040,
    code === "REVISION_CHANGED"
      ? "Source changed. Retrieve the latest note or search again."
      : "Vault change/read failed.",
    {
      errorCode: safeCodes.has(code) ? code : "SOURCE_UNAVAILABLE",
    },
  );
}

export class LocalMutationRuntime {
  readonly service: LocalMutationService;
  private timer?: ReturnType<typeof setTimeout>;
  private interval?: ReturnType<typeof setInterval>;
  private running?: Promise<unknown>;
  private closing = false;
  constructor(
    config: Config,
    private readonly freshness: FreshnessMachine | null = null,
  ) {
    if (config.write.max_batch_bytes > 20 * 1024 * 1024)
      throw new Error(
        "CONFIG_INVALID: Local write batch limit exceeds 20 MiB.",
      );
    this.service = new LocalMutationService(config, { settings: config.write });
    try {
      if (!config.vault.pcloud) this.service.recover();
      this.service.cleanup();
    } catch {
      this.service.close();
      throw new Error("SOURCE_UNAVAILABLE: Mutation recovery failed.");
    }
    this.interval = setInterval(() => this.schedule(), 5000);
    this.interval.unref();
    this.schedule();
  }
  schedule() {
    if (this.closing || this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.flush().catch(() => {});
    }, 0);
    this.timer.unref();
  }
  markPending() {
    const count = this.service.pendingCount();
    const known = this.freshness?.info.pendingChangeCount ?? 0;
    if (count > known) this.freshness?.changesDetected(count - known);
  }
  flush(): Promise<unknown> {
    if (this.running) return this.running;
    if (this.closing) return Promise.resolve();
    this.running = Promise.resolve()
      .then(() => {
        this.service.cleanup(100);
        this.markPending();
        if (this.service.pendingCount()) this.freshness?.writerStarted();
        return this.service.flushIndex();
      })
      .then((result) => {
        if (this.service.pendingCount()) {
          this.markPending();
          this.freshness?.writerFailed("INDEX_PENDING");
        } else if (result.processed)
          this.freshness?.transition("fresh", "Mutation index committed");
        return result;
      })
      .catch((error) => {
        this.markPending();
        this.freshness?.writerFailed("INDEX_UPDATE_FAILED");
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  async call(name: string, args: Record<string, unknown>) {
    try {
      if (name === "preview_changes") {
        const request = previewChangesSchema.safeParse(args);
        if (!request.success) throw new LocalMutationError("INVALID_REQUEST");
        return await this.service.allocate(
          { operations: request.data.operations },
          { preview: request.data.preview },
        );
      }
      if (name === "apply_changes") {
        const request = applyChangesSchema.safeParse(args);
        if (!request.success) throw new LocalMutationError("INVALID_REQUEST");
        const result = await this.service.apply(
          request.data.operation_id,
          { operations: request.data.operations },
          request.data.preview_binding,
        );
        this.markPending();
        this.schedule();
        return result;
      }
      const request = changeStatusSchema.safeParse(args);
      if (!request.success) throw new LocalMutationError("INVALID_REQUEST");
      return this.service.getStatus(request.data.operation_id);
    } catch (error) {
      throw mutationMcpError(error);
    }
  }
  async getNote(id: string, allowLarge = false) {
    const note = await this.service.getNote(id);
    if (note && !allowLarge && note.size > DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT)
      throw new LocalMutationError("NOTE_TOO_LARGE");
    return note;
  }
  async close() {
    if (this.closing) {
      await this.running?.catch(() => {});
      return;
    }
    this.closing = true;
    clearTimeout(this.timer);
    clearInterval(this.interval);
    await this.running?.catch(() => {});
    this.service.close();
  }
}

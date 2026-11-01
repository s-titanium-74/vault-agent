import {
  canonicalSourcePath,
  contentRevision,
  type VaultSource,
  type SourceEntry,
  type SourceReadOptions,
  type PageRequest,
} from "@vault-agent/core/portable";
import { CloudError, boundedBytes } from "./errors.js";

export class R2VaultSource implements VaultSource {
  constructor(
    readonly db: D1Database,
    readonly bucket: R2Bucket,
    readonly vaultId: string,
    readonly revision: string,
    readonly allowed: (path: string) => boolean,
    readonly located = false,
  ) {}
  key(path: string) {
    return `${this.vaultId}/${this.revision}/${canonicalSourcePath(path)}`;
  }
  check(path: string) {
    canonicalSourcePath(path);
    if (!this.allowed(path)) throw new CloudError("SOURCE_EXCLUDED", 403);
  }
  async list(request: PageRequest) {
    request.signal?.throwIfAborted();
    if (
      !Number.isInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > 500
    )
      throw new CloudError("INVALID_CURSOR");
    const rows = await this.db
      .prepare(
        "SELECT path,kind,size,digest AS revision,updated FROM sources WHERE revision=? AND path>? ORDER BY path LIMIT ?",
      )
      .bind(this.revision, request.cursor ?? "", request.limit + 1)
      .all<SourceEntry>();
    const entries = rows.results.slice(0, request.limit);
    for (const e of entries) this.check(e.path);
    return {
      items: entries,
      cursor:
        rows.results.length > request.limit ? entries.at(-1)?.path : undefined,
    };
  }
  async stat(path: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    this.check(path);
    return this.db
      .prepare(
        "SELECT path,kind,size,digest AS revision,updated FROM sources WHERE revision=? AND path=?",
      )
      .bind(this.revision, path)
      .first<SourceEntry>();
  }
  async verified(path: string, options: SourceReadOptions) {
    this.check(path);
    options.signal?.throwIfAborted();
    const entry = await this.stat(path, options.signal);
    if (!entry) throw new CloudError("SOURCE_NOT_FOUND", 404);
    if (entry.revision !== options.expectedRevision)
      throw new CloudError("SOURCE_REVISION_MISMATCH", 409);
    const max = Math.min(
      options.maxBytes,
      entry.kind === "attachment" ? 20 * 1024 * 1024 : 2 * 1024 * 1024,
    );
    if (entry.size > max) throw new CloudError("SOURCE_TOO_LARGE", 413);
    const locator = this.located
      ? await this.db
          .prepare(
            "SELECT object_key FROM source_objects WHERE revision=? AND path=?",
          )
          .bind(this.revision, path)
          .first<{ object_key: string }>()
      : null;
    const key = locator?.object_key ?? this.key(path);
    if (!key.startsWith(`${this.vaultId}/${this.revision}/`))
      throw new CloudError("SOURCE_REVISION_MISMATCH", 409);
    const obj = await this.bucket.get(key);
    if (!obj) throw new CloudError("SOURCE_NOT_FOUND", 404);
    if (obj.size !== entry.size || obj.size > max) {
      await obj.body.cancel();
      throw new CloudError("SOURCE_REVISION_MISMATCH", 409);
    }
    const bytes = await boundedBytes(obj.body, max, options.signal);
    if (
      bytes.length !== entry.size ||
      (await contentRevision(bytes)) !== entry.revision
    )
      throw new CloudError("SOURCE_REVISION_MISMATCH", 409);
    return bytes;
  }
  async readBytes(path: string, options: SourceReadOptions) {
    const bytes = await this.verified(path, options);
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    });
  }
  async readText(path: string, options: SourceReadOptions) {
    const bytes = await this.verified(path, options);
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new CloudError("SOURCE_NOT_UTF8", 409);
    }
  }
}

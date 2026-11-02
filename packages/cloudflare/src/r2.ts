import { PublishedSourceCatalog } from "./source-catalog.js";
import {
  canonicalSourcePath,
  contentRevision,
  type VaultSource,
  type SourceReadOptions,
} from "@vault-agent/core/portable";
import { CloudError, boundedBytes } from "./errors.js";
import { cloudSourceLimit } from "./source-limits.js";

export class R2VaultSource
  extends PublishedSourceCatalog
  implements VaultSource
{
  constructor(
    db: D1Database,
    readonly bucket: R2Bucket,
    vaultId: string,
    revision: string,
    allowed: (path: string) => boolean,
    readonly located = false,
  ) {
    super(db, vaultId, revision, allowed);
  }
  key(path: string) {
    return `${this.vaultId}/${this.revision}/${canonicalSourcePath(path)}`;
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
      await cloudSourceLimit(this.db, path, entry.kind, entry.size),
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

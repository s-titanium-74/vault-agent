import {
  canonicalSourcePath,
  type SourceEntry,
  type PageRequest,
} from "@vault-agent/core/portable";
import { CloudError } from "./errors.js";
/** Published source membership and digest catalog; performs D1 I/O only. */
export class PublishedSourceCatalog {
  constructor(
    readonly db: D1Database,
    readonly vaultId: string,
    readonly revision: string,
    readonly allowed: (path: string) => boolean,
  ) {}
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
}

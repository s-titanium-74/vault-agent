import {
  PCloudSource,
  contentRevision,
  type SourceReadOptions,
  type VaultSource,
  SourceError,
} from "@vault-agent/core/portable";
import type { Env } from "./config.js";
import { PublishedSourceCatalog } from "./source-catalog.js";
import { CloudError } from "./errors.js";

export const isPCloud = (env: Env) => env.SOURCE_PROVIDER === "pcloud";
export function pcloudSource(env: Env, writesEnabled = false) {
  if (
    !isPCloud(env) ||
    !env.PCLOUD_REGION ||
    !env.PCLOUD_FOLDER_ID ||
    !env.PCLOUD_ACCESS_TOKEN
  )
    throw new CloudError("CONFIG_INVALID", 503);
  return new PCloudSource({
    vaultId: env.VAULT_ID,
    writesEnabled,
    region: env.PCLOUD_REGION,
    folderId: env.PCLOUD_FOLDER_ID,
    accessToken: env.PCLOUD_ACCESS_TOKEN,
    includes: JSON.parse(env.INCLUDE_PATHS),
    excludes: JSON.parse(env.EXCLUDE_PATHS),
  });
}
export async function pcloudEntries(env: Env) {
  const observed = await pcloudSource(env).observe();
  return observed.map((e) => ({
    path: e.path,
    kind: e.kind,
    size: e.size,
    updated: e.updated,
    etag: e.version,
    object_version: e.version,
    digest: null,
    processed: 0,
  }));
}
export async function readPCloudEntry(
  env: Env,
  entry: {
    path: string;
    size: number;
    updated: string;
    etag: string | null;
    digest?: string | null;
  },
) {
  if (!entry.etag) throw new CloudError("REVISION_CONFLICT", 409);
  try {
    const result = await pcloudSource(env).readObserved({
      path: entry.path,
      kind: "note",
      size: entry.size,
      updated: entry.updated,
      version: entry.etag,
    });
    if (entry.digest && (await contentRevision(result.bytes)) !== entry.digest)
      throw new SourceError("SOURCE_REVISION_MISMATCH");
    return result.bytes;
  } catch (error) {
    if (error instanceof SourceError)
      throw new CloudError(
        error.code,
        error.code === "SOURCE_REVISION_MISMATCH" ? 409 : 503,
      );
    throw new CloudError("SOURCE_UNAVAILABLE", 503);
  }
}
/** Snapshot membership comes from D1; only an explicit body read contacts pCloud. */
export class PCloudSnapshotSource
  extends PublishedSourceCatalog
  implements VaultSource
{
  constructor(
    private readonly env: Env,
    store: string,
    allowed: (path: string) => boolean,
  ) {
    super(env.DB, env.VAULT_ID, store, allowed);
  }
  async readBytes(path: string, options: SourceReadOptions) {
    const entry = await this.stat(path, options.signal);
    if (!entry) throw new SourceError("SOURCE_NOT_FOUND");
    if (entry.revision !== options.expectedRevision)
      throw new SourceError("SOURCE_REVISION_MISMATCH");
    return pcloudSource(this.env).readBytes(path, options);
  }
  async readText(path: string, options: SourceReadOptions) {
    const entry = await this.stat(path, options.signal);
    if (!entry) throw new SourceError("SOURCE_NOT_FOUND");
    if (entry.revision !== options.expectedRevision)
      throw new SourceError("SOURCE_REVISION_MISMATCH");
    return pcloudSource(this.env).readText(path, options);
  }
}

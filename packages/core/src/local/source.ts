import path from "node:path";
import type { Config } from "../config.js";
import { vaultIdentity } from "../identifiers.js";
import { PCloudSource } from "../portable/pcloud.js";

export function configuredVaultIdentity(config: Config): string {
  const p = config.vault.pcloud;
  return vaultIdentity(
    p
      ? `pcloud:${p.region}:${p.folder_id}:${JSON.stringify([p.includes, config.vault.exclude])}`
      : path.resolve(config.vault.root),
  );
}
export function pcloudSource(
  config: Config,
  writesEnabled = false,
): PCloudSource {
  const p = config.vault.pcloud;
  if (!p) throw new Error("pCloud source is not configured.");
  return new PCloudSource({
    vaultId: configuredVaultIdentity(config),
    writesEnabled,
    maxNotes: 1_000_000,
    region: p.region,
    folderId: p.folder_id,
    accessToken: p.access_token,
    includes: p.includes,
    excludes: config.vault.exclude,
  });
}

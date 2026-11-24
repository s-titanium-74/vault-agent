import { vaultIdentity } from "./identifiers.js";
import { configuredVaultIdentity } from "./local/source.js";
import { updateLocalIndex } from "./local/index-updates.js";
import { IndexStore, getIndexPath } from "./index-store.js";
import { validateVaultPath } from "./pathsafety.js";
import { Config } from "./config.js";
import { IndexResult } from "./types.js";
import { acquireIndexLock } from "./local/index-lock.js";
import fs from "node:fs";
import path from "node:path";

export interface IndexOptions {
  requireEmbeddings?: boolean;
}

export async function indexVault(
  config: Config,
  options?: IndexOptions,
): Promise<IndexResult> {
  const dbPath = getIndexPath(config);
  const releaseLock = acquireIndexLock(path.dirname(dbPath));
  try {
    const vaultRoot = config.vault.pcloud
      ? ""
      : validateVaultPath(config.vault.root);
    const store = await IndexStore.open(dbPath);

    try {
      const vid = config.vault.pcloud
        ? configuredVaultIdentity(config)
        : vaultIdentity(vaultRoot);

      return await updateLocalIndex(store, config, {
        vaultIdentity: vid,
        requireEmbeddings: options?.requireEmbeddings,
      });
    } finally {
      store.close();
    }
  } finally {
    releaseLock();
  }
}

export async function reindexVault(
  config: Config,
  options?: IndexOptions,
): Promise<IndexResult> {
  const dbPath = getIndexPath(config);
  const dir = path.dirname(dbPath);
  const releaseLock = acquireIndexLock(dir);
  try {
    const vaultRoot = config.vault.pcloud
      ? ""
      : validateVaultPath(config.vault.root);
    const { indexPath, tmpPath } = getReindexPaths(dbPath);

    const tmpStore = await IndexStore.open(tmpPath);

    let result: IndexResult;
    let cacheSource: IndexStore | undefined;
    // The active database also holds unpublished preparation checkpoints.
    try {
      try {
        cacheSource = await IndexStore.open(indexPath);
        cacheSource.getManifest();
      } catch {
        cacheSource?.close();
        // Reindex must still repair an unreadable or incompatible active DB.
        cacheSource = await IndexStore.open(
          path.join(dir, "embedding-cache.sqlite"),
        );
      }
      const vid = config.vault.pcloud
        ? configuredVaultIdentity(config)
        : vaultIdentity(vaultRoot);
      result = await updateLocalIndex(tmpStore, config, {
        full: true,
        vaultIdentity: vid,
        requireEmbeddings: options?.requireEmbeddings,
        cacheSource,
        publishStagedIndex: () => {
          cacheSource?.close();
          cacheSource = undefined;
          tmpStore.close();

          for (const suffix of ["-wal", "-shm"])
            if (fs.existsSync(indexPath + suffix))
              fs.unlinkSync(indexPath + suffix);
          fs.renameSync(tmpPath, indexPath);
          for (const suffix of ["-wal", "-shm"])
            if (fs.existsSync(tmpPath + suffix))
              fs.unlinkSync(tmpPath + suffix);
        },
      });
    } catch (error) {
      if (tmpStore.getDb().open) tmpStore.close();
      if (fs.existsSync(tmpPath)) {
        fs.unlinkSync(tmpPath);
      }
      if (fs.existsSync(tmpPath + "-wal")) {
        fs.unlinkSync(tmpPath + "-wal");
      }
      if (fs.existsSync(tmpPath + "-shm")) {
        fs.unlinkSync(tmpPath + "-shm");
      }
      throw error;
    } finally {
      cacheSource?.close();
    }

    return result;
  } finally {
    releaseLock();
  }
}

function getReindexPaths(dbPath: string): {
  indexPath: string;
  tmpPath: string;
} {
  return {
    indexPath: dbPath,
    tmpPath: dbPath.replace("index.sqlite", "index.tmp.sqlite"),
  };
}

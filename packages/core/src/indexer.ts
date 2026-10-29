import { updateLocalIndex } from "./local/index-updates.js";
import { IndexStore, getIndexPath } from "./index-store.js";
import { vaultIdentity } from "./identifiers.js";
import { validateVaultPath } from "./pathsafety.js";
import { Config } from "./config.js";
import { IndexResult } from "./types.js";
import { resolveIndexDir } from "./paths.js";
import { IndexError } from "./errors.js";
import fs from "node:fs";
import path from "node:path";

export interface IndexOptions {
  requireEmbeddings?: boolean;
}

export async function indexVault(
  config: Config,
  options?: IndexOptions,
): Promise<IndexResult> {
  const lockPath = getLockFilePath(config);
  acquireLock(lockPath);
  try {
    const vaultRoot = validateVaultPath(config.vault.root);
    const dbPath = getIndexPath(config);
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const store = await IndexStore.open(dbPath);

    try {
      const vid = vaultIdentity(vaultRoot);

      return await performIndex(
        store,
        config,
        vaultRoot,
        vid,
        false,
        options?.requireEmbeddings,
      );
    } finally {
      store.close();
    }
  } finally {
    releaseLock(lockPath);
  }
}

export async function reindexVault(
  config: Config,
  options?: IndexOptions,
): Promise<IndexResult> {
  const lockPath = getLockFilePath(config);
  acquireLock(lockPath);
  try {
    const vaultRoot = validateVaultPath(config.vault.root);
    const dbPath = getIndexPath(config);
    const { indexPath, tmpPath } = getReindexPaths(dbPath);

    const dir = path.dirname(indexPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const tmpStore = await IndexStore.open(tmpPath);

    let result: IndexResult;
    let cacheSource: IndexStore | undefined;
    try {
      if (fs.existsSync(indexPath)) {
        cacheSource = await IndexStore.openReadOnly(indexPath);
        cacheSource.getManifest();
      }
    } catch {
      cacheSource?.close();
      cacheSource = undefined;
    }

    try {
      const vid = vaultIdentity(vaultRoot);
      result = await performIndex(
        tmpStore,
        config,
        vaultRoot,
        vid,
        true,
        options?.requireEmbeddings,
        cacheSource,
      );
    } catch (error) {
      tmpStore.close();
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

    tmpStore.close();

    if (fs.existsSync(indexPath + "-wal")) {
      fs.unlinkSync(indexPath + "-wal");
    }
    if (fs.existsSync(indexPath + "-shm")) {
      fs.unlinkSync(indexPath + "-shm");
    }

    fs.renameSync(tmpPath, indexPath);

    if (fs.existsSync(tmpPath + "-wal")) {
      fs.unlinkSync(tmpPath + "-wal");
    }
    if (fs.existsSync(tmpPath + "-shm")) {
      fs.unlinkSync(tmpPath + "-shm");
    }

    return result;
  } finally {
    releaseLock(lockPath);
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

async function performIndex(
  store: IndexStore,
  config: Config,
  _vaultRoot: string,
  vid: string,
  isFull: boolean,
  requireEmbeddingsOverride?: boolean,
  cacheSource?: IndexStore,
): Promise<IndexResult> {
  return updateLocalIndex(store, config, {
    full: isFull,
    vaultIdentity: vid,
    requireEmbeddings: requireEmbeddingsOverride,
    cacheSource,
  });
}

function getLockFilePath(config: Config): string {
  const vaultRoot = config.vault.root;
  const resolvedVault = path.resolve(vaultRoot);
  const vid = vaultIdentity(resolvedVault);
  const indexDir = resolveIndexDir(config.index.dir || undefined);
  return path.join(indexDir, vid, "index.lock");
}

function acquireLock(lockPath: string): void {
  if (fs.existsSync(lockPath)) {
    try {
      const content = fs.readFileSync(lockPath, "utf-8");
      const data = JSON.parse(content) as { pid: number; timestamp: number };
      if (isProcessRunning(data.pid)) {
        throw new IndexError(
          "INDEX_BUSY",
          `Index is already being built by process ${data.pid}`,
          { pid: data.pid },
        );
      }
    } catch (e) {
      if (e instanceof IndexError) throw e;
    }
    fs.unlinkSync(lockPath);
  }

  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, timestamp: Date.now() }),
  );
}

function releaseLock(lockPath: string): void {
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {}
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

import { updateLocalIndex } from "./local/index-updates.js";
import { Config } from "./config.js";
import { IndexStore } from "./index-store.js";
import { IndexResult, IndexWarning } from "./types.js";
import { IndexError } from "./errors.js";
import {
  PathSafetyError,
  resolveVaultRelativePath,
  toVaultRelative,
} from "./pathsafety.js";
import path from "node:path";

export interface IncrementalIndexOptions {
  paths: string[];
  requireEmbeddings?: boolean;
}

export interface IncrementalIndexUpdate {
  added: string[];
  modified: string[];
  deleted: string[];
  degraded: string[];
}

export async function incrementalIndexUpdate(
  store: IndexStore,
  config: Config,
  options: IncrementalIndexOptions,
): Promise<IndexResult> {
  const { paths } = options;
  if (paths.length === 0) {
    return {
      mode: "incremental",
      notesIndexed: 0,
      chunksIndexed: 0,
      notesSkipped: 0,
      warnings: [],
    };
  }

  const warnings: IndexWarning[] = [];

  const staleness = store.checkStaleness(config);
  if (staleness.incompatible) {
    const reasons = staleness.details;
    let code = "INDEX_INCOMPATIBLE";
    if (reasons.includes("Schema version")) {
      code = "INDEX_SCHEMA_INCOMPATIBLE";
    } else if (reasons.includes("Vault identity")) {
      code = "INDEX_VAULT_IDENTITY_CHANGED";
    } else if (reasons.includes("Exclude patterns")) {
      code = "INDEX_EXCLUDES_CHANGED";
    } else if (
      reasons.includes("chunk size") ||
      reasons.includes("Max chunk size")
    ) {
      code = "INDEX_CHUNKING_CHANGED";
    } else if (reasons.includes("Embedding model")) {
      code = "INDEX_EMBEDDINGS_STALE";
    } else if (reasons.includes("Embedding dimension")) {
      code = "INDEX_EMBEDDING_DIMENSION_MISMATCH";
    }
    throw new IndexError(
      code,
      `${reasons}. Run vault-agent reindex to rebuild the index.`,
    );
  }
  if (staleness.stale) {
    warnings.push({
      code: "INDEX_STALE",
      message: `Index is stale: ${staleness.details}. Incremental updates may be out of sync.`,
    });
  }

  const vaultRoot = path.resolve(config.vault.root);
  const result = await updateLocalIndex(store, config, {
    paths: paths.map((p) => normalizeIncrementalPath(vaultRoot, p)),
    vaultIdentity: store.getManifest()!.vaultIdentity,
    requireEmbeddings: options.requireEmbeddings,
  });
  return {
    ...result,
    warnings: [...warnings, ...result.warnings].slice(0, 100),
  };
}

function normalizeIncrementalPath(
  vaultRoot: string,
  inputPath: string,
): string {
  try {
    const absolutePath = resolveVaultRelativePath(vaultRoot, inputPath);
    return toVaultRelative(absolutePath, vaultRoot);
  } catch (err) {
    if (err instanceof PathSafetyError) {
      throw new IndexError(
        "INDEX_UPDATE_FAILED",
        "Changed path resolves outside the vault root.",
      );
    }
    throw err;
  }
}

import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";
import { INDEXED_EXTENSIONS, DEFAULT_EXCLUDE_PATTERNS } from "./schemas.js";
import { toVaultRelative } from "./pathsafety.js";

export interface DiscoveryResult {
  files: DiscoveredFile[];
  skippedHidden: number;
  skippedExcluded: number;
}

export interface DiscoveredFile {
  vaultRelativePath: string;
  absolutePath: string;
  size: number;
  mtimeMs: number;
}

export class VaultDiscovery {
  private vaultRoot: string;
  private excludePatterns: string[];
  private ig: ReturnType<typeof ignore>;

  constructor(vaultRoot: string, userExcludePatterns: string[] = []) {
    this.vaultRoot = vaultRoot;
    this.excludePatterns = [
      ...DEFAULT_EXCLUDE_PATTERNS,
      ...userExcludePatterns,
    ];
    this.ig = ignore().add(this.excludePatterns);
  }

  discover(): DiscoveryResult {
    const files: DiscoveredFile[] = [];
    let skippedHidden = 0;
    let skippedExcluded = 0;

    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relativePath = toVaultRelative(fullPath, this.vaultRoot);

        if (this.isHidden(entry.name)) {
          skippedHidden++;
          continue;
        }

        if (this.ig.ignores(relativePath)) {
          skippedExcluded++;
          continue;
        }

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (INDEXED_EXTENSIONS.includes(ext)) {
            try {
              const stat = fs.statSync(fullPath);
              files.push({
                vaultRelativePath: relativePath,
                absolutePath: fullPath,
                size: stat.size,
                mtimeMs: stat.mtimeMs,
              });
            } catch {
              continue;
            }
          }
        }
      }
    };

    walk(this.vaultRoot);
    return { files, skippedHidden, skippedExcluded };
  }

  isHidden(filename: string): boolean {
    return filename.startsWith(".");
  }

  isAttachmentPath(vaultRelativePath: string): boolean {
    const ext = path.extname(vaultRelativePath).toLowerCase();
    return !INDEXED_EXTENSIONS.includes(ext);
  }

  isIndexPathInsideVault(vaultRelativePath: string): boolean {
    return !this.ig.ignores(vaultRelativePath);
  }

  static isAttachmentAllowed(
    vaultRoot: string,
    vaultRelativePath: string,
    userExcludePatterns: string[] = [],
  ): boolean {
    const ext = path.extname(vaultRelativePath).toLowerCase();
    if (ext === ".md" || ext === ".markdown") return false;

    const basename = path.basename(vaultRelativePath);
    if (basename.startsWith(".")) return false;

    const parts = vaultRelativePath.split("/");
    if (parts.some((p) => p.startsWith("."))) return false;

    const ig = ignore().add([
      ...DEFAULT_EXCLUDE_PATTERNS,
      ...userExcludePatterns,
    ]);
    if (ig.ignores(vaultRelativePath)) return false;

    return true;
  }
}

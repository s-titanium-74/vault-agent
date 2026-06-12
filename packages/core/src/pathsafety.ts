import fs from "node:fs";
import path from "node:path";

export class PathSafetyError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "PathSafetyError";
  }
}

export function validateVaultPath(vaultRoot: string): string {
  const resolved = path.resolve(vaultRoot);
  const realPath = fs.realpathSync(resolved);
  if (!fs.statSync(realPath).isDirectory()) {
    throw new PathSafetyError(
      "INVALID_VAULT_ROOT",
      "Vault root is not a directory",
    );
  }
  return realPath;
}

export function isPathInsideVault(
  filePath: string,
  vaultRoot: string,
): boolean {
  const resolvedVault = path.resolve(vaultRoot);
  const resolvedFile = path.resolve(filePath);
  const relative = path.relative(resolvedVault, resolvedFile);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function resolveVaultRelativePath(
  vaultRoot: string,
  vaultRelativePath: string,
): string {
  const fullPath = path.join(vaultRoot, vaultRelativePath);
  const resolved = path.resolve(fullPath);
  const resolvedVault = path.resolve(vaultRoot);

  if (
    !resolved.startsWith(resolvedVault + path.sep) &&
    resolved !== resolvedVault
  ) {
    throw new PathSafetyError(
      "PATH_OUTSIDE_VAULT",
      "Path resolves outside the vault root",
    );
  }

  let realPath: string;
  if (fs.existsSync(resolved)) {
    realPath = fs.realpathSync(resolved);
  } else {
    realPath = resolved;
  }

  const realVaultRoot = fs.realpathSync(resolvedVault);
  if (
    !realPath.startsWith(realVaultRoot + path.sep) &&
    realPath !== realVaultRoot
  ) {
    throw new PathSafetyError(
      "PATH_OUTSIDE_VAULT",
      "Path resolves outside the vault root",
    );
  }

  return resolved;
}

export function toVaultRelative(
  absolutePath: string,
  vaultRoot: string,
): string {
  const resolvedVault = path.resolve(vaultRoot);
  const resolved = path.resolve(absolutePath);
  const relative = path.relative(resolvedVault, resolved);
  return relative.split(path.sep).join("/");
}

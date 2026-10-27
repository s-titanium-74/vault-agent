import ignore from "ignore";
import { DEFAULT_EXCLUDE_PATTERNS } from "../schemas.js";

export class SourceError extends Error {
  constructor(
    public readonly code:
      | "INVALID_PATH"
      | "SOURCE_EXCLUDED"
      | "SOURCE_NOT_FOUND"
      | "SOURCE_REVISION_MISMATCH"
      | "SOURCE_TOO_LARGE"
      | "SOURCE_UNAVAILABLE"
      | "SOURCE_NOT_UTF8"
      | "INVALID_CURSOR",
    message = "Source operation failed.",
  ) {
    super(message);
    this.name = "SourceError";
  }
}
export function canonicalSourcePath(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    /[\\\u0000-\u001f\u007f]/.test(value) ||
    value.startsWith("/") ||
    /^[a-z][a-z\d+.-]*:/i.test(value) ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  ) {
    throw new SourceError(
      "INVALID_PATH",
      "A canonical vault-relative path is required.",
    );
  }
  // Reject unpaired surrogates instead of hashing a replacement character.
  if (new TextDecoder().decode(new TextEncoder().encode(value)) !== value)
    throw new SourceError("INVALID_PATH");
  return value;
}
export function guidanceKind(
  path: string,
): "agents" | "claude" | "readme" | "cursorrules" | "cursor_rule" | null {
  const names: Record<string, "agents" | "claude" | "readme" | "cursorrules"> =
    {
      "AGENTS.md": "agents",
      "CLAUDE.md": "claude",
      "README.md": "readme",
      ".cursorrules": "cursorrules",
    };
  const name = path.split("/").at(-1)!;
  return (
    (Object.hasOwn(names, name) ? names[name] : undefined) ??
    (/(^|\/)\.cursor\/rules\/[^/.][^/]*$/.test(path) ? "cursor_rule" : null)
  );
}
export function sourcePolicy(
  includes: readonly string[],
  excludes: readonly string[] = [],
) {
  const prefixes = includes.map((p) =>
    p === "." ? p : canonicalSourcePath(p),
  );
  const matcher = ignore().add([...DEFAULT_EXCLUDE_PATTERNS, ...excludes]);
  return (value: string): boolean => {
    const path = canonicalSourcePath(value);
    if (
      !prefixes.some((p) => p === "." || path === p || path.startsWith(p + "/"))
    )
      return false;
    if (matcher.ignores(path)) return false;
    const hidden = path.split("/").filter((p) => p.startsWith("."));
    if (!hidden.length) return true;
    if (
      hidden.length === 1 &&
      hidden[0] === ".cursorrules" &&
      path.endsWith(".cursorrules")
    )
      return true;
    return (
      hidden.length === 1 &&
      hidden[0] === ".cursor" &&
      guidanceKind(path) === "cursor_rule"
    );
  };
}
export function pageLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new SourceError(
      "INVALID_CURSOR",
      "Page limit must be between 1 and 500.",
    );
}

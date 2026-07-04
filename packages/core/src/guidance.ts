import fs from "node:fs";
import path from "node:path";
import ignore from "ignore";
import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT,
} from "./schemas.js";
import {
  resolveVaultRelativePath,
  toVaultRelative,
  validateVaultPath,
} from "./pathsafety.js";
import { RetrievalSizeError } from "./errors.js";

export type GuidanceKind =
  "agents" | "claude" | "readme" | "cursorrules" | "cursor_rule";

export interface AgentGuidanceCandidate {
  path: string;
  kind: GuidanceKind;
  scope: string;
  appliesTo: string;
  size: number;
  updated: string;
}

export interface AgentGuidanceListResult {
  guidance: AgentGuidanceCandidate[];
}

export interface AgentGuidanceRetrieveResult extends AgentGuidanceCandidate {
  content: string;
  contentType: string;
}

const GUIDANCE_FILENAMES: Record<string, GuidanceKind> = {
  "AGENTS.md": "agents",
  "CLAUDE.md": "claude",
  "README.md": "readme",
  ".cursorrules": "cursorrules",
};

export function listAgentGuidance(
  vaultRoot: string,
  userExcludePatterns: string[] = [],
): AgentGuidanceListResult {
  const vaultRealPath = validateVaultPath(vaultRoot);
  const ig = ignore().add([
    ...DEFAULT_EXCLUDE_PATTERNS,
    ...userExcludePatterns,
  ]);
  const guidance: AgentGuidanceCandidate[] = [];

  const walk = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const absolutePath = path.join(dir, entry.name);
      const vaultRelativePath = toVaultRelative(absolutePath, vaultRealPath);
      if (ig.ignores(vaultRelativePath)) continue;

      if (entry.isDirectory()) {
        if (entry.name.startsWith(".") && entry.name !== ".cursor") continue;
        walk(absolutePath);
        continue;
      }

      if (!entry.isFile()) continue;

      const kind =
        GUIDANCE_FILENAMES[entry.name] ??
        getCursorRuleKind(vaultRelativePath, entry.name);
      if (!kind) continue;

      const candidate = makeCandidate(absolutePath, vaultRelativePath, kind);
      if (candidate) guidance.push(candidate);
    }
  };

  walk(vaultRealPath);
  guidance.sort((a, b) => a.path.localeCompare(b.path));
  return { guidance };
}

export function getAgentGuidance(
  vaultRoot: string,
  vaultRelativePath: string,
  allowLarge = false,
  userExcludePatterns: string[] = [],
): AgentGuidanceRetrieveResult | null {
  const vaultRealPath = validateVaultPath(vaultRoot);
  const candidate = listAgentGuidance(
    vaultRealPath,
    userExcludePatterns,
  ).guidance.find((item) => item.path === vaultRelativePath);
  if (!candidate) return null;

  const resolved = resolveVaultRelativePath(vaultRealPath, candidate.path);
  const stat = fs.statSync(resolved);
  if (!allowLarge && stat.size > DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT) {
    throw new RetrievalSizeError(
      "NOTE_TOO_LARGE",
      `Guidance file exceeds size limit (${stat.size} bytes, limit ${DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT} bytes)`,
      { size: stat.size, limit: DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT },
    );
  }

  const content = fs.readFileSync(resolved, "utf-8");
  return {
    ...candidate,
    content,
    contentType: getGuidanceContentType(candidate.path),
    size: Buffer.byteLength(content, "utf-8"),
  };
}

function getCursorRuleKind(
  vaultRelativePath: string,
  fileName: string,
): GuidanceKind | null {
  if (fileName.startsWith(".")) return null;
  const parts = vaultRelativePath.split("/");
  const cursorIndex = parts.lastIndexOf(".cursor");
  if (
    cursorIndex >= 0 &&
    parts[cursorIndex + 1] === "rules" &&
    cursorIndex + 2 === parts.length - 1
  ) {
    return "cursor_rule";
  }
  return null;
}

function makeCandidate(
  absolutePath: string,
  vaultRelativePath: string,
  kind: GuidanceKind,
): AgentGuidanceCandidate | null {
  try {
    const stat = fs.statSync(absolutePath);
    const scope = getScope(vaultRelativePath, kind);
    return {
      path: vaultRelativePath,
      kind,
      scope,
      appliesTo: scope ? `${scope}/**` : "**",
      size: stat.size,
      updated: new Date(stat.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

function getScope(vaultRelativePath: string, kind: GuidanceKind): string {
  if (kind === "cursor_rule") {
    const marker = "/.cursor/rules/";
    const index = vaultRelativePath.indexOf(marker);
    return index >= 0 ? vaultRelativePath.slice(0, index) : "";
  }
  const dirname = path.posix.dirname(vaultRelativePath);
  return dirname === "." ? "" : dirname;
}

function getGuidanceContentType(vaultRelativePath: string): string {
  const ext = path.extname(vaultRelativePath).toLowerCase();
  if (ext === ".md" || ext === ".markdown" || ext === ".mdc") {
    return "text/markdown; charset=utf-8";
  }
  return "text/plain; charset=utf-8";
}

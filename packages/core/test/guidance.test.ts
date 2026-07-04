import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { getAgentGuidance, listAgentGuidance } from "../src/guidance.js";

function createGuidanceVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-guidance-"),
  );

  fs.writeFileSync(path.join(vaultDir, "AGENTS.md"), "# Root guidance\n");
  fs.writeFileSync(path.join(vaultDir, "README.md"), "# Vault readme\n");
  fs.writeFileSync(path.join(vaultDir, ".cursorrules"), "root rules\n");

  fs.mkdirSync(path.join(vaultDir, ".cursor", "rules"), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, ".cursor", "rules", "style.mdc"),
    "# Cursor rule\n",
  );

  fs.mkdirSync(path.join(vaultDir, "Projects", "App"), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, "Projects", "App", "CLAUDE.md"),
    "# Claude guidance\n",
  );

  fs.mkdirSync(path.join(vaultDir, ".hidden"), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, ".hidden", "AGENTS.md"), "hidden\n");

  return vaultDir;
}

describe("agent guidance discovery", () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = createGuidanceVault();
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it("lists compact guidance candidates without content", () => {
    const result = listAgentGuidance(vaultDir);
    expect(result.guidance.map((item) => item.path)).toEqual([
      ".cursor/rules/style.mdc",
      ".cursorrules",
      "AGENTS.md",
      "Projects/App/CLAUDE.md",
      "README.md",
    ]);
    expect(
      result.guidance.find((item) => item.path === "AGENTS.md"),
    ).toMatchObject({
      kind: "agents",
      scope: "",
      appliesTo: "**",
    });
    expect(
      result.guidance.find((item) => item.path === "Projects/App/CLAUDE.md"),
    ).toMatchObject({
      kind: "claude",
      scope: "Projects/App",
      appliesTo: "Projects/App/**",
    });
    expect(JSON.stringify(result)).not.toContain("Root guidance");
  });

  it("retrieves explicitly selected guidance content", () => {
    const result = getAgentGuidance(vaultDir, "AGENTS.md");
    expect(result).not.toBeNull();
    expect(result!.content).toBe("# Root guidance\n");
    expect(result!.contentType).toBe("text/markdown; charset=utf-8");
  });

  it("respects user exclude patterns", () => {
    const result = listAgentGuidance(vaultDir, ["Projects/"]);
    expect(result.guidance.map((item) => item.path)).not.toContain(
      "Projects/App/CLAUDE.md",
    );
  });

  it("does not retrieve non-guidance files or traversal paths", () => {
    fs.writeFileSync(path.join(vaultDir, "Notes.md"), "# Note\n");
    expect(getAgentGuidance(vaultDir, "Notes.md")).toBeNull();
    expect(getAgentGuidance(vaultDir, "../AGENTS.md")).toBeNull();
  });
});

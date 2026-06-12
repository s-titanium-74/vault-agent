import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { VaultDiscovery } from "../src/discovery.js";

describe("VaultDiscovery", () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-test-"));
    fs.mkdirSync(path.join(vaultDir, "Folder"), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, "Note1.md"), "# Note 1\n\nContent one.");
    fs.writeFileSync(path.join(vaultDir, "Folder", "Note2.md"), "# Note 2\n\nContent two.");
    fs.writeFileSync(path.join(vaultDir, "Note3.markdown"), "# Note 3\n\nContent three.");
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true });
  });

  it("discovers .md and .markdown files", () => {
    const discovery = new VaultDiscovery(vaultDir);
    const result = discovery.discover();
    expect(result.files.length).toBe(3);

    const paths = result.files.map((f) => f.vaultRelativePath).sort();
    expect(paths).toContain("Note1.md");
    expect(paths).toContain("Folder/Note2.md");
    expect(paths).toContain("Note3.markdown");
  });

  it("excludes hidden files and directories", () => {
    fs.mkdirSync(path.join(vaultDir, ".hidden"));
    fs.writeFileSync(path.join(vaultDir, ".hidden", "secret.md"), "# Secret");
    fs.writeFileSync(path.join(vaultDir, ".hidden_note.md"), "# Hidden");

    const discovery = new VaultDiscovery(vaultDir);
    const result = discovery.discover();
    const paths = result.files.map((f) => f.vaultRelativePath);
    expect(paths).not.toContain(".hidden/secret.md");
    expect(paths).not.toContain(".hidden_note.md");
  });

  it("excludes .obsidian directory", () => {
    fs.mkdirSync(path.join(vaultDir, ".obsidian"));
    fs.writeFileSync(path.join(vaultDir, ".obsidian", "app.json"), "{}");

    const discovery = new VaultDiscovery(vaultDir);
    const result = discovery.discover();
    const paths = result.files.map((f) => f.vaultRelativePath);
    expect(paths).not.toContain(".obsidian/app.json");
  });

  it("excludes .git directory", () => {
    fs.mkdirSync(path.join(vaultDir, ".git"));
    fs.writeFileSync(path.join(vaultDir, ".git", "HEAD"), "ref: HEAD");

    const discovery = new VaultDiscovery(vaultDir);
    const result = discovery.discover();
    const paths = result.files.map((f) => f.vaultRelativePath);
    expect(paths).not.toContain(".git/HEAD");
  });

  it("excludes node_modules", () => {
    fs.mkdirSync(path.join(vaultDir, "node_modules"));
    fs.writeFileSync(path.join(vaultDir, "node_modules", "pkg.md"), "# Pkg");

    const discovery = new VaultDiscovery(vaultDir);
    const result = discovery.discover();
    const paths = result.files.map((f) => f.vaultRelativePath);
    expect(paths).not.toContain("node_modules/pkg.md");
  });

  it("applies user exclude patterns", () => {
    fs.mkdirSync(path.join(vaultDir, "drafts"));
    fs.writeFileSync(path.join(vaultDir, "drafts", "draft.md"), "# Draft");

    const discovery = new VaultDiscovery(vaultDir, ["drafts/"]);
    const result = discovery.discover();
    const paths = result.files.map((f) => f.vaultRelativePath);
    expect(paths).not.toContain("drafts/draft.md");
  });

  it("includes file metadata", () => {
    const discovery = new VaultDiscovery(vaultDir);
    const result = discovery.discover();
    const note = result.files.find((f) => f.vaultRelativePath === "Note1.md");
    expect(note).toBeDefined();
    expect(note!.size).toBeGreaterThan(0);
    expect(note!.mtimeMs).toBeGreaterThan(0);
  });
});
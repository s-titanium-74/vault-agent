import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  resolveVaultRelativePath,
  PathSafetyError,
} from "../src/pathsafety.js";

describe("resolveVaultRelativePath", () => {
  let vaultDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-pathsafe-"));
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it("resolves a normal path inside vault", () => {
    fs.writeFileSync(path.join(vaultDir, "notes.md"), "# Test");
    const result = resolveVaultRelativePath(vaultDir, "notes.md");
    expect(result).toBe(path.resolve(vaultDir, "notes.md"));
  });

  it("resolves a nested path inside vault", () => {
    fs.mkdirSync(path.join(vaultDir, "folder"), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, "folder", "note.md"), "# Test");
    const result = resolveVaultRelativePath(vaultDir, "folder/note.md");
    expect(result).toBe(path.resolve(vaultDir, "folder", "note.md"));
  });

  it("rejects path traversal with ../", () => {
    expect(() => resolveVaultRelativePath(vaultDir, "../etc/passwd")).toThrow(
      PathSafetyError,
    );
  });

  it("rejects path traversal with multiple ../", () => {
    expect(() =>
      resolveVaultRelativePath(vaultDir, "../../etc/passwd"),
    ).toThrow(PathSafetyError);
  });

  it("rejects path traversal that targets parent directories", () => {
    expect(() =>
      resolveVaultRelativePath(vaultDir, "subdir/../../../etc/passwd"),
    ).toThrow(PathSafetyError);
  });

  it("rejects symlink that resolves outside vault", () => {
    const outsideDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-outside-"),
    );
    try {
      fs.writeFileSync(path.join(outsideDir, "secret.txt"), "secret");
      const linkPath = path.join(vaultDir, "evil-link");
      fs.symlinkSync(outsideDir, linkPath, "junction");

      expect(() =>
        resolveVaultRelativePath(vaultDir, "evil-link/secret.txt"),
      ).toThrow(PathSafetyError);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("allows symlink that resolves inside vault", () => {
    const targetDir = path.join(vaultDir, "target-dir");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "real-note.md"), "# Real");
    const linkDir = path.join(vaultDir, "link-to-target");
    fs.symlinkSync(targetDir, linkDir, "junction");

    const result = resolveVaultRelativePath(
      vaultDir,
      "link-to-target/real-note.md",
    );
    expect(result).toBeTruthy();
  });

  it("resolves hidden file paths (path safety does not filter hidden files)", () => {
    fs.writeFileSync(path.join(vaultDir, ".hidden"), "hidden");
    const result = resolveVaultRelativePath(vaultDir, ".hidden");
    expect(result).toBe(path.resolve(vaultDir, ".hidden"));
  });

  it("resolves path to file inside hidden directory (path safety does not filter hidden dirs)", () => {
    const hiddenDir = path.join(vaultDir, ".obsidian");
    fs.mkdirSync(hiddenDir, { recursive: true });
    fs.writeFileSync(path.join(hiddenDir, "config.json"), "{}");
    const result = resolveVaultRelativePath(vaultDir, ".obsidian/config.json");
    expect(result).toBe(path.resolve(vaultDir, ".obsidian", "config.json"));
  });

  it("resolves a path to the vault root itself", () => {
    const result = resolveVaultRelativePath(vaultDir, ".");
    expect(result).toBe(path.resolve(vaultDir));
  });
});

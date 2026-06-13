import { describe, it, expect } from "vitest";
import {
  validateVaultPath,
  isPathInsideVault,
  toVaultRelative,
} from "../src/pathsafety.js";

describe("validateVaultPath", () => {
  it("validates an existing directory", () => {
    const result = validateVaultPath("/tmp");
    expect(result).toBeTruthy();
  });

  it("throws for non-existent paths", () => {
    expect(() =>
      validateVaultPath("/nonexistent/path/that/does/not/exist"),
    ).toThrow();
  });
});

describe("isPathInsideVault", () => {
  it("returns true for files inside the vault", () => {
    expect(isPathInsideVault("/tmp/vault/note.md", "/tmp/vault")).toBe(true);
  });

  it("returns false for files outside the vault", () => {
    expect(isPathInsideVault("/etc/passwd", "/tmp/vault")).toBe(false);
  });

  it("returns false for parent directory traversal", () => {
    expect(isPathInsideVault("/tmp/vault/../etc/passwd", "/tmp/vault")).toBe(
      false,
    );
  });
});

describe("toVaultRelative", () => {
  it("converts absolute path to vault-relative path", () => {
    expect(toVaultRelative("/tmp/vault/Folder/Note.md", "/tmp/vault")).toBe(
      "Folder/Note.md",
    );
  });

  it("uses forward slashes in vault-relative paths", () => {
    expect(toVaultRelative("/tmp/vault/Folder/Note.md", "/tmp/vault")).toBe(
      "Folder/Note.md",
    );
  });
});

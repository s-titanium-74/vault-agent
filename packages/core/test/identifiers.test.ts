import { describe, it, expect } from "vitest";
import {
  noteIdFromPath,
  vaultIdentity,
  parseChunkId,
  isValidNoteId,
} from "../src/identifiers.js";

describe("noteIdFromPath", () => {
  it("produces a 32-char hex string from a vault-relative path", () => {
    const id = noteIdFromPath("Folder/Note.md");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });

  it("produces different IDs for different paths", () => {
    const id1 = noteIdFromPath("Folder/Note.md");
    const id2 = noteIdFromPath("Folder/Other.md");
    expect(id1).not.toBe(id2);
  });

  it("produces the same ID for the same path", () => {
    const id1 = noteIdFromPath("Folder/Note.md");
    const id2 = noteIdFromPath("Folder/Note.md");
    expect(id1).toBe(id2);
  });
});

describe("vaultIdentity", () => {
  it("produces a 32-char hex string from a vault root path", () => {
    const id = vaultIdentity("/home/user/vault");
    expect(id).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("parseChunkId", () => {
  it("parses a valid chunk ID", () => {
    const noteId = noteIdFromPath("Note.md");
    const result = parseChunkId(`${noteId}:0`);
    expect(result).toEqual({ noteId, chunkIndex: 0 });
  });

  it("returns null for invalid chunk IDs", () => {
    expect(parseChunkId("invalid")).toBeNull();
    expect(parseChunkId("abc:1")).toBeNull();
    expect(parseChunkId("abc")).toBeNull();
  });
});

describe("isValidNoteId", () => {
  it("returns true for valid 32-char hex IDs", () => {
    const id = noteIdFromPath("Note.md");
    expect(isValidNoteId(id)).toBe(true);
  });

  it("returns false for invalid IDs", () => {
    expect(isValidNoteId("abc")).toBe(false);
    expect(isValidNoteId("")).toBe(false);
    expect(isValidNoteId("GGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG")).toBe(false);
  });
});

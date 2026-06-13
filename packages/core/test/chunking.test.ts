import { describe, it, expect } from "vitest";
import { chunkNote } from "../src/chunking.js";

describe("chunkNote", () => {
  it("chunks a simple note by headings", () => {
    const result = chunkNote({
      noteId: "abc1234567890123456789012345678",
      vaultRelativePath: "Test.md",
      title: "Test Note",
      headingPath: [],
      body: "# Heading 1\n\nContent for heading 1.\n\n# Heading 2\n\nContent for heading 2.",
      fileSize: 200,
    });

    expect(result.empty).toBe(false);
    expect(result.oversized).toBe(false);
    expect(result.chunks.length).toBe(2);
    expect(result.chunks[0]!.heading).toBe("Heading 1");
    expect(result.chunks[1]!.heading).toBe("Heading 2");
  });

  it("handles empty notes", () => {
    const result = chunkNote({
      noteId: "abc1234567890123456789012345678",
      vaultRelativePath: "Empty.md",
      title: null,
      headingPath: [],
      body: "   ",
      fileSize: 100,
    });

    expect(result.empty).toBe(true);
    expect(result.chunks.length).toBe(0);
  });

  it("handles oversized files", () => {
    const result = chunkNote({
      noteId: "abc1234567890123456789012345678",
      vaultRelativePath: "Big.md",
      title: null,
      headingPath: [],
      body: "content",
      fileSize: 3 * 1024 * 1024,
    });

    expect(result.oversized).toBe(true);
    expect(result.chunks.length).toBe(0);
  });

  it("preserves heading path metadata", () => {
    const result = chunkNote({
      noteId: "abc1234567890123456789012345678",
      vaultRelativePath: "Test.md",
      title: "Test Note",
      headingPath: [],
      body: "# Section\n\nContent here.",
      fileSize: 100,
    });

    expect(result.chunks[0]!.heading).toBe("Section");
    expect(result.chunks[0]!.headingPath).toEqual(["Section"]);
  });

  it("handles notes without headings", () => {
    const result = chunkNote({
      noteId: "abc1234567890123456789012345678",
      vaultRelativePath: "NoHeading.md",
      title: null,
      headingPath: [],
      body: "Just some text without any headings at all.",
      fileSize: 100,
    });

    expect(result.chunks.length).toBe(1);
    expect(result.chunks[0]!.heading).toBeNull();
    expect(result.chunks[0]!.headingPath).toEqual([]);
  });

  it("produces consistent note IDs from vault-relative paths", () => {
    const result = chunkNote({
      noteId: "abc1234567890123456789012345678",
      vaultRelativePath: "Folder/Note.md",
      title: "Note Title",
      headingPath: [],
      body: "# Test\n\nContent.",
      fileSize: 100,
    });

    expect(result.chunks[0]!.noteId).toBe("abc1234567890123456789012345678");
    expect(result.chunks[0]!.vaultRelativePath).toBe("Folder/Note.md");
  });

  it("splits oversized sections at paragraph boundaries", () => {
    const longParagraph = "A".repeat(3000);
    const body = `# Big Section\n\n${longParagraph}\n\n${longParagraph}\n\n${longParagraph}`;

    const result = chunkNote({
      noteId: "abc1234567890123456789012345678",
      vaultRelativePath: "Big.md",
      title: null,
      headingPath: [],
      body,
      fileSize: 10000,
    });

    expect(result.chunks.length).toBeGreaterThan(1);
    for (const chunk of result.chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(4000);
    }
  });

  it("produces content hashes for each chunk", () => {
    const result = chunkNote({
      noteId: "abc1234567890123456789012345678",
      vaultRelativePath: "Test.md",
      title: null,
      headingPath: [],
      body: "# Heading\n\nContent.",
      fileSize: 100,
    });

    for (const chunk of result.chunks) {
      expect(chunk.contentHash).toMatch(/^[0-9a-f]{32}$/);
    }
  });
});

import { describe, it, expect } from "vitest";
import {
  searchRequestSchema,
  relatedRequestSchema,
  noteRetrieveQuerySchema,
  chunkRetrieveQuerySchema,
  attachmentRetrieveQuerySchema,
} from "../src/schemas.js";

describe("searchRequestSchema", () => {
  it("accepts a valid search request", () => {
    const result = searchRequestSchema.safeParse({
      query: "hello world",
      mode: "lexical",
      limit: 10,
    });
    expect(result.success).toBe(true);
  });

  it("rejects whitespace-only query", () => {
    const result = searchRequestSchema.safeParse({
      query: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty query", () => {
    const result = searchRequestSchema.safeParse({
      query: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts query at max length (1000)", () => {
    const result = searchRequestSchema.safeParse({
      query: "a".repeat(1000),
    });
    expect(result.success).toBe(true);
  });

  it("rejects query exceeding max length (1001)", () => {
    const result = searchRequestSchema.safeParse({
      query: "a".repeat(1001),
    });
    expect(result.success).toBe(false);
  });

  it("accepts limit at minimum (1)", () => {
    const result = searchRequestSchema.safeParse({
      query: "test",
      limit: 1,
    });
    expect(result.success).toBe(true);
  });

  it("accepts limit at maximum (50)", () => {
    const result = searchRequestSchema.safeParse({
      query: "test",
      limit: 50,
    });
    expect(result.success).toBe(true);
  });

  it("rejects limit above 50", () => {
    const result = searchRequestSchema.safeParse({
      query: "test",
      limit: 51,
    });
    expect(result.success).toBe(false);
  });

  it("rejects limit of 0", () => {
    const result = searchRequestSchema.safeParse({
      query: "test",
      limit: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative limit", () => {
    const result = searchRequestSchema.safeParse({
      query: "test",
      limit: -1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts valid modes", () => {
    for (const mode of ["lexical", "embedding", "hybrid"]) {
      const result = searchRequestSchema.safeParse({
        query: "test",
        mode,
      });
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid mode", () => {
    const result = searchRequestSchema.safeParse({
      query: "test",
      mode: "invalid",
    });
    expect(result.success).toBe(false);
  });

  it("defaults mode and limit when omitted", () => {
    const result = searchRequestSchema.safeParse({
      query: "test",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mode).toBeUndefined();
      expect(result.data.limit).toBeUndefined();
    }
  });
});

describe("relatedRequestSchema", () => {
  it("accepts valid note type", () => {
    const result = relatedRequestSchema.safeParse({
      type: "note",
      id: "abcd1234abcd1234abcd1234abcd1234",
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid chunk type", () => {
    const result = relatedRequestSchema.safeParse({
      type: "chunk",
      id: "abcd1234abcd1234abcd1234abcd1234:0",
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid type", () => {
    const result = relatedRequestSchema.safeParse({
      type: "invalid",
      id: "some-id",
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty id", () => {
    const result = relatedRequestSchema.safeParse({
      type: "note",
      id: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts limit and mode options", () => {
    const result = relatedRequestSchema.safeParse({
      type: "note",
      id: "abcd1234abcd1234abcd1234abcd1234",
      mode: "hybrid",
      limit: 20,
    });
    expect(result.success).toBe(true);
  });
});

describe("noteRetrieveQuerySchema", () => {
  it("accepts valid 32-char hex noteId", () => {
    const result = noteRetrieveQuerySchema.safeParse({
      noteId: "abcd1234abcd1234abcd1234abcd1234",
    });
    expect(result.success).toBe(true);
  });

  it("rejects noteId with wrong length", () => {
    const result = noteRetrieveQuerySchema.safeParse({
      noteId: "abcd1234",
    });
    expect(result.success).toBe(false);
  });

  it("rejects noteId with uppercase letters", () => {
    const result = noteRetrieveQuerySchema.safeParse({
      noteId: "ABCD1234ABCD1234ABCD1234ABCD1234",
    });
    expect(result.success).toBe(false);
  });

  it("rejects noteId with non-hex characters", () => {
    const result = noteRetrieveQuerySchema.safeParse({
      noteId: "ghijklmnopqrstuvwxyz1234567890gh",
    });
    expect(result.success).toBe(false);
  });

  it("accepts allowLarge boolean option", () => {
    const result = noteRetrieveQuerySchema.safeParse({
      noteId: "abcd1234abcd1234abcd1234abcd1234",
      allowLarge: true,
    });
    expect(result.success).toBe(true);
  });
});

describe("chunkRetrieveQuerySchema", () => {
  it("accepts valid noteId and chunkIndex", () => {
    const result = chunkRetrieveQuerySchema.safeParse({
      noteId: "abcd1234abcd1234abcd1234abcd1234",
      chunkIndex: 0,
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid noteId", () => {
    const result = chunkRetrieveQuerySchema.safeParse({
      noteId: "invalid",
      chunkIndex: 0,
    });
    expect(result.success).toBe(false);
  });

  it("rejects negative chunkIndex", () => {
    const result = chunkRetrieveQuerySchema.safeParse({
      noteId: "abcd1234abcd1234abcd1234abcd1234",
      chunkIndex: -1,
    });
    expect(result.success).toBe(false);
  });

  it("accepts chunkIndex of 0", () => {
    const result = chunkRetrieveQuerySchema.safeParse({
      noteId: "abcd1234abcd1234abcd1234abcd1234",
      chunkIndex: 0,
    });
    expect(result.success).toBe(true);
  });

  it("accepts large chunkIndex", () => {
    const result = chunkRetrieveQuerySchema.safeParse({
      noteId: "abcd1234abcd1234abcd1234abcd1234",
      chunkIndex: 100,
    });
    expect(result.success).toBe(true);
  });
});

describe("attachmentRetrieveQuerySchema", () => {
  it("accepts valid path", () => {
    const result = attachmentRetrieveQuerySchema.safeParse({
      vaultRelativePath: "attachments/image.png",
    });
    expect(result.success).toBe(true);
  });

  it("rejects empty path", () => {
    const result = attachmentRetrieveQuerySchema.safeParse({
      vaultRelativePath: "",
    });
    expect(result.success).toBe(false);
  });

  it("accepts download and allowLarge options", () => {
    const result = attachmentRetrieveQuerySchema.safeParse({
      vaultRelativePath: "attachments/data.csv",
      download: true,
      allowLarge: false,
    });
    expect(result.success).toBe(true);
  });
});

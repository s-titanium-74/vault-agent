import { describe, expect, it, vi } from "vitest";
import {
  MutationError,
  mutationBatchSchema,
  mutationSettingsSchema,
  mutationBatchSummary,
  prepareMutationBatch,
  previewMutationBatch,
  SourceError,
  type MutationPreparationContext,
} from "../src/portable/index.js";
import { decodeMutationBase64 } from "../src/portable/mutation-text.js";

const create = (path = "Notes/New.md", content = "# Synthetic\n") => ({
  type: "create_note",
  path,
  content,
});
const replace = (content = "New", expected_version = "source-v1") => ({
  type: "replace_note",
  path: "Notes/Example.md",
  expected_version,
  content,
});
const patch = (replacements: unknown[], path = "Notes/Example.md") => ({
  type: "patch_note",
  path,
  expected_version: "source-v1",
  replacements,
});
const literal = (pattern: string, replacement: string, extra = {}) => ({
  match_type: "literal",
  pattern,
  replacement,
  ...extra,
});
const regex = (pattern: string, replacement: string, extra = {}) => ({
  match_type: "regex",
  pattern,
  replacement,
  ...extra,
});
function context(
  content = "Old",
  extra: Partial<MutationPreparationContext> = {},
): MutationPreparationContext {
  return {
    vaultId: "synthetic-vault",
    sourceId: "synthetic-source",
    sourceKind: "filesystem",
    policyRevision: "policy-v1",
    includes: ["."],
    settings: { enabled: true },
    snapshot: vi.fn(async (path, options) =>
      path === "Notes/Example.md" || path === "Images/pixel.png"
        ? {
            version: "source-v1",
            ...(options.readContent ? { content } : {}),
          }
        : null,
    ),
    ...extra,
  };
}
const prepare = (operations: unknown[], ctx = context(), preview = false) =>
  prepareMutationBatch(ctx, { operations }, { preview });
async function resultText(content: string, replacements: unknown[]) {
  const result = await prepare([patch(replacements)], context(content));
  expect(result.items[0]?.status).toBe("prepared");
  return new TextDecoder("utf-8", { ignoreBOM: true }).decode(
    result.items[0]!.bytes!,
  );
}
async function expectEnvelope(
  operations: unknown[],
  code: string,
  ctx = context(),
) {
  await expect(prepare(operations, ctx)).rejects.toMatchObject({
    code,
    message: "Mutation preparation failed.",
  });
}

describe("mutation admission and privacy", () => {
  it("defaults to disabled and review mode without touching a source", async () => {
    expect(mutationSettingsSchema.parse({})).toMatchObject({
      enabled: false,
      mode: "review",
      max_file_bytes: 5242880,
      max_batch_bytes: 20971520,
      max_batch_operations: 20,
      history_retention_days: 7,
    });
    const ctx = context("Old", { settings: {} });
    await expectEnvelope([create()], "WRITE_DISABLED", ctx);
    expect(ctx.snapshot).not.toHaveBeenCalled();
  });
  it("does not turn a read-only source into a writer", async () => {
    const ctx = context("Old", { sourceKind: "pcloud" });
    await expectEnvelope([create()], "SOURCE_WRITE_UNSUPPORTED", ctx);
    expect(ctx.snapshot).not.toHaveBeenCalled();
  });
  it.each([
    [{ enabled: "true" }],
    [{ max_file_bytes: 0 }],
    [{ max_batch_bytes: -1 }],
    [{ max_batch_operations: 101 }],
    [{ max_file_bytes: 20971521 }],
    [{ max_batch_bytes: 104857601 }],
    [{ history_retention_days: 0 }],
    [{ mode: "force" }],
    [{ force: true }],
  ])("rejects unsupported settings %j", async (settings) => {
    await expectEnvelope(
      [create()],
      "INVALID_REQUEST",
      context("Old", { settings: settings as never }),
    );
  });
  it.each([
    { operations: [{ ...create(), force: true }] },
    { operations: [create()], force: true },
    { operations: [patch([{ ...literal("Old", "New"), force: true }])] },
    { operations: [patch([literal("Old", "New", { expected_matches: 2 })])] },
    { operations: [patch([literal("", "New")])] },
    { operations: [{ type: "move_file", path: "A.md", target: "B.md" }] },
    { operations: [{ ...replace(), expected_version: "" }] },
    { operations: [{ type: "delete_file", path: "A.md" }] },
    {
      operations: [
        {
          type: "upload_attachment",
          path: "A.png",
          content_base64: "",
          replace: true,
        },
      ],
    },
    {
      operations: [
        {
          type: "upload_attachment",
          path: "A.png",
          content_base64: "",
          expected_version: "v1",
        },
      ],
    },
    { operations: [] },
  ])(
    "rejects malformed/unknown safety fields without echoing input",
    async (input) => {
      expect(mutationBatchSchema.safeParse(input).success).toBe(false);
      await expect(
        prepareMutationBatch(context(), input),
      ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    },
  );
  it("returns only fixed errors for provider failures", async () => {
    const result = await prepare(
      [replace()],
      context("Old", {
        snapshot: async () => {
          throw new Error("private provider text /outside/root secret");
        },
      }),
    );
    expect(result.items[0]?.code).toBe("SOURCE_UNAVAILABLE");
    expect(JSON.stringify(result)).not.toMatch(
      /private provider|outside|secret/,
    );
    expect(new MutationError("INVALID_PATTERN").message).not.toContain(
      "pattern",
    );
  });
});

describe("mutation paths and current source policy", () => {
  it.each([
    "../A.md",
    "/A.md",
    "C:/A.md",
    "a\\b.md",
    "//host/A.md",
    "a//A.md",
    "a/./A.md",
    "a/../A.md",
    "A\u0000.md",
    "A\ud800.md",
    "A.md/",
    "a /A.md",
    "A.md.",
    "a:stream.md",
    "CON.md",
    "A/NUL.png",
    "file:///A.md",
  ])("rejects unsafe canonical paths %s before I/O", async (path) => {
    const ctx = context();
    await expectEnvelope([create(path)], "INVALID_PATH", ctx);
    expect(ctx.snapshot).not.toHaveBeenCalled();
  });
  it.each([
    ".env",
    ".cursor/rules/a.md",
    ".cursorrules",
    ".obsidian/config.md",
    ".git/config",
    "node_modules/a.md",
    "dist/a.md",
    "Private/A.md",
  ])("denies excluded/hidden scope %s as an item", async (path) => {
    const ctx = context("Old", { excludes: ["Private/"] });
    const batch = await prepare([create(path), create()], ctx);
    expect(batch.items[0]).toMatchObject({
      status: "failed",
      code: "SOURCE_EXCLUDED",
    });
    expect(batch.items[1]?.status).toBe("prepared");
    expect(ctx.snapshot).toHaveBeenCalledTimes(1);
  });
  it("uses current includes and preserves raw Unicode and percent filenames", async () => {
    const batch = await prepare(
      [create("Other/A.md"), create("Notes/日本語 100%.markdown")],
      context("Old", { includes: ["Notes"] }),
    );
    expect(batch.items[0]?.code).toBe("SOURCE_EXCLUDED");
    expect(batch.items[1]).toMatchObject({
      status: "prepared",
      note_id: expect.stringMatching(/^[0-9a-f]{32}$/),
    });
  });
  it.each([
    ["A.md", "A.md"],
    ["A.md", "A.md/child.md"],
    ["A.md/child.md", "A.md"],
  ])("rejects duplicate/colliding target %j", async (a, b) => {
    const ctx = context();
    await expectEnvelope([create(a), create(b)], "DUPLICATE_PATH", ctx);
    expect(ctx.snapshot).not.toHaveBeenCalled();
  });
  it("uses adapter collision semantics for case and Unicode aliases", async () => {
    const ctx = context("Old", {
      collisionKey: (path) => path.normalize("NFC").toLowerCase(),
    });
    await expectEnvelope(
      [create("Café.md"), create("CAFE\u0301.md")],
      "DUPLICATE_PATH",
      ctx,
    );
    await expectEnvelope(
      [create("A.md"), create("a.MD/child.md")],
      "DUPLICATE_PATH",
      ctx,
    );
    expect(ctx.snapshot).not.toHaveBeenCalled();
  });
  it("keeps filesystem and R2 attachment policies and allows further restriction", async () => {
    const attachment = {
      type: "upload_attachment",
      path: "Images/sample.bin",
      content_base64: "AQID",
    };
    expect((await prepare([attachment])).items[0]?.status).toBe("prepared");
    expect(
      (await prepare([attachment], context("Old", { sourceKind: "r2" })))
        .items[0]?.code,
    ).toBe("SOURCE_EXCLUDED");
    expect(
      (
        await prepare(
          [{ ...attachment, path: "New.png" }],
          context("Old", { attachmentAllowed: () => false }),
        )
      ).items[0]?.code,
    ).toBe("SOURCE_EXCLUDED");
    expect((await prepare([create("Images/picture.png")])).items[0]?.code).toBe(
      "SOURCE_EXCLUDED",
    );
    expect(
      (await prepare([{ ...attachment, path: "Notes/Attachment.md" }])).items[0]
        ?.code,
    ).toBe("SOURCE_EXCLUDED");
  });
});

describe("source version and independent file results", () => {
  it("checks no-clobber, missing targets, explicit replacement and version conflicts", async () => {
    const batch = await prepare([
      create("Notes/Example.md"),
      { ...replace(), path: "Missing.md" },
      { ...replace("New", "stale"), path: "Images/other.png" },
      {
        type: "upload_attachment",
        path: "Images/pixel.png",
        content_base64: "AQID",
      },
    ]);
    expect(batch.items.map((i) => i.code)).toEqual([
      "FILE_ALREADY_EXISTS",
      "SOURCE_NOT_FOUND",
      "SOURCE_EXCLUDED",
      "FILE_ALREADY_EXISTS",
    ]);
    expect((await prepare([replace("New", "stale")])).items[0]?.code).toBe(
      "SOURCE_REVISION_MISMATCH",
    );
    const replacement = await prepare([
      {
        type: "upload_attachment",
        path: "Images/pixel.png",
        replace: true,
        expected_version: "source-v1",
        content_base64: "AQID",
      },
    ]);
    expect(replacement.items[0]).toMatchObject({
      status: "prepared",
      action: "replace",
      size: 3,
    });
  });
  it("prepares all files, with patch failures independent of other files", async () => {
    const result = await prepare([
      patch([literal("Missing", "New")]),
      create("Notes/Other.md"),
      {
        type: "delete_file",
        path: "Images/pixel.png",
        expected_version: "source-v1",
      },
    ]);
    expect(result.items.map((i) => i.status)).toEqual([
      "failed",
      "prepared",
      "prepared",
    ]);
    expect(result.items[0]?.code).toBe("MATCH_COUNT_MISMATCH");
    expect(result.items[2]).toMatchObject({
      action: "delete",
      expected_version: "source-v1",
    });
    expect(result.items[2]?.bytes).toBeUndefined();
  });
  it("maps unsafe adapter paths and stale reads without exposing provider messages", async () => {
    const ctx = context("Old", {
      snapshot: async () => {
        throw new SourceError("SOURCE_REVISION_MISMATCH", "private body");
      },
    });
    const batch = await prepare([replace()], ctx);
    expect(batch.items[0]?.code).toBe("SOURCE_REVISION_MISMATCH");
    expect(JSON.stringify(batch)).not.toContain("private body");
  });
  it("requires a patch snapshot and passes bounded read options", async () => {
    const ctx = context("Old", {
      snapshot: vi.fn(async () => ({ version: "source-v1" })),
    });
    const batch = await prepare([patch([literal("Old", "New")])], ctx);
    expect(batch.items[0]?.code).toBe("SOURCE_UNAVAILABLE");
    expect(ctx.snapshot).toHaveBeenCalledWith("Notes/Example.md", {
      readContent: true,
      maxBytes: 5242880,
    });
  });
});

describe("UTF-8, Base64 and whole-envelope size bounds", () => {
  it.each([
    "A",
    "AA",
    "AAA",
    "AAAA=",
    "=AAA",
    "A=AA",
    "AA=A",
    "AA==AAAA",
    "AB==",
    "AAB=",
    "__==",
    "AQID\n",
    "@@==",
  ])("rejects noncanonical Base64 %s", async (content_base64) => {
    const ctx = context();
    await expectEnvelope(
      [
        create(),
        { type: "upload_attachment", path: "New.png", content_base64 },
      ],
      "INVALID_BASE64",
      ctx,
    );
    expect(ctx.snapshot).not.toHaveBeenCalled();
  });
  it.each([
    ["", []],
    ["AA==", [0]],
    ["AAA=", [0, 0]],
    ["AQID", [1, 2, 3]],
    ["/w==", [255]],
    ["//8=", [255, 255]],
  ])("decodes canonical Base64 %s", (encoded, bytes) => {
    expect(Array.from(decodeMutationBase64(encoded as string, 10))).toEqual(
      bytes,
    );
  });
  it("rejects invalid Unicode before source I/O, preserves valid BOM/CRLF/UTF-8", async () => {
    const ctx = context();
    await expectEnvelope([create("New.md", "\ud800")], "INVALID_UTF8", ctx);
    await expectEnvelope(
      [patch([literal("Old", "\udfff")])],
      "INVALID_UTF8",
      ctx,
    );
    expect(ctx.snapshot).not.toHaveBeenCalled();
    const content =
      "\ufeff---\r\ndate: unchanged\r\n---\r\n# 日本語\r\nOld\r\n";
    expect(await resultText(content, [literal("Old", "新しい😀")])).toBe(
      content.replace("Old", "新しい😀"),
    );
  });
  it("counts decoded/UTF-8 bytes rather than characters or Base64 bytes", async () => {
    const ctx = context("Old", {
      settings: { enabled: true, max_file_bytes: 3, max_batch_bytes: 6 },
    });
    const batch = await prepare(
      [
        create("A.md", "日"),
        { type: "upload_attachment", path: "A.png", content_base64: "AQID" },
      ],
      ctx,
    );
    expect(batch.total_bytes).toBe(6);
    await expectEnvelope([create("A.md", "日日")], "SIZE_LIMIT_EXCEEDED", ctx);
    await expectEnvelope(
      [
        {
          type: "upload_attachment",
          path: "A.png",
          content_base64: "AQIDBA==",
        },
      ],
      "SIZE_LIMIT_EXCEEDED",
      ctx,
    );
    await expectEnvelope(
      [create("A.md", "日"), create("B.md", "日日")],
      "SIZE_LIMIT_EXCEEDED",
      context("Old", { settings: { enabled: true, max_batch_bytes: 8 } }),
    );
  });
  it("counts operations and validates the complete envelope before snapshot I/O", async () => {
    const ctx = context("Old", {
      settings: { enabled: true, max_batch_operations: 1 },
    });
    await expectEnvelope(
      [create("A.md"), create("B.md")],
      "SIZE_LIMIT_EXCEEDED",
      ctx,
    );
    expect(ctx.snapshot).not.toHaveBeenCalled();
  });
  it("enforces raw payload size even for conflicting files", async () => {
    const ctx = context("Old", {
      settings: { enabled: true, max_file_bytes: 3 },
    });
    await expectEnvelope(
      [create("Notes/Example.md", "large")],
      "SIZE_LIMIT_EXCEEDED",
      ctx,
    );
    expect(ctx.snapshot).not.toHaveBeenCalled();
  });
  it("rejects the whole batch for final patched file or batch overflow", async () => {
    await expectEnvelope(
      [create("A.md", "A"), patch([literal("Old", "too big")])],
      "SIZE_LIMIT_EXCEEDED",
      context("Old", { settings: { enabled: true, max_file_bytes: 5 } }),
    );
    await expectEnvelope(
      [create("A.md", "AAA"), patch([literal("Old", "BBBB")])],
      "SIZE_LIMIT_EXCEEDED",
      context("Old", { settings: { enabled: true, max_batch_bytes: 6 } }),
    );
    await expectEnvelope(
      [patch([literal("Old", "AAAAAA"), literal("AAAAAA", "B")])],
      "SIZE_LIMIT_EXCEEDED",
      context("Old", { settings: { enabled: true, max_file_bytes: 5 } }),
    );
  });
  it("bounds patch instructions even when output would be tiny", async () => {
    const ctx = context();
    await expectEnvelope(
      [patch([literal("x".repeat(1024 * 1024), "A")])],
      "SIZE_LIMIT_EXCEEDED",
      ctx,
    );
    expect(ctx.snapshot).not.toHaveBeenCalled();
  });
  it("marks storage-sized notes beyond the existing indexing limit", async () => {
    const batch = await prepare([
      create("Large.md", "A".repeat(2 * 1024 * 1024 + 1)),
    ]);
    expect(batch.items[0]).toMatchObject({
      status: "prepared",
      oversized_for_index: true,
    });
  });
});

describe("ordered literal and regex replacements", () => {
  it("replaces exact substrings literally without rematching inserted text", async () => {
    expect(await resultText("Old", [literal("Old", "$1 Old Old")])).toBe(
      "$1 Old Old",
    );
    expect(
      await resultText("Old Old", [
        literal("Old", "New", { allow_multiple: true, expected_matches: 2 }),
      ]),
    ).toBe("New New");
    expect(
      await resultText("Old", [
        literal("Old", "Middle"),
        literal("Middle", "New"),
      ]),
    ).toBe("New");
  });
  it.each([
    ["old", literal("Old", "New")],
    ["Old Old", literal("Old", "New")],
    [
      "Old",
      literal("Old", "New", { allow_multiple: true, expected_matches: 2 }),
    ],
    [
      "Old Old Old",
      literal("Old", "New", { allow_multiple: true, expected_matches: 2 }),
    ],
    [
      "aaaa",
      literal("aaa", "New", { allow_multiple: true, expected_matches: 2 }),
    ],
  ])(
    "rejects mismatched non-overlapping counts in %s",
    async (text, replacement) => {
      const batch = await prepare([patch([replacement])], context(text));
      expect(batch.items[0]).toMatchObject({
        status: "failed",
        code: "MATCH_COUNT_MISMATCH",
      });
      expect(batch.items[0]?.bytes).toBeUndefined();
    },
  );
  it("discards all prior replacements when a later replacement fails", async () => {
    const ctx = context();
    const batch = await prepare(
      [patch([literal("Old", "New"), literal("Missing", "Wrong")])],
      ctx,
      true,
    );
    expect(batch.items[0]).toMatchObject({
      status: "failed",
      code: "MATCH_COUNT_MISMATCH",
    });
    expect(batch.items[0]?.bytes).toBeUndefined();
    expect(batch.items[0]?.before).toBeUndefined();
  });
  it("supports captures, optional unmatched groups and escaped dollars", async () => {
    expect(
      await resultText("Alpha Beta", [regex("(\\w+) (\\w+)", "$2, $1 $$")]),
    ).toBe("Beta, Alpha $");
    expect(await resultText("b", [regex("(a)?b", "$1X")])).toBe("X");
    expect(await resultText("a", [regex("(a)", "$$1")])).toBe("$1");
    expect(await resultText("a", [regex("(a)", "\\$1")])).toBe("\\a");
  });
  it("supports only explicit flags and leaves the multiple-match rule intact", async () => {
    expect(await resultText("old", [regex("OLD", "New", { flags: "i" })])).toBe(
      "New",
    );
    expect(await resultText("A\nB", [regex("^B$", "C", { flags: "m" })])).toBe(
      "A\nC",
    );
    expect(await resultText("A\nB", [regex("A.B", "C", { flags: "s" })])).toBe(
      "C",
    );
    const result = await prepare(
      [patch([regex("a", "X", { flags: "i" })])],
      context("aA"),
    );
    expect(result.items[0]?.code).toBe("MATCH_COUNT_MISMATCH");
  });
  it("advances zero-width matches by Unicode code point and matches EOF once", async () => {
    expect(
      await resultText("😀", [
        regex("(?:)", "|", { allow_multiple: true, expected_matches: 2 }),
      ]),
    ).toBe("|😀|");
    expect(await resultText("", [regex("$", "X")])).toBe("X");
    expect(
      await resultText("ab", [
        regex("^|$", "|", { allow_multiple: true, expected_matches: 2 }),
      ]),
    ).toBe("|ab|");
  });
  it.each([
    regex("[", "X"),
    regex("(?=a)", "X"),
    regex("(?<=a)b", "X"),
    regex("(?i)a", "X"),
    regex("(?P<name>a)", "X"),
    regex("(a)\\1", "X"),
    regex("a{2}", "X"),
    regex("\\Q[\\E(a{1000}){1000}", "X"),
    regex("a", "X", { flags: "g" }),
    regex("a", "X", { flags: "ii" }),
    regex("a", "$1"),
    regex("(a)", "$2"),
    regex("(a)", "$10"),
    regex("a", "$0"),
    regex("a", "$&"),
    regex("a", "$`"),
    regex("a", "$'"),
    regex("a", "${name}"),
    regex("a", "$"),
  ])(
    "rejects unsupported patterns, flags and invalid captures %j",
    async (replacement) => {
      const batch = await prepare([patch([replacement])], context("a"));
      expect(batch.items[0]).toMatchObject({
        status: "failed",
        code: "INVALID_PATTERN",
      });
    },
  );
  it("bounds compilation, group count and search work without executing native user regex", async () => {
    for (const pattern of ["a".repeat(1025), "()".repeat(33)]) {
      const batch = await prepare([patch([regex(pattern, "X")])], context("a"));
      expect(batch.items[0]?.code).toBe("REGEX_BUDGET_EXCEEDED");
    }
    const rejected = await prepare(
      [patch([regex("(a+)+$", "X")])],
      context("a".repeat(1024 * 1024) + "!"),
    );
    expect(rejected.items[0]?.code).toBe("REGEX_BUDGET_EXCEEDED");
    const bounded = await prepare(
      [patch([regex("(a+)+$", "X")])],
      context("a".repeat(5000) + "!"),
    );
    expect(bounded.items[0]?.code).toBe("MATCH_COUNT_MISMATCH");
  });
  it("charges work across files in one batch", async () => {
    const text = "a".repeat(600_000) + "!";
    const ctx = context(text, {
      snapshot: async () => ({ version: "source-v1", content: text }),
    });
    const batch = await prepare(
      [
        patch([regex("(a+)+$", "X")], "A.md"),
        patch([regex("(a+)+$", "X")], "B.md"),
      ],
      ctx,
    );
    expect(batch.items.map((i) => i.code)).toEqual([
      "MATCH_COUNT_MISMATCH",
      "REGEX_BUDGET_EXCEEDED",
    ]);
  });
});

describe("binding material, content-free summaries and bounded preview", () => {
  it("normalizes defaults and field order for a source/policy-bound ordered digest", async () => {
    const a = await prepare([patch([literal("Old", "New")])]);
    const b = await prepare([
      {
        replacements: [
          literal("Old", "New", { allow_multiple: false, expected_matches: 1 }),
        ],
        expected_version: "source-v1",
        path: "Notes/Example.md",
        type: "patch_note",
      },
    ]);
    expect(a.request_digest).toBe(b.request_digest);
    for (const changed of [
      context("Old", { vaultId: "other" }),
      context("Old", { sourceId: "other" }),
      context("Old", { policyRevision: "other" }),
      context("Old", { includes: ["Notes"] }),
      context("Old", { settings: { enabled: true, mode: "direct" } }),
    ]) {
      expect(
        (await prepare([patch([literal("Old", "New")])], changed))
          .request_digest,
      ).not.toBe(a.request_digest);
    }
    expect(
      (await prepare([patch([literal("Old", "Other")])])).request_digest,
    ).not.toBe(a.request_digest);
    expect(
      (await prepare([create("A.md"), create("B.md")])).request_digest,
    ).not.toBe(
      (await prepare([create("B.md"), create("A.md")])).request_digest,
    );
  });
  it("includes note text only in explicit preview", async () => {
    const batch = await prepare(
      [
        replace("SYNTHETIC_NEW_BODY"),
        { type: "upload_attachment", path: "New.png", content_base64: "AQID" },
        {
          type: "delete_file",
          path: "Images/pixel.png",
          expected_version: "source-v1",
        },
      ],
      context("SYNTHETIC_OLD_BODY"),
      true,
    );
    const summary = mutationBatchSummary(batch);
    expect(JSON.stringify(summary)).not.toMatch(
      /SYNTHETIC_|AQID|"bytes"|"before"|request_digest/,
    );
    const preview = previewMutationBatch(batch);
    expect(preview.results[0]).toHaveProperty("diff", {
      offset: 10,
      removed: "OLD",
      added: "NEW",
      removed_bytes: 3,
      added_bytes: 3,
      truncated: false,
    });
    expect(preview.results[1]).toMatchObject({
      path: "New.png",
      action: "create",
      size: 3,
    });
    expect(preview.results[1]).not.toHaveProperty("diff");
    expect(preview.results[2]).toMatchObject({ action: "delete" });
  });
  it("bounds aggregate rendered diffs, including JSON escaping, with truncation", async () => {
    const batch = await prepare(
      [
        create("A.md", "\n".repeat(20_000)),
        create("B.md", "😀".repeat(10_000)),
      ],
      context(),
      true,
    );
    const preview = previewMutationBatch(batch, 512);
    const diffs = preview.results
      .map((item) => ("diff" in item ? item.diff : undefined))
      .filter(Boolean);
    expect(
      diffs.reduce(
        (sum, diff) =>
          sum + new TextEncoder().encode(JSON.stringify(diff)).length,
        0,
      ),
    ).toBeLessThanOrEqual(512);
    expect(
      preview.results.every(
        (item) => "preview_truncated" in item && item.preview_truncated,
      ),
    ).toBe(true);
    expect(previewMutationBatch(batch, 0).results[0]).toHaveProperty(
      "preview_truncated",
      true,
    );
    expect(() => previewMutationBatch(batch, 16385)).toThrow(MutationError);
    expect(() => previewMutationBatch(batch, -1)).toThrow(MutationError);
  });
  it("does not split emoji in changed spans or preview truncation", async () => {
    const batch = await prepare(
      [replace("😀".repeat(300))],
      context("😁".repeat(300)),
      true,
    );
    const item = previewMutationBatch(batch, 256).results[0];
    expect(item).toHaveProperty("diff.offset", 0);
    if (item && "diff" in item) {
      for (const text of [item.diff.removed, item.diff.added])
        expect(
          new TextDecoder("utf-8", { fatal: true }).decode(
            new TextEncoder().encode(text),
          ),
        ).toBe(text);
    }
  });
  it("requires explicit preparation of note preview content", async () => {
    const batch = await prepare([replace()]);
    expect(() => previewMutationBatch(batch)).toThrow(MutationError);
  });
});

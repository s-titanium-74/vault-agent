import { z } from "zod";

export const MUTATION_CLOCK_SKEW_MS = 30_000;

const positive = z.number().int().positive().safe();
export const mutationSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    mode: z.enum(["review", "direct"]).default("review"),
    max_file_bytes: positive.max(20 * 1024 * 1024).default(5 * 1024 * 1024),
    max_batch_operations: positive.max(100).default(20),
    max_batch_bytes: positive.max(100 * 1024 * 1024).default(20 * 1024 * 1024),
    history_retention_days: positive.max(365).default(7),
  })
  .strict();
export type MutationSettings = z.infer<typeof mutationSettingsSchema>;

const path = z.string().min(1).max(4096);
const version = z.string().min(1).max(1024);
const matchOptions = {
  pattern: z.string().min(1),
  replacement: z.string(),
  allow_multiple: z.boolean().default(false),
  expected_matches: positive.max(10_000).default(1),
};
export const mutationReplacementSchema = z
  .discriminatedUnion("match_type", [
    z.object({ match_type: z.literal("literal"), ...matchOptions }).strict(),
    z
      .object({
        match_type: z.literal("regex"),
        ...matchOptions,
        flags: z.string().max(3).default(""),
      })
      .strict(),
  ])
  .refine((r) => r.allow_multiple || r.expected_matches === 1);
export type MutationReplacement = z.infer<typeof mutationReplacementSchema>;

export const mutationOperationSchema = z
  .discriminatedUnion("type", [
    z
      .object({ type: z.literal("create_note"), path, content: z.string() })
      .strict(),
    z
      .object({
        type: z.literal("replace_note"),
        path,
        expected_version: version,
        content: z.string(),
      })
      .strict(),
    z
      .object({
        type: z.literal("patch_note"),
        path,
        expected_version: version,
        replacements: z.array(mutationReplacementSchema).min(1).max(100),
      })
      .strict(),
    z
      .object({
        type: z.literal("upload_attachment"),
        path,
        content_base64: z.string(),
        replace: z.boolean().default(false),
        expected_version: version.optional(),
      })
      .strict(),
    z
      .object({
        type: z.literal("delete_file"),
        path,
        expected_version: version,
      })
      .strict(),
  ])
  .refine(
    (op) =>
      op.type !== "upload_attachment" ||
      (op.replace ? !!op.expected_version : op.expected_version === undefined),
  );
export type MutationOperation = z.infer<typeof mutationOperationSchema>;
export const mutationBatchSchema = z
  .object({ operations: z.array(mutationOperationSchema).min(1).max(100) })
  .strict();
export type MutationBatch = z.infer<typeof mutationBatchSchema>;
export const previewChangesSchema = mutationBatchSchema.extend({
  preview: z.boolean().default(true),
});
export const applyChangesSchema = mutationBatchSchema.extend({
  operation_id: z.string().min(1).max(300),
  preview_binding: z.string().min(1).max(1024).optional(),
});
export const changeStatusSchema = z
  .object({ operation_id: z.string().min(1).max(300) })
  .strict();

export type MutationErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_PATH"
  | "SOURCE_EXCLUDED"
  | "SOURCE_NOT_FOUND"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_REVISION_MISMATCH"
  | "SOURCE_WRITE_UNSUPPORTED"
  | "WRITE_DISABLED"
  | "FILE_ALREADY_EXISTS"
  | "INVALID_BASE64"
  | "INVALID_UTF8"
  | "DUPLICATE_PATH"
  | "SIZE_LIMIT_EXCEEDED"
  | "MATCH_COUNT_MISMATCH"
  | "INVALID_PATTERN"
  | "REGEX_BUDGET_EXCEEDED";

/** Fixed messages only: never propagate a schema/engine/provider error. */
export class MutationError extends Error {
  constructor(public readonly code: MutationErrorCode) {
    super("Mutation preparation failed.");
    this.name = "MutationError";
  }
}

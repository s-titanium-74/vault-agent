import { z } from "zod";
import { Config, IndexError, IndexStore } from "@vault-agent/core";

export const NOTE_ID_REGEX = /^[0-9a-f]{32}$/;

export function err(code: string, message: string, requestId: string) {
  return {
    error: {
      code,
      message,
      details: { requestId },
    },
  };
}

export function validationErrorCode(
  error: z.ZodError,
  fallbackCode: string,
): string {
  const fields = new Set(error.issues.map((issue) => String(issue.path[0])));
  if (fields.has("limit")) return "INVALID_LIMIT";
  if (fields.has("mode")) return "INVALID_MODE";
  return fallbackCode;
}

export function indexErrorStatus(error: IndexError): number | null {
  if (error.code === "INDEX_BUSY") return 409;
  if (error.code === "EMBEDDING_CONFIG_INVALID") return 400;
  if (
    error.code === "EMBEDDING_FAILED" ||
    error.code === "EMBEDDING_UNAVAILABLE"
  ) {
    return 503;
  }
  return null;
}

export function incompatibleIndexError(
  appStore: IndexStore,
  appConfig: Config,
): { code: string; message: string } | null {
  const staleness = appStore.checkStaleness(appConfig);
  if (!staleness.incompatible) return null;
  return {
    code: "INDEX_INCOMPATIBLE",
    message: `${staleness.details}. Run vault-agent reindex to rebuild the index.`,
  };
}

export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

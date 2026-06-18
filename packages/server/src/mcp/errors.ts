import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

export type Phase1ErrorCode =
  | "INDEX_NOT_FOUND"
  | "INDEX_INCOMPATIBLE"
  | "PATH_OUTSIDE_VAULT"
  | "NOTE_NOT_FOUND"
  | "CHUNK_NOT_FOUND"
  | "ATTACHMENT_NOT_FOUND"
  | "EMBEDDING_UNAVAILABLE"
  | "QUERY_TOO_LARGE"
  | "ATTACHMENT_NOT_ALLOWED"
  | "INTERNAL_ERROR"
  | "TIMEOUT"
  | "VAULT_NOT_CONFIGURED"
  | "INVALID_QUERY"
  | "INVALID_MODE"
  | "INVALID_LIMIT"
  | "INVALID_ID"
  | "INVALID_TYPE"
  | "INVALID_PATH"
  | "INVALID_PARAMETER"
  | "NOTE_TOO_LARGE"
  | "ATTACHMENT_TOO_LARGE"
  | "AUTH_REQUIRED"
  | "AUTH_FAILED";

const APPLICATION_ERROR_CODES: Record<Phase1ErrorCode, number> = {
  INDEX_NOT_FOUND: -32001,
  INDEX_INCOMPATIBLE: -32002,
  PATH_OUTSIDE_VAULT: -32003,
  NOTE_NOT_FOUND: -32004,
  CHUNK_NOT_FOUND: -32005,
  ATTACHMENT_NOT_FOUND: -32006,
  EMBEDDING_UNAVAILABLE: -32007,
  QUERY_TOO_LARGE: -32008,
  ATTACHMENT_NOT_ALLOWED: -32009,
  INTERNAL_ERROR: -32011,
  TIMEOUT: -32012,
  VAULT_NOT_CONFIGURED: -32013,
  INVALID_QUERY: -32000,
  INVALID_MODE: -32000,
  INVALID_LIMIT: -32000,
  INVALID_ID: -32000,
  INVALID_TYPE: -32000,
  INVALID_PATH: -32000,
  INVALID_PARAMETER: -32000,
  NOTE_TOO_LARGE: -32008,
  ATTACHMENT_TOO_LARGE: -32008,
  AUTH_REQUIRED: -32020,
  AUTH_FAILED: -32021,
};

export const ERROR_MESSAGES: Record<Phase1ErrorCode, string> = {
  INDEX_NOT_FOUND: "No usable index found. Run vault-agent index to build one.",
  INDEX_INCOMPATIBLE:
    "Index is incompatible. Run vault-agent reindex to rebuild it.",
  PATH_OUTSIDE_VAULT: "Requested path is outside the vault root.",
  NOTE_NOT_FOUND: "Note not found.",
  CHUNK_NOT_FOUND: "Chunk not found.",
  ATTACHMENT_NOT_FOUND: "Attachment not found.",
  EMBEDDING_UNAVAILABLE: "Embedding provider unavailable.",
  QUERY_TOO_LARGE: "Request exceeds size limit.",
  ATTACHMENT_NOT_ALLOWED: "Attachment not allowed.",
  INTERNAL_ERROR: "Internal server error.",
  TIMEOUT: "Tool invocation timed out.",
  VAULT_NOT_CONFIGURED: "No vault root configured. Set vault.root first.",
  INVALID_QUERY: "Invalid query.",
  INVALID_MODE: "Invalid search mode.",
  INVALID_LIMIT: "Invalid result limit.",
  INVALID_ID: "Invalid ID.",
  INVALID_TYPE: "Invalid type.",
  INVALID_PATH: "Invalid path.",
  INVALID_PARAMETER: "Invalid parameter.",
  NOTE_TOO_LARGE: "Note exceeds size limit.",
  ATTACHMENT_TOO_LARGE: "Attachment exceeds size limit.",
  AUTH_REQUIRED: "Authentication required.",
  AUTH_FAILED: "Authentication failed.",
};

export interface McpApplicationError {
  code: Phase1ErrorCode;
  message: string;
  details?: Record<string, unknown>;
}

export function createMcpError(
  code: Phase1ErrorCode,
  message?: string,
  details?: Record<string, unknown>,
): McpError {
  const resolvedMessage = message ?? ERROR_MESSAGES[code];
  const data: Record<string, unknown> = { errorCode: code };
  if (details !== undefined) {
    data.details = details;
  }
  return new McpError(APPLICATION_ERROR_CODES[code], resolvedMessage, data);
}

export function mcpErrorToApplicationError(
  error: McpError,
): McpApplicationError {
  const data = error.data as Record<string, unknown> | undefined;
  return {
    code: data?.errorCode as Phase1ErrorCode,
    message: error.message,
    details: data?.details as Record<string, unknown> | undefined,
  };
}

export function mcpErrorToJsonRpc(error: McpApplicationError): {
  code: number;
  message: string;
  data?: Record<string, unknown>;
} {
  return {
    code: APPLICATION_ERROR_CODES[error.code],
    message: error.message,
    data: {
      errorCode: error.code,
      ...(error.details ? { details: error.details } : {}),
    },
  };
}

export function isRetrievalSizeErrorCode(
  code: string,
): code is "NOTE_TOO_LARGE" | "ATTACHMENT_TOO_LARGE" {
  return code === "NOTE_TOO_LARGE" || code === "ATTACHMENT_TOO_LARGE";
}

export { McpError, ErrorCode };

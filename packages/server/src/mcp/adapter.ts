import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import {
  Config,
  EmbeddingProvider,
  FreshnessMachine,
  IndexStore,
  SearchMode,
  SearchResult,
  RelatedResult,
  NoteRetrieveResult,
  ChunkRetrieveResult,
  AttachmentMetadataResult,
  WarningItem,
  getAttachmentBytes,
  getAttachmentMetadata,
  getChunk,
  getNote,
  getRelated,
  search,
} from "@vault-agent/core";
import {
  createMcpError,
  McpError,
  Phase1ErrorCode,
  ERROR_MESSAGES,
} from "./errors.js";

export interface McpAdapterContext {
  store: IndexStore | null;
  config: Config;
  embeddingProvider: EmbeddingProvider | null;
  freshnessMachine: FreshnessMachine | null;
}

const MCP_MAX_RESULT_PAYLOAD_BYTES = 50 * 1024 * 1024;
let MCP_TOOL_TIMEOUT_MS = 60_000;

export function setMcpToolTimeoutMs(ms: number): void {
  MCP_TOOL_TIMEOUT_MS = ms;
}

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
};

const tools: Tool[] = [
  {
    name: "search",
    description:
      "Search the vault for notes matching a query. Returns compact ranked results with titles, paths, snippets, and scores. Use this first to find relevant candidates before retrieving full note content.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query text" },
        mode: {
          type: "string",
          enum: ["lexical", "embedding", "hybrid"],
          description: "Search mode",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of results",
        },
      },
      required: ["query"],
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: "get_note",
    description:
      "Retrieve the full content of a note by its ID. Returns Markdown content including frontmatter. Use search first to find relevant notes, then use this to retrieve only the notes you need.",
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "Note ID to retrieve" },
        allowLarge: {
          type: "boolean",
          description: "Allow retrieval of oversized notes",
        },
      },
      required: ["noteId"],
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: "get_chunk",
    description:
      "Retrieve a specific chunk from a note. Chunks are sections of a note split by headings. Use this when you need only a portion of a note rather than the full content.",
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string", description: "Note ID" },
        chunkIndex: {
          type: "integer",
          minimum: 0,
          description: "Chunk index within the note",
        },
      },
      required: ["noteId", "chunkIndex"],
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: "get_attachment",
    description:
      "Retrieve metadata about an attachment file, or download its contents. By default returns only metadata (name, size, MIME type). Set download=true to get the file content as base64-encoded data.",
    inputSchema: {
      type: "object",
      properties: {
        vaultRelativePath: {
          type: "string",
          description: "Vault-relative path to the attachment",
        },
        download: {
          type: "boolean",
          description: "Download file bytes instead of metadata",
        },
        allowLarge: {
          type: "boolean",
          description: "Allow download of oversized files",
        },
      },
      required: ["vaultRelativePath"],
    },
    annotations: readOnlyAnnotations,
  },
  {
    name: "related",
    description:
      "Find notes and chunks that are related to a given note or chunk. Returns compact candidates with titles, paths, snippets, and scores. Use this to discover nearby content after reading a note.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["note", "chunk"],
          description: "Type of input",
        },
        id: { type: "string", description: "Note ID or chunk ID" },
        mode: {
          type: "string",
          enum: ["lexical", "embedding", "hybrid"],
          description: "Retrieval mode",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Maximum number of results",
        },
      },
      required: ["type", "id"],
    },
    annotations: readOnlyAnnotations,
  },
];

export function createMcpServer(context: McpAdapterContext): Server {
  const server = new Server(
    {
      name: "vault-agent",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await withTimeout(
      dispatchTool(context, request.params.name, request.params.arguments),
      MCP_TOOL_TIMEOUT_MS,
    );
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result),
        },
      ],
    };
  });

  return server;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      setTimeout(
        () => reject(createMcpError("TIMEOUT", "Tool invocation timed out.")),
        ms,
      );
    }),
  ]);
}

async function dispatchTool(
  context: McpAdapterContext,
  name: string,
  args: Record<string, unknown> | undefined,
): Promise<Record<string, unknown>> {
  const arguments_ = args ?? {};
  switch (name) {
    case "search":
      return handleSearch(context, arguments_);
    case "get_note":
      return handleGetNote(context, arguments_);
    case "get_chunk":
      return handleGetChunk(context, arguments_);
    case "get_attachment":
      return handleGetAttachment(context, arguments_);
    case "related":
      return handleRelated(context, arguments_);
    default:
      throw createMcpError("INTERNAL_ERROR", `Unknown tool: ${name}`);
  }
}

function ensureContext(context: McpAdapterContext): {
  store: IndexStore;
  config: Config;
  embeddingProvider: EmbeddingProvider | null;
  freshnessMachine: FreshnessMachine | null;
} {
  if (!context.config.vault.root) {
    throw createMcpError("VAULT_NOT_CONFIGURED");
  }
  if (!context.store) {
    throw createMcpError("INDEX_NOT_FOUND");
  }
  return {
    store: context.store,
    config: context.config,
    embeddingProvider: context.embeddingProvider,
    freshnessMachine: context.freshnessMachine,
  };
}

function getFreshnessAndWarnings(freshnessMachine: FreshnessMachine | null): {
  freshness: string;
  warnings: WarningItem[];
} {
  const state = freshnessMachine?.state ?? "unknown";
  const warnings: WarningItem[] = [];
  if (state !== "fresh") {
    warnings.push({
      code: `INDEX_${state.toUpperCase()}`,
      message: `Index is ${state}.`,
    });
  }
  return { freshness: state, warnings };
}

function getStringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw createMcpError("INVALID_ID", `${key} must be a string`);
  }
  return value;
}

function getNumberArg(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw createMcpError("INVALID_LIMIT", `${key} must be a number`);
  }
  return value;
}

function getBooleanArg(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw createMcpError("INVALID_PARAMETER", `${key} must be a boolean`);
  }
  return value;
}

function getEnumArg<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
): T | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw createMcpError(
      "INVALID_MODE",
      `${key} must be one of ${allowed.join(", ")}`,
    );
  }
  return value as T;
}

async function handleSearch(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { store, config, embeddingProvider, freshnessMachine } =
    ensureContext(context);

  const query = getStringArg(args, "query");
  if (!query || query.trim().length === 0 || query.length > 1000) {
    throw createMcpError(
      "INVALID_QUERY",
      "Query must be 1-1000 non-whitespace characters.",
    );
  }
  const mode = getEnumArg(args, "mode", [
    "lexical",
    "embedding",
    "hybrid",
  ] as const);
  const limit = getNumberArg(args, "limit");
  if (
    limit !== undefined &&
    (limit < 1 || limit > 50 || !Number.isInteger(limit))
  ) {
    throw createMcpError(
      "INVALID_LIMIT",
      "limit must be an integer between 1 and 50.",
    );
  }

  const incompatible = checkIncompatibleIndex(store, config);
  if (incompatible) {
    throw createMcpError("INDEX_INCOMPATIBLE", incompatible.message);
  }

  const { freshness, warnings } = getFreshnessAndWarnings(freshnessMachine);

  try {
    const result: SearchResult = await search(
      store,
      query,
      mode as SearchMode | undefined,
      limit ?? 10,
      config,
      embeddingProvider ?? undefined,
    );
    return {
      requestedMode: result.requestedMode,
      usedMode: result.usedMode,
      limit: result.limit,
      freshness,
      results: result.results,
      warnings: [...warnings, ...result.warnings],
    };
  } catch (error) {
    throw mapSearchError(error);
  }
}

async function handleGetNote(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { store, config, freshnessMachine } = ensureContext(context);

  const noteId = getStringArg(args, "noteId");
  if (!noteId) {
    throw createMcpError("INVALID_ID", "noteId is required.");
  }
  const allowLarge = getBooleanArg(args, "allowLarge");

  const safeResolution = checkSafeResolution(store, config);
  if (safeResolution.blocked) {
    throw createMcpError("INDEX_INCOMPATIBLE", safeResolution.message);
  }

  try {
    const result: NoteRetrieveResult | null = await getNote(
      store,
      noteId,
      config.vault.root,
      allowLarge,
    );
    if (!result) {
      throw createMcpError("NOTE_NOT_FOUND");
    }
    const { freshness, warnings } = getFreshnessAndWarnings(freshnessMachine);
    return { ...result, freshness, warnings };
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw mapRetrievalError(error);
  }
}

async function handleGetChunk(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { store, config, freshnessMachine } = ensureContext(context);

  const noteId = getStringArg(args, "noteId");
  if (!noteId) {
    throw createMcpError("INVALID_ID", "noteId is required.");
  }
  const chunkIndex = getNumberArg(args, "chunkIndex");
  if (
    chunkIndex === undefined ||
    chunkIndex < 0 ||
    !Number.isInteger(chunkIndex)
  ) {
    throw createMcpError(
      "INVALID_ID",
      "chunkIndex must be a non-negative integer.",
    );
  }

  const safeResolution = checkSafeResolution(store, config);
  if (safeResolution.blocked) {
    throw createMcpError("INDEX_INCOMPATIBLE", safeResolution.message);
  }

  try {
    const result: ChunkRetrieveResult | null = await getChunk(
      store,
      noteId,
      chunkIndex,
    );
    if (!result) {
      throw createMcpError("CHUNK_NOT_FOUND");
    }
    const { freshness, warnings } = getFreshnessAndWarnings(freshnessMachine);
    return { ...result, freshness, warnings };
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw mapRetrievalError(error);
  }
}

async function handleGetAttachment(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { config } = ensureContext(context);

  const vaultRelativePath = getStringArg(args, "vaultRelativePath");
  if (!vaultRelativePath) {
    throw createMcpError("INVALID_PATH", "vaultRelativePath is required.");
  }
  const download = getBooleanArg(args, "download");
  const allowLarge = getBooleanArg(args, "allowLarge");

  if (vaultRelativePath.includes("..") || vaultRelativePath.includes("\0")) {
    throw createMcpError("INVALID_PATH");
  }

  const metadata: AttachmentMetadataResult | null = await getAttachmentMetadata(
    config.vault.root,
    vaultRelativePath,
    config.vault.exclude,
  );

  if (!metadata) {
    throw createMcpError("ATTACHMENT_NOT_ALLOWED");
  }

  if (!download) {
    return { ...metadata, warnings: [] };
  }

  try {
    const bytesResult = await getAttachmentBytes(
      config.vault.root,
      vaultRelativePath,
      allowLarge,
      config.vault.exclude,
    );

    if (!bytesResult) {
      throw createMcpError("ATTACHMENT_NOT_FOUND");
    }

    const base64Content = bytesResult.bytes.toString("base64");
    const payloadSizeEstimate = Buffer.byteLength(
      JSON.stringify({ ...metadata, content: base64Content }),
      "utf8",
    );
    if (payloadSizeEstimate > MCP_MAX_RESULT_PAYLOAD_BYTES) {
      throw createMcpError(
        "QUERY_TOO_LARGE",
        "Attachment would exceed MCP transport size limit. Use the HTTP API instead.",
      );
    }

    return {
      ...metadata,
      content: base64Content,
      encoding: "base64",
      warnings: [],
    };
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw mapRetrievalError(error);
  }
}

async function handleRelated(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { store, config, embeddingProvider, freshnessMachine } =
    ensureContext(context);

  const type = getEnumArg(args, "type", ["note", "chunk"] as const);
  if (!type) {
    throw createMcpError("INVALID_TYPE", "type is required.");
  }
  const id = getStringArg(args, "id");
  if (!id) {
    throw createMcpError("INVALID_ID", "id is required.");
  }
  const mode = getEnumArg(args, "mode", [
    "lexical",
    "embedding",
    "hybrid",
  ] as const);
  const limit = getNumberArg(args, "limit");
  if (
    limit !== undefined &&
    (limit < 1 || limit > 50 || !Number.isInteger(limit))
  ) {
    throw createMcpError(
      "INVALID_LIMIT",
      "limit must be an integer between 1 and 50.",
    );
  }

  const incompatible = checkIncompatibleIndex(store, config);
  if (incompatible) {
    throw createMcpError("INDEX_INCOMPATIBLE", incompatible.message);
  }

  const { freshness, warnings } = getFreshnessAndWarnings(freshnessMachine);

  try {
    const result: RelatedResult = await getRelated(
      store,
      type,
      id,
      mode as SearchMode | undefined,
      limit ?? 10,
      config,
      embeddingProvider ?? undefined,
    );
    return {
      input: result.input,
      requestedMode: result.requestedMode,
      usedMode: result.usedMode,
      limit: result.limit,
      freshness,
      results: result.results,
      warnings: [...warnings, ...result.warnings],
    };
  } catch (error) {
    throw mapSearchError(error);
  }
}

function checkIncompatibleIndex(
  store: IndexStore,
  config: Config,
): { message: string } | null {
  const staleness = store.checkStaleness(config);
  if (staleness.incompatible) {
    return {
      message: `${staleness.details}. Run vault-agent reindex to rebuild the index.`,
    };
  }
  return null;
}

function checkSafeResolution(
  store: IndexStore,
  config: Config,
): { blocked: true; message: string } | { blocked: false } {
  const staleness = store.checkStaleness(config);
  if (staleness.incompatible) {
    return {
      blocked: true,
      message: `${staleness.details}. Run vault-agent reindex to rebuild the index.`,
    };
  }
  return { blocked: false };
}

function mapSearchError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    const message =
      (error as { message?: string }).message ??
      ERROR_MESSAGES[code as Phase1ErrorCode] ??
      "Search failed.";
    if (isKnownErrorCode(code)) {
      return createMcpError(code as Phase1ErrorCode, message);
    }
  }
  return createMcpError("INTERNAL_ERROR", getErrorMessage(error));
}

function mapRetrievalError(error: unknown): McpError {
  if (error instanceof McpError) return error;
  if (error && typeof error === "object" && "code" in error) {
    const code = String((error as { code: unknown }).code);
    const message =
      (error as { message?: string }).message ??
      ERROR_MESSAGES[code as Phase1ErrorCode] ??
      "Retrieval failed.";
    if (code === "NOTE_TOO_LARGE" || code === "ATTACHMENT_TOO_LARGE") {
      return createMcpError(
        "QUERY_TOO_LARGE",
        message,
        (error as { details?: Record<string, unknown> }).details,
      );
    }
    if (code === "PATH_OUTSIDE_VAULT") {
      return createMcpError("PATH_OUTSIDE_VAULT", message);
    }
    if (code === "INVALID_PATH") {
      return createMcpError("INVALID_PATH", message);
    }
    if (isKnownErrorCode(code)) {
      return createMcpError(code as Phase1ErrorCode, message);
    }
  }
  return createMcpError("INTERNAL_ERROR", getErrorMessage(error));
}

function isKnownErrorCode(code: string): code is Phase1ErrorCode {
  return code in ERROR_MESSAGES;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

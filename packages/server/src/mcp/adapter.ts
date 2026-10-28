import { tools } from "./tool-definitions.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  InitializeRequestSchema,
  ListToolsRequestSchema,
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
  SearchFiltersInput,
  getAttachmentBytes,
  getAttachmentMetadata,
  getAgentGuidance,
  getChunk,
  listAgentGuidance,
  getNote,
  getRelated,
  search,
  getOverview,
  getTree,
  getTags,
  getFacets,
  getBacklinks,
  getBrokenLinks,
  getLinkSummary,
  getMetadataProfile,
  getNoteLinks,
  getOrphanNotes,
  getStyleProfile,
  type AgentGuidanceRetrieveResult,
  type LinkGraphContext,
  type OrientationContext,
  type ProfileContext,
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

const SUPPORTED_PROTOCOL_VERSIONS: readonly string[] = ["2025-03-26"];
const LATEST_PROTOCOL_VERSION: string = "2025-03-26";

export function setMcpToolTimeoutMs(ms: number): void {
  MCP_TOOL_TIMEOUT_MS = ms;
}

const NOTE_ID_PATTERN = /^[0-9a-f]{32}$/;

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

  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    const requestedVersion = request.params.protocolVersion;
    if (!requestedVersion) {
      throw new McpError(-32600, "Missing MCP protocol version");
    }
    // Delegate to the SDK's default initialize handler so that client
    // capabilities and version are recorded, then override only the negotiated
    // protocol version to enforce vault-agent's supported-version contract.
    const sdkResult = await (
      server as unknown as {
        _oninitialize(request: unknown): Promise<{
          protocolVersion: string;
          capabilities: Record<string, unknown>;
          serverInfo: { name: string; version: string };
        }>;
      }
    )._oninitialize(request);
    const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.includes(
      requestedVersion,
    )
      ? requestedVersion
      : LATEST_PROTOCOL_VERSION;
    return { ...sdkResult, protocolVersion };
  });

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
    case "vault_overview":
      return handleVaultOverview(context, arguments_);
    case "vault_tree":
      return handleVaultTree(context, arguments_);
    case "vault_tags":
      return handleVaultTags(context, arguments_);
    case "vault_facets":
      return handleVaultFacets(context, arguments_);
    case "vault_guidance_list":
      return handleVaultGuidanceList(context);
    case "vault_guidance_get":
      return handleVaultGuidanceGet(context, arguments_);
    case "vault_links":
      return handleVaultLinks(context, arguments_);
    case "vault_backlinks":
      return handleVaultBacklinks(context, arguments_);
    case "vault_broken_links":
      return handleVaultBrokenLinks(context, arguments_);
    case "vault_orphans":
      return handleVaultOrphans(context, arguments_);
    case "vault_link_summary":
      return handleVaultLinkSummary(context, arguments_);
    case "vault_metadata_profile":
      return handleVaultMetadataProfile(context, arguments_);
    case "vault_style_profile":
      return handleVaultStyleProfile(context, arguments_);
    default:
      throw createMcpError("INTERNAL_ERROR", `Unknown tool: ${name}`);
  }
}

function ensureConfig(context: McpAdapterContext): Config {
  if (!context.config.vault.root) {
    throw createMcpError("VAULT_NOT_CONFIGURED");
  }
  return context.config;
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

function makeLinkGraphContext(context: McpAdapterContext): LinkGraphContext {
  const { store, config, freshnessMachine } = ensureContext(context);
  return { store, config, freshnessMachine };
}

function makeProfileContext(context: McpAdapterContext): ProfileContext {
  const { store, config, freshnessMachine } = ensureContext(context);
  return { store, config, freshnessMachine };
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
  errorCode: Phase1ErrorCode = "INVALID_LIMIT",
): number | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (typeof value !== "number") {
    throw createMcpError(errorCode, `${key} must be a number`);
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

function getSearchFiltersArg(
  args: Record<string, unknown>,
): SearchFiltersInput | undefined {
  const raw = args.filters;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw createMcpError("INVALID_FILTER", "filters must be an object.");
  }

  const filters = raw as Record<string, unknown>;
  const allowed = new Set([
    "path_prefix",
    "exclude_path_prefix",
    "tags",
    "exclude_tags",
    "frontmatter",
  ]);
  for (const key of Object.keys(filters)) {
    if (!allowed.has(key)) {
      throw createMcpError("INVALID_FILTER", `Unknown filter: ${key}`);
    }
  }

  const result: SearchFiltersInput = {};
  const pathPrefix = getStringArrayFilter(filters, "path_prefix");
  const excludePathPrefix = getStringArrayFilter(
    filters,
    "exclude_path_prefix",
  );
  const tags = getStringArrayFilter(filters, "tags");
  const excludeTags = getStringArrayFilter(filters, "exclude_tags");

  if (pathPrefix) result.pathPrefix = pathPrefix;
  if (excludePathPrefix) result.excludePathPrefix = excludePathPrefix;
  if (tags) result.tags = tags;
  if (excludeTags) result.excludeTags = excludeTags;

  if (filters.frontmatter !== undefined) {
    const rawFrontmatter = filters.frontmatter;
    if (
      !rawFrontmatter ||
      typeof rawFrontmatter !== "object" ||
      Array.isArray(rawFrontmatter)
    ) {
      throw createMcpError(
        "INVALID_FRONTMATTER_FILTER",
        "frontmatter must be an object.",
      );
    }
    const frontmatter = rawFrontmatter as Record<string, unknown>;
    for (const key of Object.keys(frontmatter)) {
      if (key !== "type" && key !== "status") {
        throw createMcpError(
          "INVALID_FRONTMATTER_FILTER",
          "Frontmatter filters support only type and status.",
        );
      }
    }
    const type = getStringArrayFilter(frontmatter, "type");
    const status = getStringArrayFilter(frontmatter, "status");
    if (!type && !status) {
      throw createMcpError(
        "INVALID_FRONTMATTER_FILTER",
        "frontmatter must include type or status.",
      );
    }
    result.frontmatter = {};
    if (type) result.frontmatter.type = type;
    if (status) result.frontmatter.status = status;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function getStringArrayFilter(
  args: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = args[key];
  if (value === undefined) return undefined;
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((item) => typeof item === "string")
  ) {
    throw createMcpError(
      key === "type" || key === "status"
        ? "INVALID_FRONTMATTER_FILTER"
        : "INVALID_FILTER",
      `${key} must be a non-empty string array.`,
    );
  }
  return value as string[];
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
  const filters = getSearchFiltersArg(args);

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
      filters,
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

async function handleVaultOverview(
  context: McpAdapterContext,
  _args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { store, config, freshnessMachine } = ensureContext(context);

  const incompatible = checkIncompatibleIndex(store, config);
  if (incompatible) {
    throw createMcpError("INDEX_INCOMPATIBLE", incompatible.message);
  }

  const ctx: OrientationContext = {
    store,
    config,
    freshnessMachine,
  };

  try {
    const result = getOverview(ctx);
    return {
      ...result.data,
      warnings: result.warnings,
    };
  } catch (error) {
    throw mapSearchError(error);
  }
}

async function handleVaultTree(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { store, config, freshnessMachine } = ensureContext(context);

  const incompatible = checkIncompatibleIndex(store, config);
  if (incompatible) {
    throw createMcpError("INDEX_INCOMPATIBLE", incompatible.message);
  }

  const depth = getNumberArg(args, "depth", "INVALID_PARAMETER");
  if (
    depth !== undefined &&
    (depth < 1 || depth > 10 || !Number.isInteger(depth))
  ) {
    throw createMcpError(
      "INVALID_PARAMETER",
      "depth must be an integer between 1 and 10.",
    );
  }

  const limit = getNumberArg(args, "limit", "INVALID_PARAMETER");
  if (
    limit !== undefined &&
    (limit < 1 || limit > 500 || !Number.isInteger(limit))
  ) {
    throw createMcpError(
      "INVALID_PARAMETER",
      "limit must be an integer between 1 and 500.",
    );
  }

  const directOnly = getBooleanArg(args, "direct_only") ?? false;

  const ctx: OrientationContext = {
    store,
    config,
    freshnessMachine,
  };

  try {
    const result = getTree(ctx, { depth, limit, directOnly });
    return {
      ...result.data,
      warnings: result.warnings,
    };
  } catch (error) {
    throw mapSearchError(error);
  }
}

async function handleVaultTags(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { store, config, freshnessMachine } = ensureContext(context);

  const incompatible = checkIncompatibleIndex(store, config);
  if (incompatible) {
    throw createMcpError("INDEX_INCOMPATIBLE", incompatible.message);
  }

  const limit = getNumberArg(args, "limit", "INVALID_PARAMETER");
  if (
    limit !== undefined &&
    (limit < 1 || limit > 200 || !Number.isInteger(limit))
  ) {
    throw createMcpError(
      "INVALID_PARAMETER",
      "limit must be an integer between 1 and 200.",
    );
  }

  const ctx: OrientationContext = {
    store,
    config,
    freshnessMachine,
  };

  try {
    const result = getTags(ctx, { limit });
    return {
      ...result.data,
      warnings: result.warnings,
    };
  } catch (error) {
    throw mapSearchError(error);
  }
}

async function handleVaultFacets(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { store, config, freshnessMachine } = ensureContext(context);

  const incompatible = checkIncompatibleIndex(store, config);
  if (incompatible) {
    throw createMcpError("INDEX_INCOMPATIBLE", incompatible.message);
  }

  const limit = getNumberArg(args, "limit", "INVALID_PARAMETER");
  if (
    limit !== undefined &&
    (limit < 1 || limit > 200 || !Number.isInteger(limit))
  ) {
    throw createMcpError(
      "INVALID_PARAMETER",
      "limit must be an integer between 1 and 200.",
    );
  }

  const ctx: OrientationContext = {
    store,
    config,
    freshnessMachine,
  };

  try {
    const result = getFacets(ctx, { limit });
    return {
      ...result.data,
      warnings: result.warnings,
    };
  } catch (error) {
    throw mapSearchError(error);
  }
}

async function handleVaultGuidanceList(
  context: McpAdapterContext,
): Promise<Record<string, unknown>> {
  const config = ensureConfig(context);

  try {
    const result = listAgentGuidance(config.vault.root, config.vault.exclude);
    return {
      ...result,
      warnings: [],
    };
  } catch (error) {
    throw mapRetrievalError(error);
  }
}

async function handleVaultGuidanceGet(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const config = ensureConfig(context);

  const guidancePath = getStringArg(args, "path");
  if (!guidancePath) {
    throw createMcpError("INVALID_PATH", "path is required.");
  }
  const allowLarge = getBooleanArg(args, "allowLarge");

  try {
    const result: AgentGuidanceRetrieveResult | null = getAgentGuidance(
      config.vault.root,
      guidancePath,
      allowLarge,
      config.vault.exclude,
    );
    if (!result) {
      throw createMcpError("GUIDANCE_NOT_FOUND");
    }
    return {
      ...result,
      warnings: [],
    };
  } catch (error) {
    if (error instanceof McpError) throw error;
    throw mapRetrievalError(error);
  }
}

async function handleVaultLinks(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const noteId = getStringArg(args, "noteId");
  if (!noteId || !NOTE_ID_PATTERN.test(noteId)) {
    throw createMcpError("INVALID_ID", "noteId must be a valid note ID.");
  }

  try {
    const result = getNoteLinks(makeLinkGraphContext(context), noteId);
    return { ...result.data, warnings: result.warnings };
  } catch (error) {
    throw mapSearchError(error);
  }
}

async function handleVaultBacklinks(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const noteId = getStringArg(args, "noteId");
  if (!noteId || !NOTE_ID_PATTERN.test(noteId)) {
    throw createMcpError("INVALID_ID", "noteId must be a valid note ID.");
  }

  try {
    const result = getBacklinks(makeLinkGraphContext(context), noteId);
    return { ...result.data, warnings: result.warnings };
  } catch (error) {
    throw mapSearchError(error);
  }
}

async function handleVaultBrokenLinks(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const limit = getNumberArg(args, "limit", "INVALID_PARAMETER");
  if (
    limit !== undefined &&
    (limit < 1 || limit > 500 || !Number.isInteger(limit))
  ) {
    throw createMcpError(
      "INVALID_PARAMETER",
      "limit must be an integer between 1 and 500.",
    );
  }

  try {
    const result = getBrokenLinks(makeLinkGraphContext(context), { limit });
    return { ...result.data, warnings: result.warnings };
  } catch (error) {
    throw mapSearchError(error);
  }
}

async function handleVaultOrphans(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const limit = getNumberArg(args, "limit", "INVALID_PARAMETER");
  if (
    limit !== undefined &&
    (limit < 1 || limit > 500 || !Number.isInteger(limit))
  ) {
    throw createMcpError(
      "INVALID_PARAMETER",
      "limit must be an integer between 1 and 500.",
    );
  }

  try {
    const result = getOrphanNotes(makeLinkGraphContext(context), { limit });
    return { ...result.data, warnings: result.warnings };
  } catch (error) {
    throw mapSearchError(error);
  }
}

async function handleVaultLinkSummary(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const limit = getNumberArg(args, "limit", "INVALID_PARAMETER");
  if (
    limit !== undefined &&
    (limit < 1 || limit > 100 || !Number.isInteger(limit))
  ) {
    throw createMcpError(
      "INVALID_PARAMETER",
      "limit must be an integer between 1 and 100.",
    );
  }
  const pathPrefix = getStringArg(args, "path_prefix");

  try {
    const result = getLinkSummary(makeLinkGraphContext(context), {
      limit,
      pathPrefix,
    });
    return { ...result.data, warnings: result.warnings };
  } catch (error) {
    throw mapSearchError(error);
  }
}

async function handleVaultMetadataProfile(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const params = getProfileParams(args);

  try {
    const result = getMetadataProfile(makeProfileContext(context), params);
    return { ...result.data, warnings: result.warnings };
  } catch (error) {
    throw mapSearchError(error);
  }
}

async function handleVaultStyleProfile(
  context: McpAdapterContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const params = getProfileParams(args);

  try {
    const result = getStyleProfile(makeProfileContext(context), params);
    return { ...result.data, warnings: result.warnings };
  } catch (error) {
    throw mapSearchError(error);
  }
}

function getProfileParams(args: Record<string, unknown>): {
  limit?: number;
  pathPrefix?: string;
  filters?: {
    tags?: string[];
    frontmatter?: {
      type?: string[];
      status?: string[];
    };
    noteIds?: string[];
  };
  exampleSelection?: "path" | "representative";
} {
  const limit = getNumberArg(args, "limit", "INVALID_PARAMETER");
  if (
    limit !== undefined &&
    (limit < 1 || limit > 100 || !Number.isInteger(limit))
  ) {
    throw createMcpError(
      "INVALID_PARAMETER",
      "limit must be an integer between 1 and 100.",
    );
  }
  const pathPrefix = getStringArg(args, "path_prefix");
  const exampleSelection = getEnumArg(args, "example_selection", [
    "path",
    "representative",
  ] as const);
  const filters = getProfileFiltersArg(args);
  return { limit, pathPrefix, filters, exampleSelection };
}

function getProfileFiltersArg(args: Record<string, unknown>):
  | {
      tags?: string[];
      frontmatter?: {
        type?: string[];
        status?: string[];
      };
      noteIds?: string[];
    }
  | undefined {
  const raw = args.filters;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw createMcpError("INVALID_FILTER", "filters must be an object.");
  }

  const filters = raw as Record<string, unknown>;
  const result: {
    tags?: string[];
    frontmatter?: { type?: string[]; status?: string[] };
    noteIds?: string[];
  } = {};

  const tags = getStringArrayFilter(filters, "tags");
  if (tags) result.tags = tags;

  const noteIds = getStringArrayFilter(filters, "note_ids");
  if (noteIds) result.noteIds = noteIds;

  if (filters.frontmatter !== undefined) {
    const rawFrontmatter = filters.frontmatter;
    if (
      !rawFrontmatter ||
      typeof rawFrontmatter !== "object" ||
      Array.isArray(rawFrontmatter)
    ) {
      throw createMcpError(
        "INVALID_FRONTMATTER_FILTER",
        "frontmatter must be an object.",
      );
    }
    const frontmatter = rawFrontmatter as Record<string, unknown>;
    const type = getStringArrayFilter(frontmatter, "type");
    const status = getStringArrayFilter(frontmatter, "status");
    if (type || status) {
      result.frontmatter = {};
      if (type) result.frontmatter.type = type;
      if (status) result.frontmatter.status = status;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
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
    if (
      code === "NOTE_TOO_LARGE" ||
      code === "ATTACHMENT_TOO_LARGE" ||
      code === "GUIDANCE_TOO_LARGE"
    ) {
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

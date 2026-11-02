import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/cfworker-provider.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { tools as localTools } from "../../server/src/mcp/tool-definitions.js";
import { RetrievalService } from "./service.js";
import { CloudError, boundedBytes } from "./errors.js";
import {
  SearchError,
  SourceError,
  RetrievalSizeError,
} from "@vault-agent/core/portable";
import type { Env } from "./config.js";
import { config } from "./config.js";
import {
  MUTATION_NAMES,
  MCP_WRITE_REQUEST_BYTES,
  mutationTools,
} from "../../server/src/mcp/mutation-tool-definitions.js";
import { R2MutationService } from "./mutations.js";
import {
  MutationError,
  previewChangesSchema,
  applyChangesSchema,
  changeStatusSchema,
} from "@vault-agent/core/portable";
import type { AccessRole } from "@vault-agent/core/access";
const MAX_OUTPUT = 50 * 1024 * 1024;
const explicit = new Set([
  "get_note",
  "get_chunk",
  "get_attachment",
  "vault_guidance_get",
]);
const tools = localTools.map((tool) =>
  explicit.has(tool.name)
    ? {
        ...tool,
        inputSchema: {
          ...tool.inputSchema,
          properties: {
            ...tool.inputSchema.properties,
            snapshot: {
              type: "string" as const,
              description: "Pin the active search snapshot.",
            },
          },
        },
      }
    : tool,
);
function toolsFor(env: Env, role: AccessRole) {
  const enabled = config(env).write.enabled;
  const readTools = tools.map((tool) =>
    enabled && tool.name === "get_chunk"
      ? {
          ...tool,
          inputSchema: {
            ...tool.inputSchema,
            required: [
              ...(tool.inputSchema.required ?? []),
              "expected_version",
            ],
          },
        }
      : tool,
  );
  return enabled && role === "admin"
    ? [
        ...readTools,
        ...mutationTools.map((tool) => ({
          ...tool,
          description: tool.description?.replace(
            "External edits in the last version-check/save window may be missed.",
            "R2 compares generation immediately before an ETag-conditional save. Same-byte generation changes after that check may be missed; an in-flight storage request cannot be recalled.",
          ),
        })),
      ]
    : readTools;
}
async function change(
  env: Env,
  name: string,
  args: Record<string, unknown>,
  role: AccessRole,
) {
  try {
    const settings = config(env).write;
    if (!settings.enabled) throw new CloudError("WRITE_DISABLED", 403);
    if (role !== "admin") throw new CloudError("ADMIN_REQUIRED", 403);
    const service = await R2MutationService.open(env, { settings });
    if (name === "preview_changes") {
      const p = previewChangesSchema.safeParse(args);
      if (!p.success) throw new CloudError("INVALID_REQUEST");
      if (!p.data.preview && settings.mode === "review")
        throw new CloudError("PREVIEW_REQUIRED", 409);
      return await service.preview(
        { operations: p.data.operations },
        p.data.preview,
      );
    }
    if (name === "apply_changes") {
      const p = applyChangesSchema.safeParse(args);
      if (!p.success) throw new CloudError("INVALID_REQUEST");
      return await service.apply(
        p.data.operation_id,
        { operations: p.data.operations },
        p.data.preview_binding,
      );
    }
    const p = changeStatusSchema.safeParse(args);
    if (!p.success) throw new CloudError("INVALID_REQUEST");
    return await service.status(p.data.operation_id);
  } catch (error) {
    throw new McpError(-32040, "Vault change failed.", {
      errorCode:
        error instanceof CloudError || error instanceof MutationError
          ? error.code
          : "SOURCE_UNAVAILABLE",
    });
  }
}
const errorCodes: Record<string, number> = {
  INDEX_NOT_FOUND: -32001,
  INDEX_INCOMPATIBLE: -32002,
  PATH_OUTSIDE_VAULT: -32003,
  NOTE_NOT_FOUND: -32004,
  CHUNK_NOT_FOUND: -32005,
  ATTACHMENT_NOT_FOUND: -32006,
  GUIDANCE_NOT_FOUND: -32006,
  EMBEDDING_UNAVAILABLE: -32007,
  QUERY_TOO_LARGE: -32008,
  NOTE_TOO_LARGE: -32008,
  ATTACHMENT_TOO_LARGE: -32008,
  GUIDANCE_TOO_LARGE: -32008,
  ATTACHMENT_NOT_ALLOWED: -32009,
  INTERNAL_ERROR: -32011,
  TIMEOUT: -32012,
};
function mapped(args: Record<string, unknown>) {
  const filters = args.filters as Record<string, unknown> | undefined;
  const mappedFilters = filters ? { ...filters } : undefined;
  if (mappedFilters)
    for (const key of ["path_prefix", "exclude_path_prefix", "exclude_tags"])
      delete mappedFilters[key];
  return {
    ...args,
    path: args.vaultRelativePath ?? args.path,
    pathPrefix: args.path_prefix,
    directOnly:
      args.direct_only === undefined ? undefined : String(args.direct_only),
    exampleSelection: args.example_selection,
    ...(filters && {
      filters: {
        ...mappedFilters,
        pathPrefix: filters.path_prefix,
        excludePathPrefix: filters.exclude_path_prefix,
        tags: filters.tags,
        excludeTags: filters.exclude_tags,
        frontmatter: filters.frontmatter,
      },
      tag: filters.tags,
      frontmatterType: (
        filters.frontmatter as Record<string, unknown> | undefined
      )?.type,
      frontmatterStatus: (
        filters.frontmatter as Record<string, unknown> | undefined
      )?.status,
      noteId: filters.note_ids,
    }),
  };
}
async function call(
  env: Env,
  name: string,
  args: Record<string, unknown>,
  role: AccessRole,
) {
  if (MUTATION_NAMES.has(name)) {
    const data = await change(env, name, args, role);
    return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
  }
  const tool = toolsFor(env, role).find((t) => t.name === name);
  if (!tool) throw new McpError(-32602, "Unknown tool.");
  const invalid = (code: string): never => {
    throw new McpError(errorCodes[code] ?? -32000, "Invalid tool arguments.", {
      errorCode: code,
    });
  };
  if (
    name === "search" &&
    (typeof args.query !== "string" ||
      !args.query.trim() ||
      args.query.length > 1000)
  )
    invalid("INVALID_QUERY");
  if (["search", "related"].includes(name)) {
    if (
      args.limit !== undefined &&
      (typeof args.limit !== "number" ||
        !Number.isInteger(args.limit) ||
        args.limit < 1 ||
        args.limit > 50)
    )
      invalid("INVALID_LIMIT");
    if (
      args.mode !== undefined &&
      !["lexical", "embedding", "hybrid"].includes(String(args.mode))
    )
      invalid("INVALID_MODE");
  }
  if (
    ["get_note", "get_chunk", "vault_links", "vault_backlinks"].includes(
      name,
    ) &&
    (typeof args.noteId !== "string" || !/^[a-f0-9]{32}$/.test(args.noteId))
  )
    invalid("INVALID_ID");
  if (
    name === "get_chunk" &&
    (typeof args.chunkIndex !== "number" ||
      !Number.isSafeInteger(args.chunkIndex) ||
      args.chunkIndex < 0)
  )
    invalid("INVALID_ID");
  const validator = new CfWorkerJsonSchemaValidator().getValidator(
    tool.inputSchema,
  );
  if (!validator(args).valid)
    throw new McpError(-32000, "Invalid tool arguments.", {
      errorCode: "INVALID_PARAMETER",
    });
  try {
    const service = await RetrievalService.open(env, {
      allowUnindexed: ["get_note", "get_attachment"].includes(name),
    });
    const result = await service.invoke(name, mapped(args));
    let data = result.data;
    if (name === "get_attachment" && args.download) {
      const download = data as {
        stream: ReadableStream<Uint8Array>;
        contentType: string;
        fileName: string;
        version?: string;
      };
      const bytes = await boundedBytes(
        download.stream,
        Math.floor((MAX_OUTPUT * 3) / 4) - 4096,
      );
      const pieces: string[] = [];
      for (let i = 0; i < bytes.length; i += 16384)
        pieces.push(String.fromCharCode(...bytes.subarray(i, i + 16384)));
      data = {
        fileName: download.fileName,
        contentType: download.contentType,
        path: args.vaultRelativePath,
        downloadAvailable: true,
        size: bytes.length,
        content: btoa(pieces.join("")),
        encoding: "base64",
        ...(download.version ? { version: download.version } : {}),
      };
    }
    await service.current();
    const payload = {
      ...(data as object),
      ...(["search", "related", "get_note", "get_chunk"].includes(name)
        ? {
            freshness: result.warnings.some((w) => w.code === "INDEX_UPDATING")
              ? "updating"
              : result.warnings.some((w) => w.code === "INDEX_STALE")
                ? "stale"
                : result.warnings.some(
                      (w) => w.code === "INDEX_FRESHNESS_UNKNOWN",
                    )
                  ? "unknown"
                  : "fresh",
          }
        : {}),
      warnings: result.warnings,
      ...(result.usage ? { usage: result.usage } : {}),
      revision: service.revision(),
    };
    const text = JSON.stringify(payload);
    if (new TextEncoder().encode(text).length > MAX_OUTPUT)
      throw new CloudError("QUERY_TOO_LARGE", 413);
    return { content: [{ type: "text" as const, text }] };
  } catch (error) {
    const code =
      error instanceof CloudError ||
      error instanceof SearchError ||
      error instanceof SourceError ||
      error instanceof RetrievalSizeError
        ? error.code
        : "INTERNAL_ERROR";
    throw new McpError(
      errorCodes[code] ?? -32000,
      "The operation could not be completed.",
      { errorCode: code },
    );
  }
}
async function single(
  request: Request,
  env: Env,
  body: unknown,
  role: AccessRole,
) {
  const validator = new CfWorkerJsonSchemaValidator();
  const server = new Server(
    { name: "vault-agent", version: "0.1.0" },
    { capabilities: { tools: {} }, jsonSchemaValidator: validator },
  );
  server.setRequestHandler(InitializeRequestSchema, async (request) => {
    if (!request.params.protocolVersion)
      throw new McpError(-32600, "Missing MCP protocol version.");
    return {
      protocolVersion: "2025-03-26",
      capabilities: { tools: {} },
      serverInfo: { name: "vault-agent", version: "0.1.0" },
    };
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolsFor(env, role),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    call(env, request.params.name, request.params.arguments ?? {}, role),
  );
  const transport = new WebStandardStreamableHTTPServerTransport({
    enableJsonResponse: true,
    maxRequestBodySize:
      config(env).write.enabled && role === "admin"
        ? MCP_WRITE_REQUEST_BYTES
        : 65536,
  });
  await server.connect(transport);
  try {
    const response = await transport.handleRequest(request, {
      parsedBody: body,
    });
    // Consume before closing the per-request transport; never retain sessions.
    const bytes = await boundedBytes(
      response.body ??
        new ReadableStream({
          start(c) {
            c.close();
          },
        }),
      MAX_OUTPUT,
    );
    if (
      bytes.length &&
      response.headers.get("Content-Type")?.includes("application/json")
    ) {
      const result = JSON.parse(new TextDecoder().decode(bytes));
      if (result.error)
        result.error = {
          code: result.error.code,
          message: "The operation could not be completed.",
          ...(result.error.data?.errorCode
            ? { data: { errorCode: result.error.data.errorCode } }
            : {}),
        };
      return Response.json(result, {
        status: response.status,
        headers: response.headers,
      });
    }
    return new Response(bytes.length ? bytes : null, {
      status: response.status,
      headers: response.headers,
    });
  } finally {
    await server.close();
  }
}
export async function mcp(
  request: Request,
  env: Env,
  body: unknown,
  role: AccessRole,
) {
  const messages = Array.isArray(body) ? body : [body];
  // Authorization precedes every message, including earlier reads in a batch.
  if (
    messages.some(
      (value) =>
        value &&
        typeof value === "object" &&
        "method" in value &&
        value.method === "tools/call" &&
        "params" in value &&
        value.params &&
        typeof value.params === "object" &&
        "name" in value.params &&
        typeof value.params.name === "string" &&
        MUTATION_NAMES.has(value.params.name),
    )
  ) {
    if (!config(env).write.enabled) throw new CloudError("WRITE_DISABLED", 403);
    if (role !== "admin") throw new CloudError("ADMIN_REQUIRED", 403);
  }
  if (!Array.isArray(body)) return single(request, env, body, role);
  if (!body.length || body.length > 10)
    return Response.json(
      {
        jsonrpc: "2.0",
        id: null,
        error: { code: -32600, message: "Invalid batch." },
      },
      { status: 400 },
    );
  const replies: unknown[] = [];
  let size = 2;
  for (const message of body) {
    const response = await single(request, env, message, role);
    if (response.status !== 202 && response.body) {
      const text = await response.text();
      size += new TextEncoder().encode(text).length + (replies.length ? 1 : 0);
      if (size > MAX_OUTPUT) throw new CloudError("QUERY_TOO_LARGE", 413);
      replies.push(JSON.parse(text));
    }
  }
  return replies.length
    ? Response.json(replies)
    : new Response(null, { status: 202 });
}

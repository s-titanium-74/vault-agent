import {
  authorizeBearer,
  type AccessCredentials,
  type AccessRole,
} from "@vault-agent/core/access";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import {
  StreamableHTTPServerTransport,
  StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { constantTimeEqual } from "../http-utils.js";
import { MUTATION_NAMES, MCP_WRITE_REQUEST_BYTES } from "./mutations.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";

declare module "fastify" {
  interface FastifyRequest {
    mcpParsedBody?: unknown;
    mcpRole?: AccessRole;
  }
}

interface InitializeRequest {
  jsonrpc: string;
  id?: number | string | null;
  method: string;
  params?: { protocolVersion?: string };
}

function isInitializeRequest(body: unknown): body is InitializeRequest {
  return (
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).jsonrpc === "2.0" &&
    (body as Record<string, unknown>).method === "initialize"
  );
}

function validateProtocolVersion(body: unknown):
  | { valid: true }
  | {
      valid: false;
      code: number;
      message: string;
      id: number | string | null;
      data: Record<string, unknown>;
    } {
  if (Array.isArray(body)) {
    for (const message of body) {
      const result = validateProtocolVersion(message);
      if (!result.valid) {
        return result;
      }
    }
    return { valid: true };
  }

  if (isInitializeRequest(body)) {
    const requestedVersion = body.params?.protocolVersion;
    if (!requestedVersion) {
      return {
        valid: false,
        code: -32600,
        message: "Missing MCP protocol version",
        id: body.id ?? null,
        data: {},
      };
    }
  }

  return { valid: true };
}

function makeJsonRpcError(
  code: number,
  message: string,
  id: number | string | null = null,
  data: Record<string, unknown> = {},
) {
  return {
    jsonrpc: "2.0" as const,
    id,
    error: { code, message, data },
  };
}

interface ActiveSession {
  server: Server;
  transport: StreamableHTTPServerTransport;
  role: AccessRole;
}

export interface StreamableHttpOptions {
  endpoint: string;
  createMcpServer: () => Server;
  apiKey?: string;
  credentials?: AccessCredentials | (() => AccessCredentials | undefined);
  writesEnabled?: boolean;
  transportOptions?: StreamableHTTPServerTransportOptions;
}

export function registerMcpStreamableHttpRoute(
  app: FastifyInstance,
  options: StreamableHttpOptions,
): void {
  const sessions = new Map<string, ActiveSession>();
  const credentialsNow = () =>
    typeof options.credentials === "function"
      ? options.credentials()
      : (options.credentials ??
        (options.apiKey ? { read: [], admin: [options.apiKey] } : undefined));
  if (options.writesEnabled) {
    const credentials = credentialsNow();
    if (
      !credentials?.read.length ||
      !credentials.admin.length ||
      credentials.read.some((key) => credentials.admin.includes(key))
    )
      throw new Error(
        "CONFIG_INVALID: HTTP writes require separate read/admin credentials.",
      );
  }
  app.addHook("onClose", async () => {
    await Promise.allSettled(
      [...sessions.values()].map((session) => session.server.close()),
    );
    sessions.clear();
  });

  const createSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
    body: unknown,
  ): Promise<ActiveSession & { sessionId: string }> => {
    let sessionId: string | undefined;
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (id) => {
        sessionId = id;
      },
      ...options.transportOptions,
    });
    const server = options.createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(request.raw, reply.raw, body);
    if (sessionId === undefined) {
      await server.close();
      throw new Error("Session ID was not generated");
    }
    const session: ActiveSession = {
      server,
      transport,
      role: request.mcpRole ?? "read",
    };
    sessions.set(sessionId, session);
    return { ...session, sessionId };
  };

  app.route({
    url: options.endpoint,
    method: ["GET", "POST", "DELETE"],
    bodyLimit: options.writesEnabled ? MCP_WRITE_REQUEST_BYTES : 64 * 1024,
    onRequest: async (request, reply) => {
      const credentials = credentialsNow();
      if (options.writesEnabled && !credentials) {
        reply.code(401).send(
          makeJsonRpcError(-32020, "Access denied.", null, {
            errorCode: "AUTH_REQUIRED",
          }),
        );
        return;
      }
      const failure = credentials
        ? await authorizeBearer(
            request.headers.authorization,
            credentials,
            "read",
            constantTimeEqual,
          )
        : null;
      if (failure) {
        reply
          .code(failure === "AUTH_REQUIRED" ? 401 : 403)
          .send(
            makeJsonRpcError(
              failure === "AUTH_REQUIRED" ? -32020 : -32021,
              "Access denied.",
              null,
              { errorCode: failure },
            ),
          );
        return;
      }
      request.mcpRole =
        credentials &&
        !(await authorizeBearer(
          request.headers.authorization,
          credentials,
          "admin",
          constantTimeEqual,
        ))
          ? "admin"
          : "read";
      (request.raw as typeof request.raw & { auth: AuthInfo }).auth = {
        token: "",
        clientId: "vault-agent-local-http",
        scopes: [request.mcpRole],
      };
    },
    preParsing: async (request, reply, payload) => {
      if (request.method !== "POST") {
        return payload;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of payload) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (
          size > (options.writesEnabled ? MCP_WRITE_REQUEST_BYTES : 64 * 1024)
        ) {
          reply
            .code(413)
            .send(
              makeJsonRpcError(
                -32008,
                "Request exceeds MCP size limit.",
                null,
                { errorCode: "QUERY_TOO_LARGE" },
              ),
            );
          return;
        }
        chunks.push(bytes);
      }
      let raw: string;
      let parsed: unknown;
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(
          Buffer.concat(chunks),
        );
        parsed = JSON.parse(raw);
      } catch {
        reply.code(400).send(makeJsonRpcError(-32700, "Parse error", null, {}));
        return;
      }
      const calls = Array.isArray(parsed) ? parsed : [parsed];
      if (
        options.writesEnabled &&
        request.mcpRole !== "admin" &&
        calls.some(
          (call) =>
            call?.method === "tools/call" &&
            MUTATION_NAMES.has(call?.params?.name),
        )
      ) {
        reply
          .code(403)
          .send(
            makeJsonRpcError(
              -32040,
              "Access denied.",
              !Array.isArray(parsed) &&
                parsed &&
                typeof parsed === "object" &&
                "id" in parsed
                ? (parsed.id as string | number | null)
                : null,
              { errorCode: "ADMIN_REQUIRED" },
            ),
          );
        return;
      }

      const validation = validateProtocolVersion(parsed);
      if (!validation.valid) {
        reply
          .code(400)
          .send(
            makeJsonRpcError(
              validation.code,
              validation.message,
              validation.id,
              validation.data,
            ),
          );
        return;
      }

      request.mcpParsedBody = parsed;

      return Readable.from([raw]);
    },
    handler: async (request: FastifyRequest, reply: FastifyReply) => {
      const body =
        request.method === "POST"
          ? ((request.mcpParsedBody ?? request.body) as unknown)
          : undefined;

      if (request.method === "POST" && isInitializeRequest(body)) {
        try {
          await createSession(request, reply, body);
        } catch {
          if (!reply.sent) {
            reply
              .code(500)
              .send(
                makeJsonRpcError(
                  -32603,
                  "Internal error creating MCP session.",
                  null,
                  {},
                ),
              );
          }
        }
        if (!reply.sent) {
          reply.hijack();
        }
        return;
      }

      const sessionId = request.headers["mcp-session-id"];
      if (typeof sessionId !== "string") {
        reply
          .code(400)
          .send(makeJsonRpcError(-32600, "Missing session ID.", null, {}));
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        reply
          .code(404)
          .send(makeJsonRpcError(-32600, "Session not found.", null, {}));
        return;
      }
      if (options.writesEnabled && session.role !== request.mcpRole) {
        reply.code(403).send(
          makeJsonRpcError(
            -32040,
            "Start a new session when changing roles.",
            null,
            {
              errorCode:
                session.role === "admin" ? "ADMIN_REQUIRED" : "AUTH_FAILED",
            },
          ),
        );
        return;
      }

      if (request.method === "DELETE") {
        try {
          await session.server.close();
        } catch {
          // Best-effort cleanup; remove the session regardless.
        }
        sessions.delete(sessionId);
        reply.code(200).send({});
        return;
      }

      await session.transport.handleRequest(request.raw, reply.raw, body);

      if (!reply.sent) {
        reply.hijack();
      }
    },
  });
}

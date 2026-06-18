import crypto from "node:crypto";
import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";

import {
  StreamableHTTPServerTransport,
  StreamableHTTPServerTransportOptions,
} from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { constantTimeEqual } from "../http-utils.js";

declare module "fastify" {
  interface FastifyRequest {
    mcpParsedBody?: unknown;
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
    if (requestedVersion !== "2025-03-26") {
      return {
        valid: false,
        code: -32600,
        message: `Unsupported MCP protocol version: ${requestedVersion ?? "missing"}`,
        id: body.id ?? null,
        data: requestedVersion ? { protocolVersion: requestedVersion } : {},
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
}

export interface StreamableHttpOptions {
  endpoint: string;
  createMcpServer: () => Server;
  apiKey?: string;
  transportOptions?: StreamableHTTPServerTransportOptions;
}

export function registerMcpStreamableHttpRoute(
  app: FastifyInstance,
  options: StreamableHttpOptions,
): void {
  const sessions = new Map<string, ActiveSession>();

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
    const session: ActiveSession = { server, transport };
    sessions.set(sessionId, session);
    return { ...session, sessionId };
  };

  app.route({
    url: options.endpoint,
    method: ["GET", "POST", "DELETE"],
    preParsing: async (request, reply, payload) => {
      if (request.method !== "POST") {
        return payload;
      }

      const chunks: Buffer[] = [];
      for await (const chunk of payload) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const raw = Buffer.concat(chunks).toString("utf-8");

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        reply.code(400).send(makeJsonRpcError(-32700, "Parse error", null, {}));
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
      if (options.apiKey) {
        const auth = request.headers.authorization;
        if (!auth || !auth.startsWith("Bearer ")) {
          reply.code(401).send(
            makeJsonRpcError(-32020, "Authentication required.", null, {
              errorCode: "AUTH_REQUIRED",
            }),
          );
          return;
        }
        const token = auth.slice(7);
        if (!constantTimeEqual(token, options.apiKey)) {
          reply.code(403).send(
            makeJsonRpcError(-32021, "Authentication failed.", null, {
              errorCode: "AUTH_FAILED",
            }),
          );
          return;
        }
      }

      const body =
        request.method === "POST"
          ? ((request.mcpParsedBody ?? request.body) as unknown)
          : undefined;

      if (request.method === "POST" && isInitializeRequest(body)) {
        try {
          await createSession(request, reply, body);
        } catch (error: unknown) {
          console.error(
            "MCP session creation failed:",
            error instanceof Error ? error.stack : String(error),
          );
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

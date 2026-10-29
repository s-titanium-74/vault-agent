import {
  SearchError,
  SourceError,
  RetrievalSizeError,
} from "@vault-agent/core/portable";
import { authenticate, config, type Env } from "./config.js";
import { CloudError, boundedBytes, failure } from "./errors.js";
import { RetrievalService, cloudStatus } from "./service.js";
import { mcp } from "./mcp.js";
import {
  ingestionEnabled,
  createUpload,
  addManifest,
  uploadFile,
  commitUpload,
  jobStatus,
  advance,
  requestIndex,
  tick,
} from "./ingestion.js";
async function body(request: Request) {
  if (
    !request.headers
      .get("Content-Type")
      ?.split(";")[0]
      ?.trim()
      .endsWith("/json")
  )
    throw new CloudError("INVALID_PARAMETER");
  if (Number(request.headers.get("Content-Length") ?? 0) > 65536)
    throw new CloudError("QUERY_TOO_LARGE", 413);
  if (!request.body) throw new CloudError("INVALID_PARAMETER");
  let bytes: Uint8Array;
  try {
    bytes = await boundedBytes(request.body, 65536, request.signal);
  } catch (error) {
    if (error instanceof CloudError && error.code === "SOURCE_TOO_LARGE")
      throw new CloudError("QUERY_TOO_LARGE", 413);
    throw error;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new CloudError("INVALID_PARAMETER");
  }
}
const routes: Record<string, string> = {
  "/overview": "vault_overview",
  "/tree": "vault_tree",
  "/tags": "vault_tags",
  "/facets": "vault_facets",
  "/links/broken": "vault_broken_links",
  "/links/orphans": "vault_orphans",
  "/links/summary": "vault_link_summary",
  "/profiles/metadata": "vault_metadata_profile",
  "/profiles/style": "vault_style_profile",
  "/agent-guidance": "vault_guidance_list",
};
async function dispatch(request: Request, env: Env) {
  const url = new URL(request.url);
  if (url.pathname === "/health" && request.method === "GET")
    return Response.json({ status: "ok" });
  const settings = config(env);
  if (new TextEncoder().encode(request.url).length > 8192)
    throw new CloudError("QUERY_TOO_LARGE", 413);
  if (url.protocol !== "https:") throw new CloudError("HTTPS_REQUIRED", 403);
  const admin =
    /^\/(index|reindex|uploads?|sync|watch)(\/|$)/.test(url.pathname) ||
    (/^\/jobs\//.test(url.pathname) && request.method !== "GET");
  await authenticate(request, env, admin);
  const origin = request.headers.get("Origin");
  if (origin && !settings.origins.includes(origin))
    throw new CloudError("ORIGIN_FORBIDDEN", 403);
  if (!(await env.REQUEST_LIMITER.limit({ key: env.VAULT_ID })).success)
    throw new CloudError("RATE_LIMITED", 429);
  if (ingestionEnabled(env)) {
    const job = /^\/jobs\/([^/]+)(\/advance)?$/.exec(url.pathname);
    const upload = /^\/uploads\/([^/]+)\/(manifest|commit|files\/(.+))$/.exec(
      url.pathname,
    );
    let data: unknown;
    if (url.pathname === "/uploads" && request.method === "POST")
      data = await createUpload(
        env,
        request.headers.get("Idempotency-Key") ?? "",
        await body(request),
      );
    else if (upload && request.method === "PUT" && upload[2] === "manifest")
      data = await addManifest(env, upload[1]!, await body(request));
    else if (upload && request.method === "PUT" && upload[3])
      data = await uploadFile(
        env,
        upload[1]!,
        decodeURIComponent(upload[3]),
        request,
      );
    else if (upload && request.method === "POST" && upload[2] === "commit")
      data = await commitUpload(env, upload[1]!);
    else if (job && request.method === "GET" && !job[2])
      data = await jobStatus(env, job[1]!);
    else if (job && request.method === "POST" && job[2]) {
      const p = await body(request);
      if (!Number.isSafeInteger(p?.checkpoint) || p.checkpoint < 0)
        throw new CloudError("INVALID_PARAMETER");
      data = await advance(env, job[1]!, p.checkpoint);
    } else if (
      ["/index", "/reindex"].includes(url.pathname) &&
      request.method === "POST"
    ) {
      const p = await body(request);
      if (
        p?.requireEmbeddings !== undefined &&
        typeof p.requireEmbeddings !== "boolean"
      )
        throw new CloudError("INVALID_PARAMETER");
      data = await requestIndex(
        env,
        url.pathname === "/reindex",
        p.requireEmbeddings === true,
        p.newScan === true,
      );
    }
    if (data !== undefined) return Response.json({ data, warnings: [] });
    if (url.pathname === "/status" && request.method === "GET") {
      const pointer = await env.DB.prepare(
        "SELECT revision FROM deployment WHERE id=1",
      ).first();
      if (!pointer)
        return Response.json({
          data: await cloudStatus(env, url.hostname, null, null),
          warnings: [],
        });
    }
  }
  if (admin || /^\/jobs\//.test(url.pathname))
    throw new CloudError("CAPABILITY_UNSUPPORTED", 501);
  if (url.pathname === "/mcp") {
    if (request.method !== "POST")
      return new Response(null, { status: 405, headers: { Allow: "POST" } });
    try {
      return await mcp(request, env, await body(request));
    } catch (error) {
      if (error instanceof CloudError && error.code === "INVALID_PARAMETER")
        return Response.json(
          {
            jsonrpc: "2.0",
            id: null,
            error: { code: -32700, message: "Invalid JSON-RPC input." },
          },
          { status: 400 },
        );
      throw error;
    }
  }
  const service = await RetrievalService.open(env);
  const revision = service.revision();
  if (url.pathname === "/status" && request.method === "GET") {
    const status = await service.status(url.hostname);
    await service.current();
    return Response.json({
      data: status,
      warnings: [],
      revision,
    });
  }
  let operation: string | undefined;
  let args: Record<string, unknown> = {};
  url.searchParams.forEach((_value, key) => {
    const values = url.searchParams.getAll(key);
    args[key] = values.length === 1 ? values[0] : values;
  });
  if (
    request.method === "POST" &&
    ["/search", "/related"].includes(url.pathname)
  ) {
    operation = url.pathname.slice(1);
    args = await body(request);
  } else if (request.method === "GET") {
    operation = routes[url.pathname];
    const note = /^\/notes\/([^/]+)$/.exec(url.pathname);
    const chunk = /^\/chunks\/([^/]+)\/(\d+)$/.exec(url.pathname);
    const links = /^\/links\/(notes|backlinks)\/([^/]+)$/.exec(url.pathname);
    if (note) {
      operation = "get_note";
      args.noteId = decodeURIComponent(note[1]!);
    }
    if (chunk) {
      operation = "get_chunk";
      args.noteId = decodeURIComponent(chunk[1]!);
      args.chunkIndex = Number(chunk[2]);
    }
    if (links) {
      operation = links[1] === "notes" ? "vault_links" : "vault_backlinks";
      args.noteId = decodeURIComponent(links[2]!);
    }
    for (const [prefix, name] of [
      ["/attachments/", "get_attachment"],
      ["/agent-guidance/", "vault_guidance_get"],
    ]) {
      if (url.pathname.startsWith(prefix!)) {
        operation = name;
        try {
          args.path = decodeURIComponent(url.pathname.slice(prefix!.length));
        } catch {
          throw new CloudError("INVALID_PATH");
        }
      }
    }
    for (const flag of ["allowLarge", "download"]) {
      if (args[flag] !== undefined) {
        if (!["true", "false"].includes(String(args[flag])))
          throw new CloudError("INVALID_PARAMETER");
        args[flag] = args[flag] === "true";
      }
    }
  }
  if (!operation) throw new CloudError("NOT_FOUND", 404);
  const result = await service.invoke(operation, args);
  if (operation === "get_attachment" && args.download) {
    const attachment = result.data as {
      stream: ReadableStream<Uint8Array>;
      contentType: string;
      fileName: string;
    };
    return new Response(attachment.stream, {
      headers: {
        "Content-Type": attachment.contentType,
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(attachment.fileName)}`,
      },
    });
  }
  return Response.json({ ...result, revision });
}
export default {
  async scheduled(_event: ScheduledController, env: Env) {
    await tick(env);
  },
  async fetch(request: Request, env: Env): Promise<Response> {
    let response: Response;
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        response = await Promise.race([
          dispatch(request, env),
          new Promise<Response>((_resolve, reject) => {
            timer = setTimeout(
              () => reject(new CloudError("TIMEOUT", 504)),
              30000,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    } catch (error) {
      if (error instanceof CloudError)
        response = failure(error.code, error.status);
      else if (error instanceof SourceError)
        response = failure(
          error.code,
          error.code === "SOURCE_EXCLUDED"
            ? 403
            : error.code === "SOURCE_TOO_LARGE"
              ? 413
              : error.code === "SOURCE_REVISION_MISMATCH"
                ? 409
                : 400,
        );
      else if (error instanceof RetrievalSizeError)
        response = failure(error.code, 413);
      else if (error instanceof SearchError)
        response = failure(
          error.code,
          error.code === "EMBEDDING_UNAVAILABLE"
            ? 503
            : error.code.endsWith("_NOT_FOUND")
              ? 404
              : 400,
        );
      else response = failure("INTERNAL_ERROR", 500);
    }
    response = new Response(response.body, response);
    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");
    if (response.status === 429) response.headers.set("Retry-After", "60");
    return response;
  },
};

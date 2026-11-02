import type {
  PageRequest,
  SourceEntry,
  SourceReadOptions,
  VaultSource,
} from "./contracts.js";
import { contentRevision } from "./identifiers.js";
import {
  canonicalSourcePath,
  guidanceKind,
  pageLimit,
  sourcePolicy,
  SourceError,
} from "./source-policy.js";

export interface PCloudOptions {
  vaultId: string;
  region: "us" | "eu";
  folderId: string;
  accessToken: string;
  includes: readonly string[];
  excludes?: readonly string[];
  timeoutMs?: number;
  fetch?: typeof fetch;
}
export interface PCloudObservation {
  path: string;
  kind: "note";
  size: number;
  updated: string;
  /** Provider evidence, deliberately distinct from the verified body digest. */
  version: string;
}
type Metadata = Record<string, unknown>;
const MAX_BYTES = 2 * 1024 * 1024;
const unavailable = () => new SourceError("SOURCE_UNAVAILABLE");
function record(value: unknown): Metadata {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw unavailable();
  return value as Metadata;
}
function id(value: unknown): string {
  if (typeof value === "number" && !Number.isSafeInteger(value))
    throw unavailable();
  const result = String(value);
  if (!/^\d+$/.test(result)) throw unavailable();
  return result;
}
/** Preserve large JSON integer tokens, including pCloud's unsigned 64-bit hash. */
function parseMetadata(text: string): Metadata {
  return record(
    JSON.parse(
      text.replace(
        /"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,
        (token) => (/^-?\d{16,}$/.test(token) ? JSON.stringify(token) : token),
      ),
    ),
  );
}
async function bounded(response: Response, max: number): Promise<Uint8Array> {
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw unavailable();
  }
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > max) throw new SourceError("SOURCE_TOO_LARGE");
      parts.push(next.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}

/** Scoped read-only Web API adapter shared by Node and Workers. */
export class PCloudSource implements VaultSource {
  readonly vaultId: string;
  private readonly allowed: (path: string) => boolean;
  private readonly api: string;
  private readonly fetcher: typeof fetch;
  constructor(private readonly options: PCloudOptions) {
    if (
      !options.includes.length ||
      !["us", "eu"].includes(options.region) ||
      !/^\d+$/.test(options.folderId) ||
      !options.accessToken ||
      (options.timeoutMs !== undefined &&
        (!Number.isSafeInteger(options.timeoutMs) ||
          options.timeoutMs < 1 ||
          options.timeoutMs > 120000))
    )
      throw unavailable();
    this.vaultId = options.vaultId;
    this.allowed = sourcePolicy(options.includes, options.excludes);
    this.api =
      options.region === "eu"
        ? "https://eapi.pcloud.com"
        : "https://api.pcloud.com";
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  }
  private async operation<T>(
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const deadline = AbortSignal.timeout(this.options.timeoutMs ?? 15000);
    const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      combined.throwIfAborted();
      return await run(combined);
    } catch (error) {
      // Never propagate fetch URLs, signed links, provider messages or caller reasons.
      if (error instanceof SourceError) throw error;
      throw unavailable();
    }
  }
  private async call(
    method: "listfolder" | "getfilelink",
    params: Record<string, string>,
    signal: AbortSignal,
  ) {
    const response = await this.fetcher(`${this.api}/${method}`, {
      method: "POST",
      redirect: "manual",
      signal,
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        ...params,
        logout: "1",
        filtermeta: "0",
        filterfilemeta: "0",
        filterfoldermeta: "0",
        timeformat: "rfc2822",
        access_token: this.options.accessToken,
      }),
    });
    if (response.status === 429) throw new SourceError("SOURCE_RATE_LIMITED");
    if (response.status === 401 || response.status === 403)
      throw new SourceError("SOURCE_AUTH_FAILED");
    const data = parseMetadata(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await bounded(response, 4 * 1024 * 1024),
      ),
    );
    if ([1000, 2000, 2094].includes(Number(data.result)))
      throw new SourceError("SOURCE_AUTH_FAILED");
    if (Number(data.result) === 2003) throw new SourceError("SOURCE_EXCLUDED");
    if ([2002, 2005, 2009].includes(Number(data.result)))
      throw new SourceError("SOURCE_NOT_FOUND");
    if (data.result !== 0) throw unavailable();
    return data;
  }
  private folder(metadata: unknown, expected: string): Metadata {
    const m = record(metadata);
    if (
      m.isfolder !== true ||
      id(m.folderid) !== expected ||
      m.encrypted ||
      m.isencrypted ||
      m.isdeleted ||
      !Array.isArray(m.contents)
    )
      throw unavailable();
    return m;
  }
  private observation(
    m: Metadata,
    path: string,
    parent: string,
  ): PCloudObservation {
    if (
      m.isfolder !== false ||
      m.encrypted ||
      m.isencrypted ||
      m.isdeleted ||
      id(m.parentfolderid) !== parent ||
      !Number.isSafeInteger(m.size) ||
      Number(m.size) < 0 ||
      !Number.isFinite(Date.parse(String(m.modified)))
    )
      throw unavailable();
    if (Number(m.size) > MAX_BYTES) throw new SourceError("SOURCE_TOO_LARGE");
    return {
      path,
      kind: "note",
      size: Number(m.size),
      updated: new Date(String(m.modified)).toISOString(),
      version: JSON.stringify([
        id(m.fileid),
        id(m.hash),
        m.size,
        String(m.modified),
        parent,
      ]),
    };
  }
  private check(path: string) {
    canonicalSourcePath(path);
    if (
      !this.allowed(path) ||
      guidanceKind(path) ||
      !/\.(md|markdown)$/i.test(path)
    )
      throw new SourceError("SOURCE_EXCLUDED");
  }
  /** Complete bounded observation; failures never return partial membership. */
  async observe(signal?: AbortSignal): Promise<PCloudObservation[]> {
    return this.operation(signal, async (signal) => {
      const data = await this.call(
        "listfolder",
        { folderid: this.options.folderId, recursive: "1" },
        signal,
      );
      if (data.truncated || data.has_more) throw unavailable();
      const items: PCloudObservation[] = [];
      const seen = new Set<string>();
      let nodes = 0;
      const walk = (
        value: unknown,
        folderId: string,
        prefix: string,
        depth: number,
      ) => {
        if (depth > 64 || seen.has(`d${folderId}`)) throw unavailable();
        seen.add(`d${folderId}`);
        const folder = this.folder(value, folderId);
        for (const value of folder.contents as unknown[]) {
          if (++nodes > 10000) throw new SourceError("SOURCE_TOO_LARGE");
          const child = record(value);
          if (typeof child.name !== "string" || child.name.includes("/"))
            throw unavailable();
          const path = canonicalSourcePath(prefix + child.name);
          if (path.length > 512) throw new SourceError("INVALID_PATH");
          if (id(child.parentfolderid) !== folderId) throw unavailable();
          if (seen.has(`p:${path}`)) throw unavailable();
          seen.add(`p:${path}`);
          if (child.encrypted || child.isencrypted || child.isdeleted)
            throw new SourceError("SOURCE_EXCLUDED");
          if (child.isfolder === true)
            walk(child, id(child.folderid), path + "/", depth + 1);
          else if (child.isfolder !== false) throw unavailable();
          else if (
            this.allowed(path) &&
            !guidanceKind(path) &&
            /\.(md|markdown)$/i.test(path)
          ) {
            const fileId = `f${id(child.fileid)}`;
            if (seen.has(fileId)) throw unavailable();
            seen.add(fileId);
            items.push(this.observation(child, path, folderId));
            if (items.length > 500) throw new SourceError("SOURCE_TOO_LARGE");
          }
        }
      };
      walk(data.metadata, this.options.folderId, "", 0);
      return items.sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
    });
  }
  private async resolve(path: string, signal: AbortSignal) {
    this.check(path);
    const segments = path.split("/");
    if (segments.length > 64) throw new SourceError("SOURCE_EXCLUDED");
    let folderId = this.options.folderId;
    for (let i = 0; i < segments.length; i++) {
      const data = await this.call(
        "listfolder",
        { folderid: folderId },
        signal,
      );
      const folder = this.folder(data.metadata, folderId);
      const matches = (folder.contents as unknown[])
        .map(record)
        .filter((c) => c.name === segments[i]);
      if (matches.length > 1) throw unavailable();
      const child = matches[0];
      if (!child) return null;
      if (
        id(child.parentfolderid) !== folderId ||
        child.encrypted ||
        child.isencrypted ||
        child.isdeleted
      )
        throw new SourceError("SOURCE_EXCLUDED");
      if (i === segments.length - 1)
        return this.observation(child, path, folderId);
      if (child.isfolder !== true) return null;
      folderId = id(child.folderid);
    }
    return null;
  }
  async readObserved(entry: PCloudObservation, signal?: AbortSignal) {
    return this.operation(signal, async (signal) => {
      const before = await this.resolve(entry.path, signal);
      if (!before || before.version !== entry.version)
        throw new SourceError("SOURCE_REVISION_MISMATCH");
      const [fileid] = JSON.parse(before.version) as string[];
      const data = await this.call(
        "getfilelink",
        { fileid: fileid!, forcedownload: "1" },
        signal,
      );
      const host = Array.isArray(data.hosts) ? data.hosts[0] : null;
      if (
        typeof host !== "string" ||
        !/^[a-z\d-]+\.pcloud\.com$/i.test(host) ||
        typeof data.path !== "string" ||
        !data.path.startsWith("/") ||
        data.path.startsWith("//") ||
        /[\\\r\n]/.test(data.path)
      )
        throw unavailable();
      const url = new URL(`https://${host}${data.path}`);
      if (
        url.hostname !== host.toLowerCase() ||
        url.username ||
        url.password ||
        url.port
      )
        throw unavailable();
      const bytes = await bounded(
        await this.fetcher(url, { signal, redirect: "manual" }),
        Math.min(MAX_BYTES, entry.size),
      );
      const after = await this.resolve(entry.path, signal);
      if (bytes.length !== entry.size || after?.version !== entry.version)
        throw new SourceError("SOURCE_REVISION_MISMATCH");
      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        if (text.includes("\0")) throw new Error();
      } catch {
        throw new SourceError("SOURCE_NOT_UTF8");
      }
      return {
        bytes,
        entry: {
          path: entry.path,
          kind: entry.kind,
          size: bytes.length,
          updated: entry.updated,
          revision: await contentRevision(bytes),
        } satisfies SourceEntry,
      };
    });
  }
  async stat(path: string, signal?: AbortSignal): Promise<SourceEntry | null> {
    const observed = await this.operation(signal, (s) => this.resolve(path, s));
    return observed ? (await this.readObserved(observed, signal)).entry : null;
  }
  async readBytes(path: string, options: SourceReadOptions) {
    if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
      throw new SourceError("SOURCE_TOO_LARGE");
    const observed = await this.operation(options.signal, (s) =>
      this.resolve(path, s),
    );
    if (!observed) throw new SourceError("SOURCE_NOT_FOUND");
    if (observed.size > options.maxBytes)
      throw new SourceError("SOURCE_TOO_LARGE");
    const { bytes, entry } = await this.readObserved(observed, options.signal);
    if (entry.revision !== options.expectedRevision)
      throw new SourceError("SOURCE_REVISION_MISMATCH");
    return new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes);
        c.close();
      },
    });
  }
  async readText(path: string, options: SourceReadOptions) {
    const bytes = await bounded(
      new Response(await this.readBytes(path, options)),
      options.maxBytes,
    );
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new SourceError("SOURCE_NOT_UTF8");
    }
  }
  async list(request: PageRequest) {
    pageLimit(request.limit);
    const observed = await this.observe(request.signal);
    const signature = await contentRevision(JSON.stringify(observed));
    let after = "";
    if (request.cursor) {
      try {
        if (request.cursor.length > 2048) throw new Error();
        const cursor: unknown = JSON.parse(request.cursor);
        if (
          !Array.isArray(cursor) ||
          cursor.length !== 2 ||
          typeof cursor[0] !== "string" ||
          typeof cursor[1] !== "string" ||
          !/^[a-f0-9]{64}$/.test(cursor[0])
        )
          throw new Error();
        after = canonicalSourcePath(cursor[1]);
        if (cursor[0] !== signature)
          throw new SourceError("SOURCE_REVISION_MISMATCH");
      } catch (error) {
        if (
          error instanceof SourceError &&
          error.code === "SOURCE_REVISION_MISMATCH"
        )
          throw error;
        throw new SourceError("INVALID_CURSOR");
      }
    }
    const remaining = observed.filter((e) => e.path > after);
    const page = remaining.slice(0, request.limit);
    const items: SourceEntry[] = [];
    for (const entry of page)
      items.push((await this.readObserved(entry, request.signal)).entry);
    return {
      items,
      cursor:
        remaining.length > page.length
          ? JSON.stringify([signature, page.at(-1)!.path])
          : undefined,
    };
  }
}

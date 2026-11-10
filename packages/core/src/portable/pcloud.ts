import type {
  PageRequest,
  SourceEntry,
  SourceReadOptions,
  VaultSource,
} from "./contracts.js";
import { RetrievalSizeError } from "../errors.js";
import {
  DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT,
  DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT,
} from "../schemas.js";
import { uploadKind, uploadLimit } from "./ingestion.js";
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
  maxNotes?: number;
  writesEnabled?: boolean;
  fetch?: typeof fetch;
}
export interface PCloudObservation<K extends SourceEntry["kind"] = "note"> {
  path: string;
  kind: K;
  size: number;
  updated: string;
  /** Provider evidence, deliberately distinct from the verified body digest. */
  version: string;
}
type Metadata = Record<string, unknown>;
export const PCLOUD_MAX_NOTE_BYTES = 2 * 1024 * 1024;
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

/** The expected note state failed before a provider file write was sent. */
export class PCloudWriteConflict extends SourceError {
  constructor() {
    super("SOURCE_REVISION_MISMATCH");
  }
}

/** Scoped Web API adapter shared by Node and Workers. */
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
      (options.maxNotes !== undefined &&
        (!Number.isSafeInteger(options.maxNotes) || options.maxNotes < 1)) ||
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
    method:
      | "listfolder"
      | "getfilelink"
      | "uploadfile"
      | "deletefile"
      | "createfolderifnotexists",
    params: Record<string, string>,
    signal: AbortSignal,
    upload?: { name: string; bytes: Uint8Array },
  ) {
    const fields = new URLSearchParams({
      ...params,
      logout: "1",
      filtermeta: "0",
      filterfilemeta: "0",
      filterfoldermeta: "0",
      timeformat: "rfc2822",
      access_token: this.options.accessToken,
    });
    let body: URLSearchParams | FormData = fields;
    if (upload) {
      const form = new FormData();
      fields.forEach((value, key) => form.append(key, value));
      form.append(
        "file",
        new Blob([Uint8Array.from(upload.bytes)]),
        upload.name,
      );
      body = form;
    }
    const response = await this.fetcher(`${this.api}/${method}`, {
      method: "POST",
      redirect: "manual",
      signal,
      body,
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
  private observation<K extends SourceEntry["kind"]>(
    m: Metadata,
    path: string,
    parent: string,
    kind: K,
  ): PCloudObservation<K> {
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
    return {
      path,
      kind,
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
    if (path.length > 512) throw new SourceError("INVALID_PATH");
    const kind = uploadKind(path);
    if (!this.allowed(path) || !kind) throw new SourceError("SOURCE_EXCLUDED");
    return kind;
  }
  /** Complete bounded observation; failures never return partial membership. */
  async observe(signal?: AbortSignal): Promise<PCloudObservation[]> {
    return this.observeKind("note", this.options.maxNotes ?? 500, signal);
  }
  private async observeKind<K extends "note" | "guidance">(
    kind: K,
    limit: number,
    signal?: AbortSignal,
  ): Promise<PCloudObservation<K>[]> {
    return this.operation(signal, async (signal) => {
      const data = await this.call(
        "listfolder",
        { folderid: this.options.folderId, recursive: "1" },
        signal,
      );
      if (data.truncated || data.has_more) throw unavailable();
      const items: PCloudObservation<K>[] = [];
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
          else if (this.allowed(path) && uploadKind(path) === kind) {
            const fileId = `f${id(child.fileid)}`;
            if (seen.has(fileId)) throw unavailable();
            seen.add(fileId);
            const entry = this.observation(child, path, folderId, kind);
            items.push(entry);
            if (
              items.length > limit ||
              (kind === "note" && entry.size > PCLOUD_MAX_NOTE_BYTES)
            )
              throw new SourceError("SOURCE_TOO_LARGE");
          }
        }
      };
      walk(data.metadata, this.options.folderId, "", 0);
      return items.sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
    });
  }
  private async locate(
    path: string,
    signal: AbortSignal,
    createParents = false,
  ) {
    const kind = this.check(path);
    const segments = path.split("/");
    if (segments.length > 64) throw new SourceError("SOURCE_EXCLUDED");
    let folderId = this.options.folderId;
    for (let i = 0; i < segments.length; i++) {
      const data = await this.call(
        "listfolder",
        { folderid: folderId },
        signal,
      );
      if (data.truncated || data.has_more) throw unavailable();
      const folder = this.folder(data.metadata, folderId);
      const matches = (folder.contents as unknown[])
        .map(record)
        .filter((c) => c.name === segments[i]);
      if (matches.length > 1) throw unavailable();
      const child = matches[0];
      if (!child) {
        if (i === segments.length - 1) return { folderId, entry: null };
        if (!createParents) return null;
        const created = record(
          (
            await this.call(
              "createfolderifnotexists",
              { folderid: folderId, name: segments[i]! },
              signal,
            )
          ).metadata,
        );
        if (
          created.isfolder !== true ||
          created.name !== segments[i] ||
          id(created.parentfolderid) !== folderId ||
          created.encrypted ||
          created.isencrypted ||
          created.isdeleted
        )
          throw unavailable();
        folderId = id(created.folderid);
        continue;
      }
      if (
        id(child.parentfolderid) !== folderId ||
        child.encrypted ||
        child.isencrypted ||
        child.isdeleted
      )
        throw new SourceError("SOURCE_EXCLUDED");
      if (i === segments.length - 1)
        return child.isfolder === true
          ? null
          : { folderId, entry: this.observation(child, path, folderId, kind) };
      if (child.isfolder !== true) return null;
      folderId = id(child.folderid);
    }
    return null;
  }
  private async resolve(path: string, signal: AbortSignal) {
    return (await this.locate(path, signal))?.entry ?? null;
  }

  async writeNote(
    path: string,
    expectedRevision: string | null,
    bytes: Uint8Array | null,
    signal?: AbortSignal,
  ): Promise<SourceEntry | null> {
    if (this.check(path) !== "note") throw new SourceError("SOURCE_EXCLUDED");
    return this.writeFile(path, expectedRevision, bytes, signal);
  }

  /** Requires exclusive write ownership of the configured folder scope. */
  async writeFile(
    path: string,
    expectedRevision: string | null,
    bytes: Uint8Array | null,
    signal?: AbortSignal,
  ): Promise<SourceEntry | null> {
    if (!this.options.writesEnabled) throw unavailable();
    const kind = this.check(path);
    if (kind === "guidance") throw new SourceError("SOURCE_EXCLUDED");
    if (bytes && bytes.length > uploadLimit(kind))
      throw new SourceError("SOURCE_TOO_LARGE");
    if (bytes && kind === "note") decodeText(bytes);
    const desired = bytes ? await contentRevision(bytes) : null;
    return this.operation(signal, async (signal) => {
      const target = await this.locate(
        path,
        signal,
        expectedRevision === null && bytes !== null,
      );
      if (!target) throw new PCloudWriteConflict();
      const current = target.entry
        ? (await this.readObserved(target.entry, signal)).entry.revision
        : null;
      if (current !== expectedRevision) throw new PCloudWriteConflict();
      if (bytes) {
        await this.call(
          "uploadfile",
          { folderid: target.folderId, nopartial: "1" },
          signal,
          { name: path.split("/").at(-1)!, bytes },
        );
      } else if (target.entry) {
        const [fileid] = JSON.parse(target.entry.version) as [string];
        await this.call("deletefile", { fileid }, signal);
      }
      const after =
        (await this.readCurrentFile(path, undefined, signal))?.entry ?? null;
      if ((after?.revision ?? null) !== desired)
        throw new SourceError("SOURCE_REVISION_MISMATCH");
      return after;
    });
  }

  async readObserved(
    entry: PCloudObservation<SourceEntry["kind"]>,
    signal?: AbortSignal,
  ) {
    if (entry.size > uploadLimit(entry.kind))
      throw new SourceError("SOURCE_TOO_LARGE");
    return this.operation(signal, async (signal) => {
      const before = await this.resolve(entry.path, signal);
      if (
        !before ||
        before.kind !== entry.kind ||
        before.version !== entry.version
      )
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
        entry.size,
      );
      const after = await this.resolve(entry.path, signal);
      if (bytes.length !== entry.size || after?.version !== entry.version)
        throw new SourceError("SOURCE_REVISION_MISMATCH");
      if (entry.kind !== "attachment") decodeText(bytes);
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
  async readCurrent(
    path: string,
    maxBytes = PCLOUD_MAX_NOTE_BYTES,
    signal?: AbortSignal,
  ) {
    if (this.check(path) !== "note") throw new SourceError("SOURCE_EXCLUDED");
    return this.readCurrentFile(path, maxBytes, signal);
  }
  async readCurrentFile(path: string, maxBytes?: number, signal?: AbortSignal) {
    const observed = await this.operation(signal, (s) => this.resolve(path, s));
    if (!observed) return null;
    if (observed.size > (maxBytes ?? uploadLimit(observed.kind)))
      throw new SourceError("SOURCE_TOO_LARGE");
    return this.readObserved(observed, signal);
  }
  async stat(path: string, signal?: AbortSignal): Promise<SourceEntry | null> {
    return (await this.readCurrent(path, undefined, signal))?.entry ?? null;
  }
  async listGuidance() {
    return {
      guidance: (await this.observeKind("guidance", 500)).map(
        guidanceCandidate,
      ),
    };
  }
  async getGuidance(path: string, allowLarge: boolean) {
    if (this.check(path) !== "guidance") return null;
    const observed = await this.operation(undefined, (signal) =>
      this.resolve(path, signal),
    );
    if (!observed) return null;
    const limit = allowLarge
      ? uploadLimit("guidance")
      : DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT;
    if (observed.size > limit)
      throw new RetrievalSizeError(
        "GUIDANCE_TOO_LARGE",
        "Guidance exceeds the retrieval size limit.",
      );
    const { bytes } = await this.readObserved(observed);
    return {
      ...guidanceCandidate(observed),
      content: decodeText(bytes),
      contentType: /\.(md|markdown|mdc)$/i.test(path)
        ? "text/markdown; charset=utf-8"
        : "text/plain; charset=utf-8",
    };
  }
  async getAttachment(path: string, download: boolean, allowLarge: boolean) {
    if (this.check(path) !== "attachment") return null;
    const observed = await this.operation(undefined, (signal) =>
      this.resolve(path, signal),
    );
    if (!observed) return null;
    const limit = allowLarge
      ? uploadLimit("attachment")
      : DEFAULT_ATTACHMENT_DOWNLOAD_SIZE_LIMIT;
    const metadata = {
      path,
      fileName: path.split("/").at(-1)!,
      size: observed.size,
      downloadAvailable: observed.size <= limit,
    };
    if (!download) return { metadata };
    if (!metadata.downloadAvailable)
      throw new RetrievalSizeError(
        "ATTACHMENT_TOO_LARGE",
        "Attachment exceeds the download size limit.",
      );
    const { bytes, entry } = await this.readObserved(observed);
    return { metadata, bytes, version: entry.revision };
  }
  async readBytes(path: string, options: SourceReadOptions) {
    if (this.check(path) !== "note") throw new SourceError("SOURCE_EXCLUDED");
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

function decodeText(bytes: Uint8Array) {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) throw new Error();
    return text;
  } catch {
    throw new SourceError("SOURCE_NOT_UTF8");
  }
}

function guidanceCandidate(
  entry: Pick<PCloudObservation<"guidance">, "path" | "size" | "updated">,
) {
  const { path, size, updated } = entry;
  const kind = guidanceKind(path)!;
  const scope =
    kind === "cursor_rule"
      ? path.split(/(?:^|\/)\.cursor\/rules\//)[0]!
      : path.split("/").slice(0, -1).join("/");
  return {
    path,
    kind,
    scope,
    appliesTo: scope ? `${scope}/**` : "**",
    size,
    updated,
  };
}

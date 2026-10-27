import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { createHash } from "node:crypto";
import type {
  VaultSource,
  SourceEntry,
  SourceReadOptions,
  PageRequest,
} from "../portable/contracts.js";
import {
  canonicalSourcePath,
  sourcePolicy,
  guidanceKind,
  pageLimit,
  SourceError,
} from "../portable/source-policy.js";

/** Explicitly scoped read-only source. No config discovery and no network I/O. */
export class FilesystemSource implements VaultSource {
  private allowed: ReturnType<typeof sourcePolicy>;
  constructor(
    private root: string,
    readonly vaultId: string,
    includes: readonly string[],
    excludes: readonly string[] = [],
  ) {
    this.allowed = sourcePolicy(includes, excludes);
  }
  private async open(value: string, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const relative = canonicalSourcePath(value);
    if (!this.allowed(relative))
      throw new SourceError("SOURCE_EXCLUDED", "Source path is excluded.");
    try {
      const root = await fs.realpath(this.root);
      let current = root;
      for (const segment of relative.split("/")) {
        current = path.join(current, segment);
        if ((await fs.lstat(current)).isSymbolicLink())
          throw new SourceError("SOURCE_EXCLUDED");
      }
      const resolved = await fs.realpath(current);
      if (!resolved.startsWith(root + path.sep))
        throw new SourceError("SOURCE_EXCLUDED");
      const handle = await fs.open(
        resolved,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      const stat = await handle.stat();
      if (!stat.isFile()) {
        await handle.close();
        throw new SourceError("SOURCE_EXCLUDED");
      }
      return { handle, stat, resolved, root };
    } catch (error) {
      if (error instanceof SourceError) throw error;
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new SourceError("SOURCE_UNAVAILABLE", "Source is unavailable.");
    }
  }
  private async read(
    value: string,
    options?: SourceReadOptions,
    signal = options?.signal,
  ) {
    const opened = await this.open(value, signal);
    if (!opened) return null;
    const { handle, stat, resolved, root } = opened;
    try {
      if (
        options &&
        (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0)
      )
        throw new SourceError("SOURCE_TOO_LARGE");
      if (options && stat.size > options.maxBytes)
        throw new SourceError(
          "SOURCE_TOO_LARGE",
          "Source exceeds the read budget.",
        );
      const hash = createHash("sha256");
      const parts: Uint8Array[] = [];
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      for (;;) {
        signal?.throwIfAborted();
        const { bytesRead } = await handle.read(buffer);
        if (!bytesRead) break;
        size += bytesRead;
        if (options && size > options.maxBytes)
          throw new SourceError("SOURCE_TOO_LARGE");
        hash.update(buffer.subarray(0, bytesRead));
        if (options) parts.push(buffer.slice(0, bytesRead));
      }
      const after = await handle.stat();
      const realAfter = await fs.realpath(path.join(root, value));
      const pathStat = await fs.lstat(realAfter);
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs ||
        realAfter !== resolved ||
        pathStat.ino !== stat.ino ||
        pathStat.dev !== stat.dev
      )
        throw new SourceError(
          "SOURCE_REVISION_MISMATCH",
          "Source changed during reading.",
        );
      const revision = hash.digest("hex");
      if (options && revision !== options.expectedRevision)
        throw new SourceError(
          "SOURCE_REVISION_MISMATCH",
          "Source revision changed.",
        );
      const entry: SourceEntry = {
        path: value,
        kind: guidanceKind(value)
          ? "guidance"
          : /\.(md|markdown)$/i.test(value)
            ? "note"
            : "attachment",
        size,
        revision,
        updated: stat.mtime.toISOString(),
      };
      return {
        entry,
        bytes: options ? new Uint8Array(Buffer.concat(parts)) : undefined,
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof SourceError) throw error;
      throw new SourceError("SOURCE_UNAVAILABLE", "Source is unavailable.");
    } finally {
      await handle.close();
    }
  }
  async stat(value: string, signal?: AbortSignal) {
    // stat computes the content revision without retaining the body.
    const opened = await this.read(value, undefined, signal);
    signal?.throwIfAborted();
    return opened?.entry ?? null;
  }
  async readText(value: string, options: SourceReadOptions) {
    const result = await this.read(value, options);
    if (!result)
      throw new SourceError("SOURCE_NOT_FOUND", "Source was not found.");
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
    } catch {
      throw new SourceError("SOURCE_NOT_UTF8", "Source is not valid UTF-8.");
    }
  }
  async readBytes(value: string, options: SourceReadOptions) {
    const result = await this.read(value, options);
    if (!result)
      throw new SourceError("SOURCE_NOT_FOUND", "Source was not found.");
    // Verify before exposing any bytes; the caller explicitly bounds buffering.
    return new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(result.bytes!);
        controller.close();
      },
    });
  }
  async list(request: PageRequest) {
    pageLimit(request.limit);
    if (request.cursor) canonicalSourcePath(request.cursor);
    const items: SourceEntry[] = [];
    const root = await fs.realpath(this.root).catch(() => {
      throw new SourceError("SOURCE_UNAVAILABLE");
    });
    const allowed = this.allowed;
    async function* walk(dir: string, prefix = ""): AsyncGenerator<string> {
      request.signal?.throwIfAborted();
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const key = (entry: (typeof entries)[number]) =>
        entry.name + (entry.isDirectory() ? "/" : "");
      entries.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
      for (const entry of entries) {
        const relative = prefix + entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          if (entry.name.startsWith(".") && entry.name !== ".cursor") continue;
          yield* walk(path.join(dir, entry.name), relative + "/");
        } else if (
          entry.isFile() &&
          (!request.cursor || relative > request.cursor) &&
          allowed(relative)
        )
          yield relative;
      }
    }
    try {
      for await (const relative of walk(root)) {
        const entry = await this.stat(relative, request.signal);
        if (entry) items.push(entry);
        if (items.length > request.limit) {
          items.pop();
          return { items, cursor: items.at(-1)!.path };
        }
      }
      return { items };
    } catch (error) {
      request.signal?.throwIfAborted();
      if (error instanceof SourceError) throw error;
      throw new SourceError("SOURCE_UNAVAILABLE");
    }
  }
}

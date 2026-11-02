import fs, { constants, type BigIntStats } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { canonicalSourcePath } from "../portable/source-policy.js";
import { MutationError } from "../portable/mutation-schemas.js";

export interface FileFingerprint {
  dev: string;
  ino: string;
  birth: string;
  digest: string;
}
export interface LocalSnapshot {
  version: string;
  bytes: Uint8Array;
  size: number;
  textHash?: string;
  fingerprint: FileFingerprint;
}
type Parent = { path: string; dev: bigint; ino: bigint; birth: bigint };
export const digestBytes = (bytes: string | Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

/** Internal coordinated-writer boundary; no portable conditional-rename claim. */
export class MutationFilesystem {
  readonly root: string;
  private readonly identity: Parent;
  constructor(
    root: string,
    private readonly vaultId: string,
  ) {
    this.root = path.resolve(root);
    const stat = fs.lstatSync(this.root, { bigint: true });
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      fs.realpathSync(this.root) !== this.root
    )
      throw new MutationError("SOURCE_EXCLUDED");
    this.identity = this.parent(this.root, stat);
  }
  private parent(file: string, stat: BigIntStats): Parent {
    return {
      path: file,
      dev: stat.dev,
      ino: stat.ino,
      birth: stat.birthtimeNs,
    };
  }
  parents(relative: string, create = false): Parent[] {
    canonicalSourcePath(relative);
    this.checkParents([this.identity]);
    const parents = [this.identity];
    let current = this.root;
    for (const part of relative.split("/").slice(0, -1)) {
      current = path.join(current, part);
      let stat: BigIntStats;
      try {
        stat = fs.lstatSync(current, { bigint: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!create) return parents;
        this.checkParents(parents);
        fs.mkdirSync(current, { mode: 0o700 });
        this.syncDirectory(path.dirname(current));
        stat = fs.lstatSync(current, { bigint: true });
      }
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new MutationError("SOURCE_EXCLUDED");
      parents.push(this.parent(current, stat));
    }
    return parents;
  }
  checkParents(parents: Parent[]) {
    for (const parent of parents) {
      const stat = fs.lstatSync(parent.path, { bigint: true });
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.dev !== parent.dev ||
        stat.ino !== parent.ino ||
        stat.birthtimeNs !== parent.birth
      )
        throw new MutationError("SOURCE_REVISION_MISMATCH");
    }
  }
  version(relative: string, fingerprint: FileFingerprint): string {
    return (
      "fs1:" +
      digestBytes(
        JSON.stringify([
          this.vaultId,
          this.identityKey(),
          relative,
          fingerprint,
        ]),
      )
    );
  }
  identityKey(): string {
    return digestBytes(
      JSON.stringify([
        this.root,
        String(this.identity.dev),
        String(this.identity.ino),
        String(this.identity.birth),
      ]),
    );
  }
  read(relative: string, maxBytes: number): LocalSnapshot | null {
    try {
      return this.readSource(relative, maxBytes);
    } catch (error) {
      if (error instanceof MutationError) throw error;
      throw new MutationError("SOURCE_UNAVAILABLE");
    }
  }
  stat(
    relative: string,
    textHash = false,
    maxBytes = Number.MAX_SAFE_INTEGER,
  ): Omit<LocalSnapshot, "bytes"> | null {
    try {
      const snapshot = this.readSource(relative, maxBytes, false, textHash);
      return snapshot
        ? {
            version: snapshot.version,
            fingerprint: snapshot.fingerprint,
            size: snapshot.size,
            textHash: snapshot.textHash,
          }
        : null;
    } catch (error) {
      if (error instanceof MutationError) throw error;
      throw new MutationError("SOURCE_UNAVAILABLE");
    }
  }
  private readSource(
    relative: string,
    maxBytes: number,
    retain = true,
    textHash = false,
  ): LocalSnapshot | null {
    const parents = this.parents(relative);
    const file = path.join(this.root, relative);
    let fd: number;
    try {
      fd = fs.openSync(
        file,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return null;
      if (code === "ELOOP") throw new MutationError("SOURCE_EXCLUDED");
      throw new MutationError("SOURCE_UNAVAILABLE");
    }
    try {
      const before = fs.fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n)
        throw new MutationError("SOURCE_EXCLUDED");
      if (before.ino <= 0n || before.birthtimeNs <= 0n)
        throw new MutationError("SOURCE_WRITE_UNSUPPORTED");
      if (before.size > BigInt(maxBytes))
        throw new MutationError("SIZE_LIMIT_EXCEEDED");
      const chunks: Buffer[] = [];
      const hash = createHash("sha256");
      const text = textHash
        ? new TextDecoder("utf-8", { fatal: true })
        : undefined;
      const normalized = textHash ? createHash("sha256") : undefined;
      const buffer = Buffer.alloc(64 * 1024);
      let size = 0;
      for (;;) {
        const count = fs.readSync(fd, buffer, 0, buffer.length, null);
        if (!count) break;
        size += count;
        if (size > maxBytes) throw new MutationError("SIZE_LIMIT_EXCEEDED");
        hash.update(buffer.subarray(0, count));
        if (text && normalized)
          normalized.update(
            text.decode(buffer.subarray(0, count), { stream: true }),
          );
        if (retain) chunks.push(Buffer.from(buffer.subarray(0, count)));
      }
      const after = fs.fstatSync(fd, { bigint: true });
      this.checkParents(parents);
      const current = fs.lstatSync(file, { bigint: true });
      if (
        !current.isFile() ||
        current.isSymbolicLink() ||
        current.nlink !== 1n ||
        before.ino !== current.ino ||
        before.dev !== current.dev ||
        before.birthtimeNs !== current.birthtimeNs ||
        current.size !== after.size ||
        current.mtimeNs !== after.mtimeNs ||
        current.ctimeNs !== after.ctimeNs ||
        before.size !== after.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs
      )
        throw new MutationError("SOURCE_REVISION_MISMATCH");
      const bytes = Buffer.concat(chunks);
      if (text && normalized) normalized.update(text.decode());
      const fingerprint = {
        dev: String(before.dev),
        ino: String(before.ino),
        birth: String(before.birthtimeNs),
        digest: hash.digest("hex"),
      };
      return {
        bytes,
        size,
        ...(normalized
          ? { textHash: normalized.digest("hex").slice(0, 32) }
          : {}),
        fingerprint,
        version: this.version(relative, fingerprint),
      };
    } finally {
      fs.closeSync(fd);
    }
  }
  syncDirectory(directory: string) {
    const fd = fs.openSync(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }
  writeStage(relative: string, bytes: Uint8Array): FileFingerprint {
    const parents = this.parents(relative);
    this.checkParents(parents);
    const fd = fs.openSync(
      path.join(this.root, relative),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      fs.writeFileSync(fd, bytes);
      fs.fsyncSync(fd);
      const stat = fs.fstatSync(fd, { bigint: true });
      this.checkParents(parents);
      return {
        dev: String(stat.dev),
        ino: String(stat.ino),
        birth: String(stat.birthtimeNs),
        digest: digestBytes(bytes),
      };
    } finally {
      fs.closeSync(fd);
    }
  }
}

import fs from "node:fs";
import {
  randomBytes,
  createHmac,
  timingSafeEqual,
  randomUUID,
} from "node:crypto";
import Database from "better-sqlite3";
import {
  MUTATION_STATE_SQL,
  type MutationPathState,
} from "./mutation-state.js";

export class LocalMutationError extends Error {
  constructor(public readonly code: string) {
    super("Local mutation failed.");
    this.name = "LocalMutationError";
  }
}
export interface MutationResult {
  index: number;
  path: string;
  type: string;
  status: "pending" | "applied" | "failed" | "reconciling";
  code?: string;
  note_id?: string;
  version?: string;
  expected_version?: string;
  index_state?: "pending" | "fresh" | "failed";
  warnings: {
    code: string;
    references?: { note_id: string; path: string }[];
    truncated?: boolean;
  }[];
}
export interface OperationRow {
  id: string;
  digest: string;
  policy: string;
  issued: number;
  expires: number;
  state: "issued" | "applying" | "completed" | "reconciling";
  preview: number;
  completed: number | null;
  cleanup_after: number | null;
}
export interface ItemRow {
  operation_id: string;
  item_index: number;
  path: string;
  state: string;
  result: string;
  recovery: string | null;
  updated: number;
}

export class MutationJournal {
  readonly db: Database.Database;
  constructor(
    readonly file: string,
    private readonly identity: string,
    private readonly now: () => number = Date.now,
  ) {
    // The containing directory is checked by the service before construction.
    if (
      fs.existsSync(file) &&
      (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink())
    )
      throw new LocalMutationError("SOURCE_EXCLUDED");
    const fd = fs.openSync(
      file,
      fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW,
      0o600,
    );
    fs.closeSync(fd);
    fs.chmodSync(file, 0o600);
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(MUTATION_STATE_SQL);
    for (const [table, column] of [
      ["mutation_operations", "completed INTEGER"],
      ["mutation_operations", "cleanup_after INTEGER"],
      ["mutation_items", "updated INTEGER NOT NULL DEFAULT 0"],
    ]) {
      const name = column!.split(" ")[0];
      if (
        !(
          this.db.prepare(`PRAGMA table_info(${table})`).all() as {
            name: string;
          }[]
        ).some((row) => row.name === name)
      )
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column}`);
    }
    if (
      !(
        this.db.prepare("PRAGMA table_info(mutation_paths)").all() as {
          name: string;
        }[]
      ).some((column) => column.name === "index_error")
    )
      this.db.exec("ALTER TABLE mutation_paths ADD COLUMN index_error TEXT");
    this.db
      .transaction(() => {
        this.db
          .prepare("INSERT OR IGNORE INTO mutation_meta VALUES ('identity', ?)")
          .run(identity);
        this.db
          .prepare("INSERT OR IGNORE INTO mutation_meta VALUES ('secret', ?)")
          .run(randomBytes(32).toString("hex"));
        this.db
          .prepare(
            "INSERT OR IGNORE INTO mutation_meta VALUES ('sequence','0')",
          )
          .run();
      })
      .immediate();
    if (this.meta("identity") !== identity) {
      this.db.close();
      throw new LocalMutationError("SOURCE_WRITE_UNSUPPORTED");
    }
    if (!/^[0-9a-f]{64}$/.test(this.meta("secret"))) {
      this.db.close();
      throw new LocalMutationError("OPERATION_INVALID");
    }
    for (const suffix of ["-wal", "-shm"])
      if (fs.existsSync(file + suffix)) fs.chmodSync(file + suffix, 0o600);
  }
  private meta(key: string): string {
    return (
      this.db
        .prepare("SELECT value FROM mutation_meta WHERE key=?")
        .get(key) as { value: string }
    ).value;
  }
  private sign(value: string): string {
    const secret = this.meta("secret");
    if (!/^[0-9a-f]{64}$/.test(secret))
      throw new LocalMutationError("OPERATION_INVALID");
    return createHmac("sha256", Buffer.from(secret, "hex"))
      .update(this.identity + "\0" + value)
      .digest("hex");
  }
  allocate(
    digest: string,
    policy: string,
    now: number,
    days: number,
    preview: boolean,
  ): OperationRow {
    const expires = now + days * 86400000;
    const base = ["m1", now, expires, randomUUID(), digest].join(".");
    const id = base + "." + this.sign(base);
    this.db
      .prepare(
        "INSERT INTO mutation_operations(id,digest,policy,issued,expires,state,preview) VALUES (?,?,?,?,?,'issued',?)",
      )
      .run(id, digest, policy, now, expires, Number(preview));
    return this.operation(id)!;
  }
  verify(
    id: string,
    now: number,
    allowExpired = false,
  ): { digest: string; expires: number } {
    if (typeof id !== "string" || id.length > 300)
      throw new LocalMutationError("OPERATION_INVALID");
    const parts = id.split(".");
    if (
      parts.length !== 6 ||
      parts[0] !== "m1" ||
      !/^\d{1,16}$/.test(parts[1]!) ||
      !/^\d{1,16}$/.test(parts[2]!) ||
      !/^[0-9a-f-]{36}$/.test(parts[3]!) ||
      !/^[0-9a-f]{64}$/.test(parts[4]!) ||
      !/^[0-9a-f]{64}$/.test(parts[5]!)
    )
      throw new LocalMutationError("OPERATION_INVALID");
    const expected = Buffer.from(this.sign(parts.slice(0, 5).join(".")), "hex");
    if (!timingSafeEqual(expected, Buffer.from(parts[5]!, "hex")))
      throw new LocalMutationError("OPERATION_INVALID");
    const issued = Number(parts[1]),
      expires = Number(parts[2]);
    if (
      !Number.isSafeInteger(issued) ||
      !Number.isSafeInteger(expires) ||
      issued > now + 30000 ||
      expires <= issued
    )
      throw new LocalMutationError("OPERATION_INVALID");
    if (!allowExpired && now >= expires)
      throw new LocalMutationError("OPERATION_EXPIRED");
    return { digest: parts[4]!, expires };
  }
  binding(id: string): string {
    return this.sign("preview\0" + id);
  }
  checkBinding(id: string, binding: string | undefined): boolean {
    return (
      typeof binding === "string" &&
      /^[0-9a-f]{64}$/.test(binding) &&
      timingSafeEqual(
        Buffer.from(this.binding(id), "hex"),
        Buffer.from(binding, "hex"),
      )
    );
  }
  operation(id: string): OperationRow | undefined {
    return this.db
      .prepare("SELECT * FROM mutation_operations WHERE id=?")
      .get(id) as OperationRow | undefined;
  }
  items(id: string): ItemRow[] {
    return this.db
      .prepare(
        "SELECT * FROM mutation_items WHERE operation_id=? ORDER BY item_index",
      )
      .all(id) as ItemRow[];
  }
  putItem(
    id: string,
    result: MutationResult,
    state: string,
    recovery: unknown = null,
  ) {
    this.db
      .prepare(
        "INSERT INTO mutation_items(operation_id,item_index,path,state,result,recovery,updated) VALUES (?,?,?,?,?,?,?) ON CONFLICT(operation_id,item_index) DO UPDATE SET state=excluded.state, result=excluded.result, recovery=excluded.recovery,updated=excluded.updated",
      )
      .run(
        id,
        result.index,
        result.path,
        state,
        JSON.stringify(result),
        recovery === null ? null : JSON.stringify(recovery),
        this.now(),
      );
  }
  sequence(): number {
    return Number(this.meta("sequence"));
  }
  path(relative: string): MutationPathState | undefined {
    return this.db
      .prepare("SELECT * FROM mutation_paths WHERE path=?")
      .get(relative) as MutationPathState | undefined;
  }
  putPath(value: Omit<MutationPathState, "sequence" | "index_error">) {
    const sequence = this.sequence() + 1;
    this.db
      .prepare("UPDATE mutation_meta SET value=? WHERE key='sequence'")
      .run(String(sequence));
    this.db
      .prepare(
        "INSERT INTO mutation_paths(path,note_id,version,index_hash,blocked,deleted,pending,sequence) VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(path) DO UPDATE SET note_id=excluded.note_id,version=excluded.version,index_hash=excluded.index_hash,blocked=excluded.blocked,deleted=excluded.deleted,pending=excluded.pending,sequence=excluded.sequence,index_error=NULL",
      )
      .run(
        value.path,
        value.note_id,
        value.version,
        value.index_hash,
        value.blocked,
        value.deleted,
        value.pending,
        sequence,
      );
  }
  finish(id: string) {
    const unresolved = this.items(id).some(
      (item) => !["applied", "failed"].includes(item.state),
    );
    this.db
      .prepare(
        "UPDATE mutation_operations SET state=?,completed=CASE WHEN ? THEN NULL ELSE COALESCE(completed,?) END,cleanup_after=CASE WHEN ? THEN NULL ELSE COALESCE(completed,?)+(expires-issued) END WHERE id=?",
      )
      .run(
        unresolved ? "reconciling" : "completed",
        Number(unresolved),
        this.now(),
        Number(unresolved),
        this.now(),
        id,
      );
  }
  restorePath(relative: string, prior?: MutationPathState) {
    if (prior) {
      this.putPath(prior);
      this.db
        .prepare("UPDATE mutation_paths SET index_error=? WHERE path=?")
        .run(prior.index_error, relative);
    } else {
      this.db.prepare("DELETE FROM mutation_paths WHERE path=?").run(relative);
      this.db
        .prepare("UPDATE mutation_meta SET value=? WHERE key='sequence'")
        .run(String(this.sequence() + 1));
    }
  }
  /** Durable owner claim, separate from intent transactions (never hold a transaction across await). */
  exclusive<T>(run: () => T): T {
    const nonce = randomUUID();
    this.db
      .transaction(() => {
        const row = this.db
          .prepare("SELECT value FROM mutation_meta WHERE key='owner'")
          .get() as { value: string } | undefined;
        if (row) {
          let owner: { pid: number };
          try {
            owner = JSON.parse(row.value);
          } catch {
            throw new LocalMutationError("MUTATION_BUSY");
          }
          if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
            throw new LocalMutationError("MUTATION_BUSY");
          try {
            process.kill(owner.pid, 0);
            throw new LocalMutationError("MUTATION_BUSY");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ESRCH")
              throw new LocalMutationError("MUTATION_BUSY");
          }
        }
        this.db
          .prepare("INSERT OR REPLACE INTO mutation_meta VALUES ('owner',?)")
          .run(JSON.stringify({ pid: process.pid, nonce }));
      })
      .immediate();
    try {
      return run();
    } finally {
      this.db
        .transaction(() => {
          const row = this.db
            .prepare("SELECT value FROM mutation_meta WHERE key='owner'")
            .get() as { value: string } | undefined;
          if (row && JSON.parse(row.value).nonce === nonce)
            this.db
              .prepare("DELETE FROM mutation_meta WHERE key='owner'")
              .run();
        })
        .immediate();
    }
  }
  close() {
    this.db.close();
  }
}

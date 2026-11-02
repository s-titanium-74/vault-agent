import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { IndexError } from "../errors.js";

export const mutationStatePath = (indexPath: string) =>
  path.join(path.dirname(indexPath), "mutations.sqlite");
export interface MutationPathState {
  path: string;
  note_id: string | null;
  version: string | null;
  index_hash: string | null;
  blocked: number;
  deleted: number;
  pending: number;
  sequence: number;
  index_error: string | null;
}
export const MUTATION_STATE_SQL = `
CREATE TABLE IF NOT EXISTS mutation_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS mutation_operations (
  id TEXT PRIMARY KEY, digest TEXT NOT NULL, policy TEXT NOT NULL,
  issued INTEGER NOT NULL, expires INTEGER NOT NULL,
  state TEXT NOT NULL, preview INTEGER NOT NULL, completed INTEGER, cleanup_after INTEGER
);
CREATE TABLE IF NOT EXISTS mutation_items (
  operation_id TEXT NOT NULL, item_index INTEGER NOT NULL, path TEXT NOT NULL,
  state TEXT NOT NULL, result TEXT NOT NULL, recovery TEXT, updated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(operation_id, item_index),
  FOREIGN KEY(operation_id) REFERENCES mutation_operations(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS mutation_paths (
  path TEXT PRIMARY KEY, note_id TEXT, version TEXT, index_hash TEXT,
  blocked INTEGER NOT NULL, deleted INTEGER NOT NULL,
  pending INTEGER NOT NULL, sequence INTEGER NOT NULL, index_error TEXT
);
CREATE INDEX IF NOT EXISTS mutation_path_note ON mutation_paths(note_id);
CREATE INDEX IF NOT EXISTS mutation_operation_expiry ON mutation_operations(expires);
`;

/** Independent of index swaps. An unavailable/corrupt journal must never permit old content. */
export class MutationReadState {
  private db: Database.Database | undefined;
  constructor(private readonly indexPath: string) {}
  connection(): Database.Database | undefined {
    if (!this.db && fs.existsSync(mutationStatePath(this.indexPath))) {
      try {
        this.db = new Database(mutationStatePath(this.indexPath), {
          readonly: true,
          fileMustExist: true,
        });
        this.db.pragma("busy_timeout = 5000");
      } catch {
        throw new IndexError(
          "MUTATION_STATE_UNAVAILABLE",
          "Mutation state is unavailable.",
        );
      }
    }
    return this.db;
  }
  get(relative: string): MutationPathState | undefined {
    try {
      return this.connection()
        ?.prepare("SELECT * FROM mutation_paths WHERE path=?")
        .get(relative) as MutationPathState | undefined;
    } catch {
      throw new IndexError(
        "MUTATION_STATE_UNAVAILABLE",
        "Mutation state is unavailable.",
      );
    }
  }
  visible(row: Record<string, unknown>): boolean {
    const state = this.get(String(row.path));
    return (
      !state ||
      (!state.blocked &&
        !state.deleted &&
        row.content_hash === state.index_hash)
    );
  }
  close() {
    this.db?.close();
    this.db = undefined;
  }
}

export function mutationSequence(indexPath: string): number {
  const reader = new MutationReadState(indexPath);
  try {
    return Number(
      (
        reader
          .connection()
          ?.prepare("SELECT value FROM mutation_meta WHERE key='sequence'")
          .get() as { value: string } | undefined
      )?.value ?? 0,
    );
  } finally {
    reader.close();
  }
}

/** Same short publication lock as source commits; never hold it across await. */
export function withMutationPublication<T>(
  indexPath: string,
  expected: number,
  publish: () => T,
): T {
  const file = mutationStatePath(indexPath);
  if (!fs.existsSync(file)) {
    if (expected !== 0)
      throw new IndexError(
        "SOURCE_REVISION_MISMATCH",
        "Source changed during indexing.",
      );
    return publish();
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(file, { fileMustExist: true });
    db.pragma("busy_timeout = 5000");
    db.exec("BEGIN IMMEDIATE");
    const sequence = Number(
      (
        db
          .prepare("SELECT value FROM mutation_meta WHERE key='sequence'")
          .get() as { value: string }
      ).value,
    );
    if (sequence !== expected)
      throw new IndexError(
        "SOURCE_REVISION_MISMATCH",
        "Source changed during indexing.",
      );
    const result = publish();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db?.inTransaction) db.exec("ROLLBACK");
    if (error instanceof IndexError) throw error;
    throw new IndexError(
      "MUTATION_STATE_UNAVAILABLE",
      "Mutation publication is unavailable.",
    );
  } finally {
    db?.close();
  }
}

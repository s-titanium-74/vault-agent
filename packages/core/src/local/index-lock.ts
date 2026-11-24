import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { z } from "zod";
import { IndexError } from "../errors.js";

const bootId = z.string().uuid();
const pidNamespace = z.string().regex(/^pid:\[\d+\]$/);
const timeNamespace = z
  .string()
  .regex(/^time:\[\d+\]$/)
  .optional();
const startTicks = z.string().regex(/^\d+$/);
const lockRecord = z.object({
  pid: z.number().int().min(1).max(0x7fffffff),
  timestamp: z.number().int().nonnegative(),
  processStart: z
    .object({ bootId, pidNamespace, timeNamespace, startTicks })
    .optional(),
});

type LockRecord = z.infer<typeof lockRecord>;
type LinuxScope = Omit<NonNullable<LockRecord["processStart"]>, "startTicks">;

function linuxTimeNamespace(): string | undefined {
  try {
    return timeNamespace.parse(fs.readlinkSync("/proc/self/ns/time"));
  } catch (error) {
    // Kernels without time namespace support do not expose this link.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return undefined;
  }
}

function linuxScope(): LinuxScope | undefined {
  if (process.platform !== "linux") return;
  try {
    // NSpid is listed from the namespace of the procfs mount down to our own.
    const status = fs.readFileSync("/proc/self/status", "utf8");
    const pids = /^NSpid:[ \t]+(.*)$/m.exec(status)?.[1];
    if (pids?.trim() !== String(process.pid)) return;
    return {
      bootId: bootId.parse(
        fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(),
      ),
      pidNamespace: pidNamespace.parse(fs.readlinkSync("/proc/self/ns/pid")),
      timeNamespace: linuxTimeNamespace(),
    };
  } catch {
    return undefined;
  }
}

function linuxStartTicks(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name may contain spaces and parentheses. Field 3 follows it.
    const endOfName = stat.lastIndexOf(")");
    if (endOfName < 0) return;
    const fields = stat
      .slice(endOfName + 1)
      .trim()
      .split(/\s+/);
    return startTicks.parse(fields[19]);
  } catch {
    return undefined;
  }
}

function ownerExited(
  owner: LockRecord,
  scope: LinuxScope | undefined,
): boolean {
  const observed = owner.processStart;
  if (observed) {
    if (!scope) return false;
    if (scope.bootId !== observed.bootId) return true;
    if (scope.pidNamespace !== observed.pidNamespace) return false;
  }

  try {
    process.kill(owner.pid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }

  if (!observed || scope?.timeNamespace !== observed.timeNamespace)
    return false;
  const currentTicks = linuxStartTicks(owner.pid);
  return currentTicks !== undefined && currentTicks !== observed.startTicks;
}

function readOwner(file: string): LockRecord | undefined {
  let contents: string;
  try {
    contents = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw busy();
  }
  try {
    return lockRecord.parse(JSON.parse(contents));
  } catch {
    throw busy();
  }
}

function busy(pid?: number): IndexError {
  return new IndexError(
    "INDEX_BUSY",
    "The index writer lock is held or its owner could not be verified.",
    pid === undefined ? undefined : { pid },
  );
}

/** Keep the lock connection open until the writer and its cleanup finish. */
export function acquireIndexLock(directory: string): () => void {
  const file = path.join(directory, "index.lock");
  const staging = `${file}.tmp`;
  let guard: Database.Database | undefined;
  try {
    fs.mkdirSync(directory, { recursive: true });
    guard = new Database(path.join(directory, "index-lock.sqlite"), {
      timeout: 0,
    });
    guard.exec("BEGIN IMMEDIATE");

    const scope = linuxScope();
    const owner = readOwner(file);
    if (owner && !ownerExited(owner, scope)) throw busy(owner.pid);

    const ticks = scope && linuxStartTicks(process.pid);
    const record: LockRecord = {
      pid: process.pid,
      timestamp: Date.now(),
      processStart:
        scope && ticks ? { ...scope, startTicks: ticks } : undefined,
    };
    fs.rmSync(staging, { force: true });
    fs.writeFileSync(staging, JSON.stringify(record), {
      flag: "wx",
      mode: 0o600,
    });
    fs.renameSync(staging, file);
  } catch (error) {
    guard?.close();
    if (error instanceof IndexError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "SQLITE_BUSY" || code === "SQLITE_LOCKED") throw busy();
    throw new IndexError(
      "INDEX_UPDATE_FAILED",
      "Unable to acquire the index writer lock.",
    );
  }

  return () => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      throw new IndexError(
        "INDEX_UPDATE_FAILED",
        "Unable to clear the index writer lock.",
      );
    } finally {
      guard.close();
    }
  };
}

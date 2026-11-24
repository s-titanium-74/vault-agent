import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.js";
import { getIndexPath } from "../src/index-store.js";
import { indexVault, reindexVault } from "../src/indexer.js";
import { acquireIndexLock } from "../src/local/index-lock.js";

interface WriterRecord {
  pid: number;
  timestamp: number;
  processStart: {
    bootId: string;
    pidNamespace: string;
    timeNamespace?: string;
    startTicks: string;
  };
}

let root: string;
let config: typeof DEFAULT_CONFIG;
let indexDir: string;
let lock: string;
const children: ChildProcess[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "index-lock-"));
  config = structuredClone(DEFAULT_CONFIG);
  config.vault.root = path.join(root, "vault");
  config.index.dir = path.join(root, "data");
  fs.mkdirSync(config.vault.root);
  fs.writeFileSync(
    path.join(config.vault.root, "Trees.md"),
    "# Synthetic trees\n",
  );
  indexDir = path.dirname(getIndexPath(config));
  fs.mkdirSync(indexDir, { recursive: true });
  lock = path.join(indexDir, "index.lock");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(children.splice(0).map(stopWriter));
  fs.rmSync(root, { recursive: true, force: true });
});

function currentWriterRecord(): WriterRecord {
  const release = acquireIndexLock(indexDir);
  try {
    const record: WriterRecord = JSON.parse(fs.readFileSync(lock, "utf8"));
    expect(record.pid).toBe(process.pid);
    expect(record.processStart?.startTicks).toMatch(/^\d+$/);
    return record;
  } finally {
    release();
  }
}

function recycledPidRecord(): WriterRecord {
  const record = currentWriterRecord();
  record.processStart.startTicks = (
    BigInt(record.processStart.startTicks) + 1n
  ).toString();
  return record;
}

function startWriter(): ChildProcess {
  const child = fork(
    fileURLToPath(new URL("./fixtures/index-lock-writer.ts", import.meta.url)),
    [indexDir],
    { execArgv: ["--import", "tsx"] },
  );
  children.push(child);
  return child;
}

async function stopWriter(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGKILL");
  await exited;
}

it.runIf(process.platform === "linux")(
  "indexes past a stale lock whose PID has been reused",
  async () => {
    fs.writeFileSync(lock, JSON.stringify(recycledPidRecord()));
    await expect(indexVault(config)).resolves.toMatchObject({
      notesIndexed: 1,
    });
    expect(fs.existsSync(lock)).toBe(false);
  },
);

it.runIf(process.platform === "linux")(
  "preserves the record when the PID and start identity match",
  async () => {
    const record = JSON.stringify(currentWriterRecord());
    fs.writeFileSync(lock, record);
    await expect(reindexVault(config)).rejects.toMatchObject({
      code: "INDEX_BUSY",
    });
    expect(fs.readFileSync(lock, "utf8")).toBe(record);
  },
);

it.runIf(process.platform === "linux")(
  "recovers a lock from a previous boot on the same host",
  async () => {
    const record = currentWriterRecord();
    record.processStart.bootId = randomUUID();
    fs.writeFileSync(lock, JSON.stringify(record));
    await expect(reindexVault(config)).resolves.toMatchObject({
      notesIndexed: 1,
    });
    expect(fs.existsSync(lock)).toBe(false);
  },
);

it.runIf(process.platform === "linux").each([
  ["pidNamespace", "pid:[1]"],
  ["timeNamespace", "time:[1]"],
] as const)(
  "preserves a live PID's lock when the %s differs",
  async (field, namespace) => {
    const owner = recycledPidRecord();
    owner.processStart[field] = namespace;
    const record = JSON.stringify(owner);
    fs.writeFileSync(lock, record);
    await expect(indexVault(config)).rejects.toMatchObject({
      code: "INDEX_BUSY",
    });
    expect(fs.readFileSync(lock, "utf8")).toBe(record);
  },
);

it.runIf(process.platform === "linux")(
  "admits only one process recovering the same lock and recovers after it is killed",
  async () => {
    fs.writeFileSync(lock, JSON.stringify(recycledPidRecord()));
    const contenders = [startWriter(), startWriter()];
    await Promise.all(contenders.map((child) => once(child, "message")));
    const decisions = contenders.map((child) => once(child, "message"));
    for (const child of contenders) child.send("acquire");
    const results = (await Promise.all(decisions)).map(([result]) => result);
    expect(results).toEqual(expect.arrayContaining(["acquired", "INDEX_BUSY"]));
    const writer = contenders[results.indexOf("acquired")]!;
    const record = fs.readFileSync(lock, "utf8");
    expect(JSON.parse(record).pid).toBe(writer.pid);
    await expect(reindexVault(config)).rejects.toMatchObject({
      code: "INDEX_BUSY",
    });
    expect(fs.readFileSync(lock, "utf8")).toBe(record);

    await stopWriter(writer);
    expect(fs.readFileSync(lock, "utf8")).toBe(record);
    await expect(reindexVault(config)).resolves.toMatchObject({
      notesIndexed: 1,
    });
    expect(fs.existsSync(lock)).toBe(false);
  },
);

it.each(["ESRCH", "EPERM"])("handles %s for a legacy lock", async (code) => {
  const pid = process.pid;
  const record = JSON.stringify({ pid, timestamp: 1 });
  fs.writeFileSync(lock, record);
  const probe = vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error("Synthetic PID probe failure"), { code });
  });

  if (code === "ESRCH") {
    await expect(reindexVault(config)).resolves.toMatchObject({
      notesIndexed: 1,
    });
    expect(fs.existsSync(lock)).toBe(false);
  } else {
    await expect(indexVault(config)).rejects.toMatchObject({
      code: "INDEX_BUSY",
    });
    expect(fs.readFileSync(lock, "utf8")).toBe(record);
  }
  expect(probe).toHaveBeenCalledWith(pid, 0);
});

it.each([JSON.stringify({ pid: process.pid, timestamp: 1 }), "{"])(
  "preserves a legacy lock when it belongs to a live PID or is malformed",
  async (record) => {
    fs.writeFileSync(lock, record);
    await expect(indexVault(config)).rejects.toMatchObject({
      code: "INDEX_BUSY",
    });
    expect(fs.readFileSync(lock, "utf8")).toBe(record);
  },
);

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  stat,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Command } from "commander";
import {
  registerUploadCommand,
  selectUpload,
  uploadEndpoint,
  cloudRequest,
} from "../src/commands/upload.js";
const vaultId = "00000000-0000-4000-8000-000000000001";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "vault-upload-"));
  await mkdir(path.join(root, "Notes"));
  await mkdir(path.join(root, "images"));
  await writeFile(
    path.join(root, "Notes", "Apple.md"),
    "# Synthetic orchard\nApples.\n",
  );
  await writeFile(path.join(root, "images", "chart.png"), "synthetic-image");
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
  process.exitCode = 0;
});
function cli() {
  const program = new Command();
  registerUploadCommand(program, {
    resolveConfigPath: () => path.join(root, "missing.toml"),
    resolveEndpoint: () => "https://vault.example.invalid",
    resolveApiKey: () => "synthetic-private-token",
  });
  return program;
}
describe("explicit offline upload planning", () => {
  it("applies hidden/generated/user exclusions, rejects symlinks and unsupported attachments", async () => {
    await mkdir(path.join(root, ".git"));
    await writeFile(path.join(root, ".git", "config"), "private-marker");
    await mkdir(path.join(root, "Notes", ".obsidian"));
    await writeFile(
      path.join(root, "Notes", ".obsidian", "config.md"),
      "private-marker",
    );
    for (const file of [".hidden.md", "secret.md", "payload.exe"])
      await writeFile(path.join(root, "Notes", file), "private-marker");
    await symlink(
      path.join(root, "Notes", "Apple.md"),
      path.join(root, "Notes", "link.md"),
    );
    const result = await selectUpload(root, vaultId, ["."], ["**/secret.md"]);
    expect(result.entries.map((e) => e.path)).toEqual([
      "Notes/Apple.md",
      "images/chart.png",
    ]);
    expect(result.skipped).toEqual([
      { path: "Notes/payload.exe", reason: "unsupported_type" },
    ]);
  });
  it("sends no requests, redacts secrets/private root, saves mode-0600 plans and refuses a changed selection before transmission", async () => {
    const user = path.join(root, "user-data");
    vi.stubEnv("XDG_DATA_HOME", user);
    vi.stubEnv("VAULT_AGENT_VAULT_ROOT", root);
    const fetch = vi.fn(() => {
      throw new Error("unexpected network");
    });
    vi.stubGlobal("fetch", fetch);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await cli().parseAsync([
      "node",
      "vault-agent",
      "upload",
      "--vault-id",
      vaultId,
      "--include",
      "Notes",
      "images",
      "--dry-run",
    ]);
    expect(fetch).not.toHaveBeenCalled();
    const output = String(log.mock.calls[0]![0]);
    expect(output).not.toContain("private-token");
    expect(output).not.toContain(root);
    expect(output).not.toContain("Apples.");
    const plan = JSON.parse(output);
    expect(plan.count).toBe(2);
    const file = path.join(
      user,
      "vault-agent-nodejs",
      "uploads",
      plan.planId + ".json",
    );
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    const stored = JSON.parse(await readFile(file, "utf8"));
    expect(stored.entries.map((e: any) => e.path)).toEqual(
      plan.files.map((e: any) => e.path),
    );
    await writeFile(
      path.join(root, "Notes", "New.md"),
      "# New\nChanged selection\n",
    );
    await cli().parseAsync([
      "node",
      "vault-agent",
      "upload",
      "--resume",
      plan.planId,
    ]);
    expect(fetch).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("UPLOAD_PLAN_CHANGED");
  });
  it("requires explicit scope and a clean HTTPS endpoint before reading or sending files", async () => {
    for (const endpoint of [
      "http://localhost:3000",
      "https://user:secret@example.invalid",
      "https://example.invalid/?token=secret",
      "https://example.invalid/subpath",
    ])
      expect(() => uploadEndpoint(endpoint)).toThrow();
    await expect(selectUpload(root, vaultId, [], [])).rejects.toThrow(
      "UPLOAD_SCOPE_REQUIRED",
    );
    await expect(
      selectUpload(root, vaultId, ["../Notes"], []),
    ).rejects.toThrow();
  });
});

it("retries a throttled operation in place so large/resumed uploads make progress", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { code: "RATE_LIMITED" } }), {
        status: 429,
        headers: { "Retry-After": "0" },
      }),
    )
    .mockResolvedValueOnce(Response.json({ data: { state: "uploading" } }));
  vi.stubGlobal("fetch", fetch);
  const result = await cloudRequest(
    "https://vault.example.invalid",
    "synthetic-admin",
    "/uploads",
    "POST",
    { vaultId },
    "synthetic-id",
  );
  expect(result.state).toBe("uploading");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[0]![1].body).toBe(fetch.mock.calls[1]![1].body);
});

import { afterEach, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PCloudSource } from "../src/portable/pcloud.js";
import { SyntheticPCloud } from "./helpers/pcloud.js";
import { contentRevision } from "../src/portable/identifiers.js";
import { DEFAULT_CONFIG, ConfigManager } from "../src/config.js";
import { indexVault } from "../src/indexer.js";
import { getIndexPath, IndexStore } from "../src/index-store.js";
import { getConfiguredNote } from "../src/local/retrieval.js";
import { noteIdFromPath } from "../src/identifiers.js";

const make = (writesEnabled = false) => {
  const api = new SyntheticPCloud();
  api.set("Notes/Apple.md", "# Apple\n\nSynthetic orchard. [[Pear]]\n");
  const source = new PCloudSource({
    vaultId: "synthetic-vault",
    region: "eu",
    folderId: "1",
    accessToken: "synthetic-secret",
    includes: ["Notes"],
    fetch: api.fetch,
    writesEnabled,
  });
  return { api, source };
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
it("preserves 64-bit observation hashes and verifies exact byte digests", async () => {
  const { api, source } = make();
  const [observed] = await source.observe();
  expect(observed!.version).toContain(api.files.get("Notes/Apple.md")!.hash);
  const { entry } = await source.readObserved(observed!);
  expect(entry.revision).toBe(
    await contentRevision(api.files.get(entry.path)!.text),
  );
  expect(
    await source.readText(entry.path, {
      expectedRevision: entry.revision,
      maxBytes: 1024,
    }),
  ).toContain("Synthetic orchard");
  expect(
    api.requests
      .filter((r) => r.host.endsWith("api.pcloud.com"))
      .every(
        (r) =>
          r.host === "eapi.pcloud.com" &&
          r.params.get("access_token") === "synthetic-secret",
      ),
  ).toBe(true);
  expect(
    api.requests
      .filter((r) => r.host === "c1.pcloud.com")
      .every((r) => !r.params.has("access_token")),
  ).toBe(true);
});
it("detects same-size, same-timestamp changes and refuses current content for an old digest", async () => {
  const { api, source } = make();
  const old = (await source.observe())[0]!;
  const { entry } = await source.readObserved(old);
  api.set(old.path, api.files.get(old.path)!.text.replace("Apple", "Plums"));
  await expect(source.readObserved(old)).rejects.toMatchObject({
    code: "SOURCE_REVISION_MISMATCH",
  });
  await expect(
    source.readText(old.path, {
      expectedRevision: entry.revision,
      maxBytes: 1024,
    }),
  ).rejects.toMatchObject({ code: "SOURCE_REVISION_MISMATCH" });
});
it("rejects a change during download before exposing bytes", async () => {
  const { api, source } = make();
  const entry = (await source.observe())[0]!;
  api.onDownload = () => api.set(entry.path, "# Changed\n");
  await expect(source.readObserved(entry)).rejects.toMatchObject({
    code: "SOURCE_REVISION_MISMATCH",
  });
});
it.each([
  "../Notes/Apple.md",
  "/Notes/Apple.md",
  "Notes\\Apple.md",
  "Other.md",
  "Notes/image.svg",
])("rejects unsafe or excluded read %s", async (p) => {
  const { api, source } = make();
  await expect(source.stat(p)).rejects.toBeDefined();
  expect(api.requests).toHaveLength(0);
});
it("rejects partial listing, authentication failure, and unsafe download hosts", async () => {
  const { api, source } = make();
  api.partial = true;
  await expect(source.observe()).rejects.toMatchObject({
    code: "SOURCE_UNAVAILABLE",
  });
  api.partial = false;
  api.failure = 2000;
  await expect(source.observe()).rejects.toMatchObject({
    code: "SOURCE_AUTH_FAILED",
    message: "Source operation failed.",
  });
  api.failure = null;
  api.downloadHost = "private.example.invalid";
  await expect(source.stat("Notes/Apple.md")).rejects.toMatchObject({
    code: "SOURCE_UNAVAILABLE",
  });
});
it("bounds bytes, validates UTF-8 and sanitizes transport and abort errors", async () => {
  const { api, source } = make();
  const [e] = await source.observe();
  await expect(
    source.readText(e!.path, { expectedRevision: "0".repeat(64), maxBytes: 1 }),
  ).rejects.toMatchObject({ code: "SOURCE_TOO_LARGE" });
  const controller = new AbortController();
  controller.abort(new Error("private abort reason"));
  await expect(source.observe(controller.signal)).rejects.toMatchObject({
    code: "SOURCE_UNAVAILABLE",
    message: "Source operation failed.",
  });
  api.fetch = async () => {
    throw new Error("private URL and secret");
  };
  const broken = new PCloudSource({
    vaultId: "test",
    region: "us",
    folderId: "1",
    accessToken: "secret",
    includes: ["."],
    fetch: api.fetch,
  });
  await expect(broken.observe()).rejects.toMatchObject({
    code: "SOURCE_UNAVAILABLE",
    message: "Source operation failed.",
  });
});
it("uses existing SQLite updates for additions, edits, link changes, rename and delete", async () => {
  const { api } = make();
  vi.stubGlobal("fetch", api.fetch);
  const dir = await mkdtemp(path.join(os.tmpdir(), "pcloud-local-"));
  let store: IndexStore | undefined;
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.index.dir = dir;
    config.vault.pcloud = {
      region: "eu",
      folder_id: "1",
      access_token: "synthetic-secret",
      includes: ["Notes"],
      poll_seconds: 300,
    };
    expect((await indexVault(config)).notesIndexed).toBe(1);
    store = await IndexStore.open(getIndexPath(config));
    const id = noteIdFromPath("Notes/Apple.md");
    expect((await getConfiguredNote(store, id, config))!.content).toContain(
      "Synthetic orchard",
    );
    const before = store.getAllNotes();
    api.requests.length = 0;
    expect((await indexVault(config)).notesIndexed).toBe(0);
    expect(store.getAllNotes()).toEqual(before);
    expect(
      api.requests.filter((r) => r.host === api.downloadHost),
    ).toHaveLength(0);
    api.set("Notes/Pear.md", "# Pear\n\nSynthetic fruit.\n");
    await indexVault(config);
    expect(JSON.parse(String(store.getNote(id)!.links_json))).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ resolved: noteIdFromPath("Notes/Pear.md") }),
      ]),
    );
    api.requests.length = 0;
    api.set("Notes/Pear.md", "# Pear\n\nSynthetic plant.\n");
    expect((await indexVault(config)).notesIndexed).toBe(1);
    expect(
      api.requests.filter((r) => r.host === api.downloadHost),
    ).toHaveLength(1);
    api.set("Notes/Plum.md", api.files.get("Notes/Pear.md")!.text);
    api.files.delete("Notes/Pear.md");
    await indexVault(config);
    expect(store.getNote(noteIdFromPath("Notes/Pear.md"))).toBeNull();
    expect(store.getNote(noteIdFromPath("Notes/Plum.md"))).not.toBeNull();
    const preserved = store.getAllNotes();
    api.partial = true;
    await expect(indexVault(config)).rejects.toBeDefined();
    expect(store.getAllNotes()).toEqual(preserved);
    api.partial = false;
    api.set("Notes/Apple.md", "# Apple\n\nChanged orchard.\n");
    api.onDownload = () => api.set("Notes/New.md", "# New\n");
    await expect(indexVault(config)).rejects.toMatchObject({
      code: "SOURCE_REVISION_MISMATCH",
    });
    expect(store.getAllNotes()).toEqual(preserved);
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it("loads opt-in user-local config with an environment secret without persisting it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pcloud-config-"));
  try {
    const file = path.join(dir, "config.toml");
    await writeFile(
      file,
      '[vault.pcloud]\nregion="eu"\nfolder_id="1"\nincludes=["Notes"]\n',
    );
    vi.stubEnv("VAULT_AGENT_PCLOUD_ACCESS_TOKEN", "synthetic-env-token");
    const manager = new ConfigManager(file);
    expect(manager.load().vault.pcloud!.access_token).toBe(
      "synthetic-env-token",
    );
    expect(manager.isSecretKey("vault.pcloud.access_token")).toBe(true);
    manager.set("server.port", 8788);
    expect(await readFile(file, "utf8")).not.toContain("synthetic-env-token");
    expect(manager.load().vault.pcloud!.access_token).toBe(
      "synthetic-env-token",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("pins pagination to one provider observation and rejects changes between pages", async () => {
  const { api, source } = make();
  api.set("Notes/Pear.md", "# Pear\n");
  const first = await source.list({ limit: 1 });
  expect(first.items).toHaveLength(1);
  expect(first.cursor).toBeDefined();
  const second = await source.list({ limit: 1, cursor: first.cursor });
  expect(second.items[0]!.path).toBe("Notes/Pear.md");
  expect(second.cursor).toBeUndefined();
  api.set("Notes/New.md", "# New\n");
  await expect(
    source.list({ limit: 1, cursor: first.cursor }),
  ).rejects.toMatchObject({ code: "SOURCE_REVISION_MISMATCH" });
});
it("rejects invalid UTF-8 and redirects without forwarding credentials", async () => {
  const api = new SyntheticPCloud();
  api.set("Notes/Bad.md", "x");
  const binary: typeof fetch = async (input, init) =>
    String(input).includes("c1.pcloud.com")
      ? new Response(new Uint8Array([255]))
      : api.fetch(input, init);
  const source = new PCloudSource({
    vaultId: "test",
    region: "us",
    folderId: "1",
    accessToken: "secret",
    includes: ["Notes"],
    fetch: binary,
  });
  await expect(source.stat("Notes/Bad.md")).rejects.toMatchObject({
    code: "SOURCE_NOT_UTF8",
  });
  const redirect = new PCloudSource({
    vaultId: "test",
    region: "us",
    folderId: "1",
    accessToken: "secret",
    includes: ["Notes"],
    fetch: async (_input, init) => {
      expect(init!.redirect).toBe("manual");
      return new Response(null, {
        status: 302,
        headers: { Location: "https://private.example.invalid" },
      });
    },
  });
  await expect(redirect.observe()).rejects.toMatchObject({
    code: "SOURCE_UNAVAILABLE",
  });
});

it("enforces rate limits and deadlines with fixed failures", async () => {
  const limited = new PCloudSource({
    vaultId: "test",
    region: "us",
    folderId: "1",
    accessToken: "secret",
    includes: ["Notes"],
    fetch: async () => new Response(null, { status: 429 }),
  });
  await expect(limited.observe()).rejects.toMatchObject({
    code: "SOURCE_RATE_LIMITED",
  });
  const delayed = new PCloudSource({
    vaultId: "test",
    region: "us",
    folderId: "1",
    accessToken: "secret",
    includes: ["Notes"],
    timeoutMs: 10,
    fetch: async (_input, init) =>
      new Promise((_resolve, reject) => {
        init!.signal!.addEventListener(
          "abort",
          () => reject(new Error("private transport error")),
          { once: true },
        );
      }),
  });
  await expect(delayed.observe()).rejects.toMatchObject({
    code: "SOURCE_UNAVAILABLE",
    message: "Source operation failed.",
  });
});
it("excludes guidance, hidden files and configured exclusions from observations", async () => {
  const api = new SyntheticPCloud();
  for (const p of [
    "Notes/Good.md",
    "Notes/AGENTS.md",
    "Notes/.hidden.md",
    "Notes/Skip.md",
  ])
    api.set(p, "# Synthetic\n");
  const source = new PCloudSource({
    vaultId: "test",
    region: "us",
    folderId: "1",
    accessToken: "secret",
    includes: ["Notes"],
    excludes: ["**/Skip.md"],
    fetch: api.fetch,
  });
  expect((await source.observe()).map((e) => e.path)).toEqual([
    "Notes/Good.md",
  ]);
});

it("verifies scoped writes against exact revisions and reads back the result", async () => {
  const { source, api } = make(true);
  const original = (await source.stat("Notes/Apple.md"))!;
  const bytes = new TextEncoder().encode("# Updated");
  await expect(
    source.writeNote("Notes/Apple.md", null, bytes),
  ).rejects.toMatchObject({
    code: "SOURCE_REVISION_MISMATCH",
  });
  await expect(
    source.writeNote("Outside.md", null, bytes),
  ).rejects.toMatchObject({
    code: "SOURCE_EXCLUDED",
  });
  expect(api.requests.some((request) => request.method === "/uploadfile")).toBe(
    false,
  );
  const updated = (await source.writeNote(
    original.path,
    original.revision,
    bytes,
  ))!;
  expect(updated.revision).toBe(await contentRevision(bytes));
  await expect(
    source.writeNote(original.path, original.revision, null),
  ).rejects.toMatchObject({
    code: "SOURCE_REVISION_MISMATCH",
  });
  const created = (await source.writeNote("Notes/New/Pear.md", null, bytes))!;
  await expect(
    source.writeNote(created.path, created.revision, null),
  ).resolves.toBeNull();
  expect(api.files.has(created.path)).toBe(false);
});

it("requires explicit opt-in for pCloud writes", async () => {
  const { source, api } = make();
  await expect(
    source.writeNote("Notes/Apple.md", null, null),
  ).rejects.toMatchObject({
    code: "SOURCE_UNAVAILABLE",
  });
  expect(api.requests).toHaveLength(0);
});

it("indexes more than 1,000 pCloud notes locally and downloads only the changed body", async () => {
  const { api, source } = make();
  const note = (i: number) => `Notes/Group-${Math.floor(i / 100)}/Note-${i}.md`;
  api.files.clear();
  for (let i = 0; i < 1001; i++)
    api.set(note(i), `# Synthetic note ${i}\n\nSynthetic orchard.`);
  await expect(source.observe()).rejects.toMatchObject({
    code: "SOURCE_TOO_LARGE",
  });
  vi.stubGlobal("fetch", api.fetch);
  const dir = await mkdtemp(path.join(os.tmpdir(), "pcloud-large-local-"));
  const config = structuredClone(DEFAULT_CONFIG);
  config.index.dir = dir;
  config.vault.pcloud = {
    region: "eu",
    folder_id: "1",
    access_token: "synthetic-secret",
    includes: ["Notes"],
    poll_seconds: 300,
  };
  const downloads = () =>
    api.requests.filter((request) => request.host === api.downloadHost).length;
  let store: IndexStore | undefined;
  try {
    api.requests.length = 0;
    expect((await indexVault(config)).notesIndexed).toBe(1001);
    expect(downloads()).toBe(1001);
    api.requests.length = 0;
    expect((await indexVault(config)).notesIndexed).toBe(0);
    expect(downloads()).toBe(0);
    api.set(note(999), "# Revised\n\nSynthetic garden.");
    expect((await indexVault(config)).notesIndexed).toBe(1);
    expect(downloads()).toBe(1);
    store = await IndexStore.open(getIndexPath(config));
    expect(
      (await getConfiguredNote(store, noteIdFromPath(note(999)), config))
        ?.content,
    ).toContain("Synthetic garden");
  } finally {
    store?.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 30_000);

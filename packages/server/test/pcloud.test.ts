import { expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DEFAULT_CONFIG } from "../../core/src/config.js";
import { IndexStore, getIndexPath } from "../../core/src/index-store.js";
import { indexVault } from "../../core/src/indexer.js";
import { noteIdFromPath } from "../../core/src/identifiers.js";
import { SyntheticPCloud } from "../../core/test/helpers/pcloud.js";
import { createServer, initApp, resetApp } from "../src/index.js";

it("serves pCloud search and explicit note/chunk retrieval through the local HTTP API", async () => {
  const api = new SyntheticPCloud();
  api.set("Notes/Apple.md", "# Apple\n\nSynthetic orchard.\n");
  vi.stubGlobal("fetch", api.fetch);
  const dir = await mkdtemp(path.join(os.tmpdir(), "pcloud-http-"));
  let store: IndexStore | undefined;
  let app: Awaited<ReturnType<typeof createServer>> | undefined;
  try {
    const config = structuredClone(DEFAULT_CONFIG);
    config.index.dir = dir;
    config.server.logLevel = "error";
    config.vault.pcloud = {
      region: "eu",
      folder_id: "1",
      access_token: "synthetic-secret",
      includes: ["Notes"],
      poll_seconds: 300,
    };
    await indexVault(config);
    store = await IndexStore.open(getIndexPath(config));
    initApp(store, config);
    app = await createServer(config);
    const id = noteIdFromPath("Notes/Apple.md");
    const calls = api.requests.length;
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/search",
          payload: { query: "orchard", mode: "lexical" },
        })
      ).statusCode,
    ).toBe(200);
    expect(api.requests).toHaveLength(calls);
    expect((await app.inject(`/notes/${id}`)).json().data.content).toContain(
      "Synthetic orchard",
    );
    expect((await app.inject(`/chunks/${id}/0`)).statusCode).toBe(200);
    expect((await app.inject("/attachments/image.svg")).statusCode).toBe(501);
    expect((await app.inject("/agent-guidance")).statusCode).toBe(501);
    expect((await app.inject("/status")).json().data.source).toMatchObject({
      provider: "pcloud",
      pollIntervalSeconds: 300,
    });
    api.set("Notes/Apple.md", "# Apple\n\nUpdated synthetic orchard.\n");
    const mismatch = await app.inject(`/notes/${id}`);
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json().error.code).toBe("SOURCE_REVISION_MISMATCH");
    expect(
      (await app.inject({ method: "POST", url: "/index", payload: {} }))
        .statusCode,
    ).toBe(200);
    expect((await app.inject(`/notes/${id}`)).json().data.content).toContain(
      "Updated synthetic",
    );
    api.failure = 2000;
    const failure = await app.inject(`/notes/${id}`);
    expect(failure.statusCode).toBe(503);
    expect(failure.body).not.toContain("synthetic-secret");
    expect(failure.body).not.toContain("provider text");
  } finally {
    await app?.close();
    resetApp();
    store?.close();
    vi.unstubAllGlobals();
    await rm(dir, { recursive: true, force: true });
  }
});

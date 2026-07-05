import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer, initApp, resetApp } from "../src/index.js";
import {
  Config,
  DEFAULT_CONFIG,
  IndexStore,
  indexVault,
  getIndexPath,
} from "@vault-agent/core";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-profile-server-vault-"),
  );

  fs.mkdirSync(path.join(vaultDir, "Projects"), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, "Projects", "App.md"),
    `---
title: "App"
tags:
  - project
type: project
status: active
---

# App

See [[Guide]].

## References

![Image](image.png)
`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Guide.md"),
    `---
title: "Guide"
tags:
  - guide
---

# Guide

Guide content.
`,
  );

  return vaultDir;
}

function createTestConfig(vaultRoot: string, indexDir: string): Config {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    vault: { root: vaultRoot, exclude: [] },
    server: { ...DEFAULT_CONFIG.server },
    index: { dir: indexDir },
    embedding: { ...DEFAULT_CONFIG.embedding },
    cors: { ...DEFAULT_CONFIG.cors },
  };
}

describe("Profile Routes", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;
  let app: Awaited<ReturnType<typeof createServer>>;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-profile-server-idx-"),
    );
    config = createTestConfig(vaultDir, indexDir);

    await indexVault(config);
    store = await IndexStore.open(getIndexPath(config));

    app = await createServer(config);
    initApp(store, config);
  });

  afterEach(async () => {
    try {
      store?.close();
    } catch {}
    try {
      await app?.close();
    } catch {}
    resetApp();
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("returns metadata profile for a path prefix", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/profiles/metadata?pathPrefix=Projects&limit=10",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.scope).toMatchObject({
      pathPrefix: "Projects",
      noteCount: 1,
    });
    expect(body.data.frontmatterKeys).toContainEqual({
      name: "type",
      noteCount: 1,
      values: [{ value: "project", noteCount: 1 }],
    });
  });

  it("returns metadata profile with tag and frontmatter filters", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/profiles/metadata?tag=project&frontmatterStatus=active&limit=10",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.scope.noteCount).toBe(1);
    expect(body.data.scope.filters.tags).toEqual(["project"]);
    expect(body.data.scope.filters.frontmatter.status).toEqual(["active"]);
    expect(body.data.examples[0].path).toBe("Projects/App.md");
  });

  it("returns style profile for a path prefix", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/profiles/style?pathPrefix=Projects&limit=10",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.data.scope.noteCount).toBe(1);
    expect(body.data.links.wikiLinkCount).toBe(1);
    expect(body.data.attachments.totalAttachmentReferences).toBe(1);
  });

  it("rejects unsafe path prefixes", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/profiles/style?pathPrefix=../Private",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_PATH_FILTER");
  });

  it("rejects invalid note IDs", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/profiles/metadata?noteId=not-a-note-id",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("INVALID_PARAMETER");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { indexVault } from "../src/indexer.js";
import {
  getOverview,
  getTree,
  getTags,
  getFacets,
} from "../src/orientation.js";
import { SearchError } from "../src/errors.js";
import { Config, DEFAULT_CONFIG } from "../src/config.js";
import { FreshnessMachine } from "../src/freshness.js";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-orientation-"),
  );

  fs.mkdirSync(path.join(vaultDir, "Projects"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "Projects", "WebApp"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "Areas"), { recursive: true });

  fs.writeFileSync(
    path.join(vaultDir, "Projects", "WebApp", "Frontend.md"),
    `---
title: "Frontend"
tags:
  - project
  - web
  - meeting
type: project
status: active
priority: high
---

# Frontend

Frontend content.`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Projects", "API.md"),
    `---
title: "API"
tags:
  - project
  - api
type:
  - project
  - client
status: draft
---

# API

API content.`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Areas", "Health.md"),
    `---
title: "Health"
tags:
  - area
  - meeting
status: active
---

# Health

Health content.`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "RootNote.md"),
    `---
title: "Root Note"
tags:
  - root
---

# Root Note

Root content with inline #ignored-tag in body.`,
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

function makeContext(
  config: Config,
  store: unknown,
  freshnessMachine?: FreshnessMachine,
) {
  return {
    store: store as import("../src/index-store.js").IndexStore,
    config,
    freshnessMachine: freshnessMachine ?? null,
  };
}

describe("orientation", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-orientation-idx-"),
    );
    config = createTestConfig(vaultDir, indexDir);
    await indexVault(config);
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  describe("getOverview", () => {
    it("returns counts, folders, tags, and fields", async () => {
      const { IndexStore, getIndexPath } =
        await import("../src/index-store.js");
      const store = await IndexStore.open(getIndexPath(config));
      try {
        const ctx = makeContext(config, store);
        const result = getOverview(ctx);

        expect(result.data.noteCount).toBe(4);
        expect(result.data.topLevelFolders).toHaveLength(2);
        expect(result.data.topLevelFolders[0].path).toBe("Projects");
        expect(result.data.topLevelFolders[0].noteCount).toBe(2);
        expect(result.data.topLevelFolders[1].path).toBe("Areas");
        expect(result.data.topLevelFolders[1].noteCount).toBe(1);

        expect(result.data.topTags).toContainEqual({
          tag: "meeting",
          noteCount: 2,
        });
        expect(result.data.topTags).toContainEqual({
          tag: "project",
          noteCount: 2,
        });

        expect(result.data.frontmatterFields).toContainEqual({
          name: "type",
          noteCount: 2,
        });
        expect(result.data.frontmatterFields).toContainEqual({
          name: "status",
          noteCount: 3,
        });

        expect(result.data.indexFreshness).toBe("fresh");
      } finally {
        store.close();
      }
    });

    it("does not include inline body tags", async () => {
      const { IndexStore, getIndexPath } =
        await import("../src/index-store.js");
      const store = await IndexStore.open(getIndexPath(config));
      try {
        const ctx = makeContext(config, store);
        const result = getOverview(ctx);

        const tags = result.data.topTags.map((t) => t.tag);
        expect(tags).not.toContain("ignored-tag");
      } finally {
        store.close();
      }
    });

    it("throws INDEX_NOT_FOUND when no manifest exists", async () => {
      const { IndexStore, getIndexPath } =
        await import("../src/index-store.js");
      const emptyIndexDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "vault-agent-empty-idx-"),
      );
      const emptyConfig = createTestConfig(vaultDir, emptyIndexDir);
      const store = await IndexStore.open(getIndexPath(emptyConfig));
      try {
        const ctx = makeContext(emptyConfig, store);
        expect(() => getOverview(ctx)).toThrow(SearchError);
        try {
          getOverview(ctx);
        } catch (error) {
          expect((error as SearchError).code).toBe("INDEX_NOT_FOUND");
        }
      } finally {
        store.close();
        fs.rmSync(emptyIndexDir, { recursive: true, force: true });
      }
    });
  });

  describe("getTree", () => {
    it("returns bounded tree with root node", async () => {
      const { IndexStore, getIndexPath } =
        await import("../src/index-store.js");
      const store = await IndexStore.open(getIndexPath(config));
      try {
        const ctx = makeContext(config, store);
        const result = getTree(ctx, { depth: 2, limit: 50 });

        expect(result.data.tree.path).toBe("");
        expect(result.data.tree.noteCount).toBe(4);
        expect(result.data.tree.children).toHaveLength(2);

        const projects = result.data.tree.children.find(
          (c) => c.path === "Projects",
        );
        expect(projects).toBeDefined();
        expect(projects!.children).toHaveLength(0);
      } finally {
        store.close();
      }
    });

    it("expands to requested depth", async () => {
      const { IndexStore, getIndexPath } =
        await import("../src/index-store.js");
      const store = await IndexStore.open(getIndexPath(config));
      try {
        const ctx = makeContext(config, store);
        const result = getTree(ctx, { depth: 3, limit: 50 });

        const projects = result.data.tree.children.find(
          (c) => c.path === "Projects",
        );
        expect(projects).toBeDefined();
        expect(projects!.children).toHaveLength(1);
        expect(projects!.children[0].path).toBe("Projects/WebApp");
      } finally {
        store.close();
      }
    });

    it("respects directOnly", async () => {
      const { IndexStore, getIndexPath } =
        await import("../src/index-store.js");
      const store = await IndexStore.open(getIndexPath(config));
      try {
        const ctx = makeContext(config, store);
        const result = getTree(ctx, { depth: 2, limit: 50, directOnly: true });

        const projects = result.data.tree.children.find(
          (c) => c.path === "Projects",
        );
        expect(projects!.noteCount).toBe(1);
      } finally {
        store.close();
      }
    });

    it("truncates when limit is exceeded", async () => {
      const { IndexStore, getIndexPath } =
        await import("../src/index-store.js");
      const store = await IndexStore.open(getIndexPath(config));
      try {
        const ctx = makeContext(config, store);
        const result = getTree(ctx, { depth: 2, limit: 1 });

        expect(result.data.tree.children).toHaveLength(0);
        expect(
          result.warnings.some((w) => w.code === "TREE_LIMIT_EXCEEDED"),
        ).toBe(true);
      } finally {
        store.close();
      }
    });
  });

  describe("getTags", () => {
    it("returns note-level tag counts", async () => {
      const { IndexStore, getIndexPath } =
        await import("../src/index-store.js");
      const store = await IndexStore.open(getIndexPath(config));
      try {
        const ctx = makeContext(config, store);
        const result = getTags(ctx, { limit: 10 });

        expect(result.data.tags).toContainEqual({
          tag: "meeting",
          noteCount: 2,
        });
        expect(result.data.tags).toContainEqual({
          tag: "project",
          noteCount: 2,
        });
      } finally {
        store.close();
      }
    });
  });

  describe("getFacets", () => {
    it("returns allowlisted field values", async () => {
      const { IndexStore, getIndexPath } =
        await import("../src/index-store.js");
      const store = await IndexStore.open(getIndexPath(config));
      try {
        const ctx = makeContext(config, store);
        const result = getFacets(ctx, { limit: 10 });

        const typeField = result.data.fields.find((f) => f.name === "type");
        expect(typeField).toBeDefined();
        expect(typeField!.values).toContainEqual({
          value: "project",
          noteCount: 2,
        });

        const statusField = result.data.fields.find((f) => f.name === "status");
        expect(statusField).toBeDefined();
        expect(statusField!.values).toContainEqual({
          value: "active",
          noteCount: 2,
        });
        expect(statusField!.values).toContainEqual({
          value: "draft",
          noteCount: 1,
        });
      } finally {
        store.close();
      }
    });

    it("expands array-valued allowlisted fields", async () => {
      const { IndexStore, getIndexPath } =
        await import("../src/index-store.js");
      const store = await IndexStore.open(getIndexPath(config));
      try {
        const ctx = makeContext(config, store);
        const result = getFacets(ctx, { limit: 10 });

        const typeField = result.data.fields.find((f) => f.name === "type");
        expect(typeField).toBeDefined();
        expect(typeField!.values).toContainEqual({
          value: "project",
          noteCount: 2,
        });
        expect(typeField!.values).toContainEqual({
          value: "client",
          noteCount: 1,
        });
      } finally {
        store.close();
      }
    });

    it("includes known frontmatter fields without values", async () => {
      const { IndexStore, getIndexPath } =
        await import("../src/index-store.js");
      const store = await IndexStore.open(getIndexPath(config));
      try {
        const ctx = makeContext(config, store);
        const result = getFacets(ctx, { limit: 10 });

        const tagsField = result.data.fields.find((f) => f.name === "tags");
        expect(tagsField).toBeDefined();
        expect(tagsField!.values).toBeUndefined();
      } finally {
        store.close();
      }
    });

    it("does not expose values for non-allowlisted fields", async () => {
      const { IndexStore, getIndexPath } =
        await import("../src/index-store.js");
      const store = await IndexStore.open(getIndexPath(config));
      try {
        const ctx = makeContext(config, store);
        const result = getFacets(ctx, { limit: 10 });

        const priorityField = result.data.fields.find(
          (f) => f.name === "priority",
        );
        expect(priorityField).toBeDefined();
        expect(priorityField!.values).toBeUndefined();
      } finally {
        store.close();
      }
    });
  });
});

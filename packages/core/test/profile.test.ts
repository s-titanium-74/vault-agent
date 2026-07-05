import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { indexVault } from "../src/indexer.js";
import { getMetadataProfile, getStyleProfile } from "../src/profile.js";
import { Config, DEFAULT_CONFIG } from "../src/config.js";

function createTestVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-profile-"),
  );

  fs.mkdirSync(path.join(vaultDir, "Projects", "App"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "Areas"), { recursive: true });

  fs.writeFileSync(
    path.join(vaultDir, "Projects", "App", "Project Plan.md"),
    `---
title: "Project Plan"
tags:
  - project
  - app
type: project
status: active
secret: private-value
---

# Project Plan

See [[Architecture]] and [Spec](Architecture.md).

## References

![Diagram](diagram.png)
`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Projects", "App", "Architecture.md"),
    `---
title: "Architecture"
tags:
  - project
type: design
status: draft
---

# Architecture

## References

Content.
`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Areas", "Health.md"),
    `---
title: "Health"
tags:
  - area
status: active
---

# Health

Content.
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

describe("profile discovery", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;

  beforeEach(async () => {
    vaultDir = createTestVault();
    indexDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "vault-agent-profile-idx-"),
    );
    config = createTestConfig(vaultDir, indexDir);
    await indexVault(config);
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("returns metadata aggregates for a path prefix without unallowlisted values", async () => {
    const { IndexStore, getIndexPath } = await import("../src/index-store.js");
    const store = await IndexStore.open(getIndexPath(config));
    try {
      const result = getMetadataProfile(
        { store, config, freshnessMachine: null },
        { pathPrefix: "Projects/App", limit: 10 },
      );

      expect(result.data.scope).toMatchObject({
        pathPrefix: "Projects/App",
        noteCount: 2,
      });
      const typeField = result.data.frontmatterKeys.find(
        (field) => field.name === "type",
      );
      expect(typeField?.values).toContainEqual({
        value: "project",
        noteCount: 1,
      });
      expect(typeField?.values).toContainEqual({
        value: "design",
        noteCount: 1,
      });

      const secretField = result.data.frontmatterKeys.find(
        (field) => field.name === "secret",
      );
      expect(secretField?.noteCount).toBe(1);
      expect(secretField?.values).toBeUndefined();
      expect(JSON.stringify(result.data)).not.toContain("private-value");
    } finally {
      store.close();
    }
  });

  it("filters profiles by tag, frontmatter, and explicit note IDs", async () => {
    const { IndexStore, getIndexPath } = await import("../src/index-store.js");
    const { noteIdFromPath } = await import("../src/identifiers.js");
    const store = await IndexStore.open(getIndexPath(config));
    try {
      const architectureId = noteIdFromPath("Projects/App/Architecture.md");
      const result = getMetadataProfile(
        { store, config, freshnessMachine: null },
        {
          filters: {
            tags: ["project"],
            frontmatter: { status: ["draft"] },
            noteIds: [architectureId],
          },
          limit: 10,
        },
      );

      expect(result.data.scope.noteCount).toBe(1);
      expect(result.data.examples).toEqual([
        {
          noteId: architectureId,
          path: "Projects/App/Architecture.md",
          title: "Architecture",
        },
      ]);
      expect(
        result.data.frontmatterKeys.find((f) => f.name === "status"),
      ).toMatchObject({
        values: [{ value: "draft", noteCount: 1 }],
      });
    } finally {
      store.close();
    }
  });

  it("uses user-local profile value allowlist for additional frontmatter values", async () => {
    const { IndexStore, getIndexPath } = await import("../src/index-store.js");
    const store = await IndexStore.open(getIndexPath(config));
    try {
      const allowedConfig = {
        ...config,
        profiles: { frontmatter_value_allowlist: ["secret"] },
      };
      const result = getMetadataProfile(
        { store, config: allowedConfig, freshnessMachine: null },
        { pathPrefix: "Projects/App", limit: 10 },
      );

      const secretField = result.data.frontmatterKeys.find(
        (field) => field.name === "secret",
      );
      expect(secretField?.values).toEqual([
        { value: "private-value", noteCount: 1 },
      ]);
    } finally {
      store.close();
    }
  });

  it("returns style aggregates without note bodies", async () => {
    const { IndexStore, getIndexPath } = await import("../src/index-store.js");
    const store = await IndexStore.open(getIndexPath(config));
    try {
      const result = getStyleProfile(
        { store, config, freshnessMachine: null },
        { pathPrefix: "Projects/App", limit: 10 },
      );

      expect(result.data.scope.noteCount).toBe(2);
      expect(result.data.headings.h1MatchesTitleCount).toBe(2);
      expect(result.data.headings.commonHeadingNames).toContainEqual({
        heading: "References",
        noteCount: 2,
      });
      expect(result.data.links.wikiLinkCount).toBe(1);
      expect(result.data.links.markdownLinkCount).toBe(1);
      expect(result.data.attachments.totalAttachmentReferences).toBe(2);
      expect(JSON.stringify(result.data)).not.toContain("Content.");
    } finally {
      store.close();
    }
  });

  it("can select representative examples deterministically", async () => {
    const { IndexStore, getIndexPath } = await import("../src/index-store.js");
    const store = await IndexStore.open(getIndexPath(config));
    try {
      const result = getStyleProfile(
        { store, config, freshnessMachine: null },
        {
          pathPrefix: "Projects/App",
          limit: 1,
          exampleSelection: "representative",
        },
      );

      expect(result.data.scope.exampleSelection).toBe("representative");
      expect(result.data.examples[0].path).toBe("Projects/App/Project Plan.md");
    } finally {
      store.close();
    }
  });
});

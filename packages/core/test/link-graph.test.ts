import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  Config,
  DEFAULT_CONFIG,
  IndexStore,
  getBacklinks,
  getBrokenLinks,
  getLinkSummary,
  getNoteLinks,
  getOrphanNotes,
  indexVault,
  noteIdFromPath,
  getIndexPath,
} from "../src/index.js";

function createLinkVault(): string {
  const vaultDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "vault-agent-link-graph-"),
  );

  fs.writeFileSync(
    path.join(vaultDir, "Index.md"),
    `# Index

See [[Plan]] and [[Missing Note]].

Embedded attachment: ![[diagram.pdf]].`,
  );

  fs.writeFileSync(
    path.join(vaultDir, "Plan.md"),
    `# Plan

See [[Architecture|Architecture doc]] and [Architecture again](Architecture.md).`,
  );

  fs.writeFileSync(path.join(vaultDir, "Architecture.md"), "# Architecture\n");
  fs.writeFileSync(path.join(vaultDir, "Orphan.md"), "# Orphan\n");
  fs.mkdirSync(path.join(vaultDir, "Projects"), { recursive: true });
  fs.mkdirSync(path.join(vaultDir, "Archive"), { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, "Projects", "Project Plan.md"),
    "# Project Plan\n",
  );
  fs.writeFileSync(
    path.join(vaultDir, "Archive", "Project Plan.md"),
    "# Archived Project Plan\n",
  );
  fs.writeFileSync(
    path.join(vaultDir, "Projects", "Source.md"),
    `# Source

[Current plan](Project%20Plan.md) and [Archived plan](../Archive/Project%20Plan.md).`,
  );

  return vaultDir;
}

function createConfig(vaultRoot: string, indexDir: string): Config {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    vault: { root: vaultRoot, exclude: [] },
    server: { ...DEFAULT_CONFIG.server },
    index: { dir: indexDir },
    embedding: { ...DEFAULT_CONFIG.embedding },
    cors: { ...DEFAULT_CONFIG.cors },
  };
}

describe("link graph discovery", () => {
  let vaultDir: string;
  let indexDir: string;
  let config: Config;
  let store: IndexStore;

  beforeEach(async () => {
    vaultDir = createLinkVault();
    indexDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-agent-link-idx-"));
    config = createConfig(vaultDir, indexDir);
    await indexVault(config);
    store = await IndexStore.open(getIndexPath(config));
  });

  afterEach(() => {
    try {
      store?.close();
    } catch {}
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(indexDir, { recursive: true, force: true });
  });

  it("returns outlinks and backlinks for a note", () => {
    const planId = noteIdFromPath("Plan.md");
    const result = getNoteLinks({ store, config }, planId);

    expect(result.data.path).toBe("Plan.md");
    expect(result.data.outlinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourcePath: "Plan.md",
          targetPath: "Architecture.md",
          rawTarget: "Architecture",
          display: "Architecture doc",
          kind: "wiki",
          resolved: true,
        }),
        expect.objectContaining({
          sourcePath: "Plan.md",
          targetPath: "Architecture.md",
          rawTarget: "Architecture",
          display: "Architecture again",
          kind: "markdown",
          resolved: true,
        }),
      ]),
    );
    expect(result.data.backlinks).toHaveLength(1);
    expect(result.data.backlinks[0]).toMatchObject({
      sourcePath: "Index.md",
      targetPath: "Plan.md",
      rawTarget: "Plan",
      resolved: true,
    });
  });

  it("lists backlinks only", () => {
    const architectureId = noteIdFromPath("Architecture.md");
    const result = getBacklinks({ store, config }, architectureId);
    expect(result.data.backlinks).toHaveLength(2);
    expect(result.data.backlinks.map((link) => link.kind).sort()).toEqual([
      "markdown",
      "wiki",
    ]);
  });

  it("lists unresolved links without note bodies", () => {
    const result = getBrokenLinks({ store, config });
    expect(result.data.total).toBe(1);
    expect(result.data.links[0]).toMatchObject({
      sourcePath: "Index.md",
      rawTarget: "Missing Note",
      targetPath: null,
      resolved: false,
    });
    expect(JSON.stringify(result)).not.toContain("See [[");
    expect(JSON.stringify(result)).not.toContain("diagram.pdf");
  });

  it("lists orphan notes based on resolved note links", () => {
    const result = getOrphanNotes({ store, config });
    expect(result.data.notes.map((note) => note.path)).toEqual(["Orphan.md"]);
  });

  it("returns compact graph summary", () => {
    const result = getLinkSummary({ store, config }, { limit: 2 });
    expect(result.data.noteCount).toBe(7);
    expect(result.data.resolvedLinkCount).toBe(5);
    expect(result.data.unresolvedLinkCount).toBe(1);
    expect(result.data.orphanNoteCount).toBe(1);
    expect(result.data.topLinkedNotes.length).toBeLessThanOrEqual(2);
  });

  it("resolves encoded and path-qualified Markdown note links", () => {
    const sourceId = noteIdFromPath("Projects/Source.md");
    const currentId = noteIdFromPath("Projects/Project Plan.md");
    const archivedId = noteIdFromPath("Archive/Project Plan.md");
    const result = getNoteLinks({ store, config }, sourceId);

    expect(result.data.outlinks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          targetNoteId: currentId,
          targetPath: "Projects/Project Plan.md",
          rawTarget: "Project Plan",
          kind: "markdown",
          resolved: true,
        }),
        expect.objectContaining({
          targetNoteId: archivedId,
          targetPath: "Archive/Project Plan.md",
          rawTarget: "Project Plan",
          kind: "markdown",
          resolved: true,
        }),
      ]),
    );
  });

  it("rejects unsafe summary path prefixes", () => {
    expect(() =>
      getLinkSummary({ store, config }, { pathPrefix: "../Private" }),
    ).toThrow("Path filters must not contain traversal segments.");
  });
});

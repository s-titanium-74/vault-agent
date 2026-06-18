import { describe, it, expect } from "vitest";
import {
  extractFrontmatter,
  parseMarkdown,
  extractWikilinks,
  extractAttachmentReferences,
} from "../src/markdown.js";

describe("extractFrontmatter", () => {
  it("extracts YAML frontmatter", () => {
    const content = `---
title: "Test Note"
tags:
  - demo
  - test
---

# Test Note

Body content here.`;

    const result = extractFrontmatter(content);
    expect(result.frontmatterDegraded).toBe(false);
    expect(result.frontmatter?.title).toBe("Test Note");
    expect(result.frontmatter?.tags).toEqual(["demo", "test"]);
    expect(result.body.trim()).toBe("# Test Note\n\nBody content here.");
  });

  it("handles content without frontmatter", () => {
    const content = "# Just a note\n\nNo frontmatter here.";
    const result = extractFrontmatter(content);
    expect(result.frontmatter).toBeNull();
    expect(result.frontmatterDegraded).toBe(false);
    expect(result.body).toBe(content);
  });

  it("handles malformed frontmatter gracefully", () => {
    const content = `---
invalid: {yaml: [broken
---

# Note`;
    const result = extractFrontmatter(content);
    expect(result.frontmatterDegraded).toBe(true);
  });

  it("normalizes tags with hash prefix", () => {
    const content = `---
tags:
  - "#demo"
  - test
---

# Note`;
    const result = extractFrontmatter(content);
    expect(result.frontmatter?.tags).toEqual(["demo", "test"]);
  });

  it("handles inline string arrays", () => {
    const content = `---
tags: ["#demo", test]
aliases: ["Home", "Start"]
---

# Note`;
    const result = extractFrontmatter(content);
    expect(result.frontmatter?.tags).toEqual(["demo", "test"]);
    expect(result.frontmatter?.aliases).toEqual(["Home", "Start"]);
  });

  it("normalizes string aliases to array", () => {
    const content = `---
aliases: "Single Alias"
---

# Note`;
    const result = extractFrontmatter(content);
    expect(result.frontmatter?.aliases).toEqual(["Single Alias"]);
  });

  it("handles date fields", () => {
    const content = `---
date: "2025-01-15"
created: "2025-02-01"
updated: "2025-03-10"
---

# Note`;
    const result = extractFrontmatter(content);
    expect(result.frontmatter?.date).toBe("2025-01-15");
    expect(result.frontmatter?.created).toBe("2025-02-01");
    expect(result.frontmatter?.updated).toBe("2025-03-10");
  });
});

describe("parseMarkdown", () => {
  it("extracts title from frontmatter", () => {
    const content = `---
title: "Custom Title"
---

# Different Heading

Body text.`;

    const result = parseMarkdown(content);
    expect(result.title).toBe("Custom Title");
  });

  it("falls back to first h1 heading for title", () => {
    const content = "# Heading Title\n\nBody text.";
    const result = parseMarkdown(content);
    expect(result.title).toBe("Heading Title");
  });

  it("returns headings", () => {
    const content = "# Main\n\n## Section\n\n### Subsection\n\nBody.";
    const result = parseMarkdown(content);
    expect(result.headings.length).toBe(3);
    expect(result.headings[0]!.text).toBe("Main");
    expect(result.headings[1]!.text).toBe("Section");
    expect(result.headings[2]!.text).toBe("Subsection");
  });

  it("strips code blocks from wikilink extraction", () => {
    const content =
      "# Note\n\nText [[InsideCode]] here.\n\n```\n[[NotALink]]\n```\n\nMore [[RealLink]].";
    const result = parseMarkdown(content);
    const targets = result.wikilinks.map((l) => l.target);
    expect(targets).toContain("InsideCode");
    expect(targets).toContain("RealLink");
    expect(targets).not.toContain("NotALink");
  });
});

describe("extractWikilinks", () => {
  it("extracts basic wikilinks", () => {
    const text = "See [[Target]] for more.";
    const links = extractWikilinks(text);
    expect(links.length).toBe(1);
    expect(links[0]!.target).toBe("Target");
  });

  it("extracts wikilinks with heading references", () => {
    const text = "See [[Target#Section]] for more.";
    const links = extractWikilinks(text);
    expect(links[0]!.target).toBe("Target");
    expect(links[0]!.heading).toBe("Section");
  });

  it("extracts wikilinks with display text", () => {
    const text = "See [[Target|Display Text]] for more.";
    const links = extractWikilinks(text);
    expect(links[0]!.target).toBe("Target");
    expect(links[0]!.display).toBe("Display Text");
  });

  it("extracts wikilinks with heading and display", () => {
    const text = "See [[Target#Section|Display]] for more.";
    const links = extractWikilinks(text);
    expect(links[0]!.target).toBe("Target");
    expect(links[0]!.heading).toBe("Section");
    expect(links[0]!.display).toBe("Display");
  });

  it("deduplicates wikilinks", () => {
    const text = "See [[Target]] and [[Target]] again.";
    const links = extractWikilinks(text);
    expect(links.length).toBe(1);
  });
});

describe("extractAttachmentReferences", () => {
  it("extracts markdown image references", () => {
    const text = "![Alt](images/photo.png) and text.";
    const refs = extractAttachmentReferences(text);
    expect(refs).toContain("images/photo.png");
  });

  it("extracts markdown link references to attachments", () => {
    const text = "See [doc](files/doc.pdf) for details.";
    const refs = extractAttachmentReferences(text);
    expect(refs).toContain("files/doc.pdf");
  });

  it("extracts embedded wikilink attachments", () => {
    const text = "Embedded: ![[attachment.pdf]]";
    const refs = extractAttachmentReferences(text);
    expect(refs).toContain("attachment.pdf");
  });

  it("excludes external URLs", () => {
    const text =
      "See [external](https://example.com) and ![img](http://test.com/img.png).";
    const refs = extractAttachmentReferences(text);
    expect(refs).not.toContain("https://example.com");
  });
});

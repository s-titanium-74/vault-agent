import matter from "gray-matter";
import { Frontmatter, WikilinkInfo } from "./types.js";

export interface MarkdownParseResult {
  body: string;
  frontmatter: Frontmatter | null;
  frontmatterDegraded: boolean;
  title: string | null;
  aliases: string[];
  tags: string[];
  wikilinks: WikilinkInfo[];
  attachmentReferences: string[];
  headings: HeadingInfo[];
}

export interface HeadingInfo {
  depth: number;
  text: string;
}

const WIKILINK_PATTERN = /\[\[([^\]]+)]]/g;
const MARKDOWN_IMAGE_PATTERN = /!\[([^\]]*)]\(([^)]+)\)/g;
const MARKDOWN_LINK_PATTERN = /(?<!!)\[([^\]]*)]\(([^)]+)\)/g;
const CODE_BLOCK_OPEN = /^ {0,3}`{3,}/;

export function extractFrontmatter(content: string): {
  frontmatter: Frontmatter | null;
  frontmatterDegraded: boolean;
  body: string;
} {
  try {
    const parsed = matter(content);
    const data = parsed.data;
    const body = parsed.content;

    if (!data || Object.keys(data).length === 0) {
      return { frontmatter: null, frontmatterDegraded: false, body };
    }

    const frontmatter: Frontmatter = {};

    if (typeof data.title === "string") frontmatter.title = data.title;

    if (Array.isArray(data.aliases)) {
      frontmatter.aliases = data.aliases.filter(
        (a: unknown) => typeof a === "string",
      );
    } else if (typeof data.aliases === "string") {
      frontmatter.aliases = [data.aliases];
    }

    if (Array.isArray(data.tags)) {
      frontmatter.tags = data.tags.map((t: unknown) => {
        const s = String(t);
        return s.startsWith("#") ? s.slice(1) : s;
      });
    } else if (typeof data.tags === "string") {
      const s = data.tags.startsWith("#") ? data.tags.slice(1) : data.tags;
      frontmatter.tags = [s];
    }

    if (typeof data.date === "string") frontmatter.date = data.date;
    else if (data.date instanceof Date)
      frontmatter.date = data.date.toISOString().slice(0, 10);

    if (typeof data.created === "string") frontmatter.created = data.created;
    else if (data.created instanceof Date)
      frontmatter.created = data.created.toISOString().slice(0, 10);

    if (typeof data.updated === "string") frontmatter.updated = data.updated;
    else if (data.updated instanceof Date)
      frontmatter.updated = data.updated.toISOString().slice(0, 10);

    return { frontmatter, frontmatterDegraded: false, body };
  } catch {
    const lines = content.split("\n");
    let body = content;
    if (lines[0] === "---") {
      const endIndex = lines.indexOf("---", 1);
      if (endIndex > 0) {
        body = lines.slice(endIndex + 1).join("\n");
      }
    }
    return { frontmatter: null, frontmatterDegraded: true, body };
  }
}

export function parseMarkdown(content: string): MarkdownParseResult {
  const { frontmatter, frontmatterDegraded, body } =
    extractFrontmatter(content);

  const bodyWithoutCode = stripCodeBlocks(body);
  const headings = extractHeadings(bodyWithoutCode);
  const wikilinks = extractWikilinks(bodyWithoutCode);
  const attachmentReferences = extractAttachmentReferences(bodyWithoutCode);

  let title: string | null = null;
  let aliases: string[] = [];
  let tags: string[] = [];

  if (frontmatter) {
    title = frontmatter.title ?? null;
    aliases = frontmatter.aliases ?? [];
    tags = frontmatter.tags ?? [];
  }

  if (title === null && headings.length > 0) {
    const h1 = headings.find((h) => h.depth === 1);
    if (h1) title = h1.text;
  }

  return {
    body,
    frontmatter,
    frontmatterDegraded,
    title,
    aliases,
    tags,
    wikilinks,
    attachmentReferences,
    headings,
  };
}

function stripCodeBlocks(text: string): string {
  const lines = text.split("\n");
  const result: string[] = [];
  let inCodeBlock = false;

  for (const line of lines) {
    if (CODE_BLOCK_OPEN.test(line)) {
      if (inCodeBlock) {
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
      }
      continue;
    }

    if (!inCodeBlock) {
      result.push(line);
    }
  }

  return result.join("\n");
}

function extractHeadings(text: string): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  const pattern = /^(#{1,6})\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const depth = match[1]!.length;
    const text2 = match[2]!.trim();
    headings.push({ depth, text: text2 });
  }

  return headings;
}

export function extractWikilinks(text: string): WikilinkInfo[] {
  const links: WikilinkInfo[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;

  WIKILINK_PATTERN.lastIndex = 0;
  while ((match = WIKILINK_PATTERN.exec(text)) !== null) {
    const raw = match[1]!;

    let target: string;
    let heading: string | null = null;
    let display: string | null = null;

    if (raw.includes("|")) {
      const pipeIndex = raw.indexOf("|");
      display = raw.slice(pipeIndex + 1).trim();
      const beforePipe = raw.slice(0, pipeIndex).trim();
      if (beforePipe.includes("#")) {
        const hashIndex = beforePipe.indexOf("#");
        target = beforePipe.slice(0, hashIndex).trim();
        heading = beforePipe.slice(hashIndex + 1).trim();
      } else {
        target = beforePipe;
      }
    } else if (raw.includes("#")) {
      const hashIndex = raw.indexOf("#");
      target = raw.slice(0, hashIndex).trim();
      heading = raw.slice(hashIndex + 1).trim();
    } else {
      target = raw.trim();
    }

    const key = `${target}#${heading ?? ""}|${display ?? ""}`;
    if (!seen.has(key)) {
      seen.add(key);
      links.push({
        target,
        heading,
        display,
        resolved: null,
      });
    }
  }

  return links;
}

export function extractAttachmentReferences(text: string): string[] {
  const refs = new Set<string>();

  let match: RegExpExecArray | null;

  MARKDOWN_IMAGE_PATTERN.lastIndex = 0;
  while ((match = MARKDOWN_IMAGE_PATTERN.exec(text)) !== null) {
    const href = match[2]!;
    if (href && isAttachmentPath(href)) {
      refs.add(href);
    }
  }

  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  while ((match = MARKDOWN_LINK_PATTERN.exec(text)) !== null) {
    const href = match[2]!;
    if (href && isAttachmentPath(href)) {
      refs.add(href);
    }
  }

  const wikilinkRefs = extractEmbeddedWikilinks(text);
  for (const ref of wikilinkRefs) {
    refs.add(ref);
  }

  return Array.from(refs);
}

function extractEmbeddedWikilinks(text: string): string[] {
  const refs: string[] = [];
  const pattern = /!\[\[([^\]]+)]]/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    const raw = match[1]!;
    let target = raw;
    if (target.includes("|")) {
      target = target.slice(0, target.indexOf("|")).trim();
    }
    if (target.includes("#")) {
      target = target.slice(0, target.indexOf("#")).trim();
    }
    if (isAttachmentPath(target)) {
      refs.push(target);
    }
  }

  return refs;
}

function isAttachmentPath(href: string): string | null {
  if (!href) return null;
  if (href.startsWith("http://") || href.startsWith("https://")) return null;
  if (href.startsWith("#")) return null;
  if (href.startsWith("mailto:")) return null;
  return href;
}

export function resolveWikilinks(
  notes: Map<string, { title: string | null; aliases: string[] }>,
): (link: WikilinkInfo) => WikilinkInfo {
  const fileNameMap = new Map<string, string[]>();
  const titleMap = new Map<string, string[]>();
  const aliasMap = new Map<string, string[]>();

  for (const [stem, info] of notes) {
    const arr = fileNameMap.get(stem) ?? [];
    arr.push(stem);
    fileNameMap.set(stem, arr);

    if (info.title) {
      const arr2 = titleMap.get(info.title) ?? [];
      arr2.push(stem);
      titleMap.set(info.title, arr2);
    }

    for (const alias of info.aliases) {
      const arr3 = aliasMap.get(alias) ?? [];
      arr3.push(stem);
      aliasMap.set(alias, arr3);
    }
  }

  return (link: WikilinkInfo): WikilinkInfo => {
    const target = link.target;

    const byFileName = fileNameMap.get(target);
    if (byFileName && byFileName.length === 1) {
      return { ...link, resolved: byFileName[0]! };
    }

    const byTitle = titleMap.get(target);
    if (byTitle && byTitle.length === 1) {
      return { ...link, resolved: byTitle[0]! };
    }

    const byAlias = aliasMap.get(target);
    if (byAlias && byAlias.length === 1) {
      return { ...link, resolved: byAlias[0]! };
    }

    return { ...link, resolved: null };
  };
}

export function generateLexicalIndexText(params: {
  title: string | null;
  aliases: string[];
  tags: string[];
  headingPath: string[];
  content: string;
}): string {
  const parts: string[] = [];

  if (params.title) parts.push(params.title);
  for (const alias of params.aliases) parts.push(alias);
  for (const tag of params.tags) parts.push(tag);
  for (const heading of params.headingPath) parts.push(heading);
  parts.push(params.content);

  return parts.join(" ");
}

export function generateEmbeddingInputText(params: {
  title: string | null;
  headingPath: string[];
  content: string;
  maxLength?: number;
}): string {
  const parts: string[] = [];

  if (params.title) parts.push(params.title);
  for (const heading of params.headingPath) parts.push(heading);
  parts.push(params.content);

  const text = parts.join(" ");
  const maxLength = params.maxLength ?? 8000;

  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength);
}

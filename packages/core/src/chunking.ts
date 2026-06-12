import { Chunk } from "./types.js";
import {
  TARGET_CHUNK_SIZE,
  MAX_CHUNK_SIZE,
  MAX_MARKDOWN_SIZE_FOR_INDEXING,
} from "./schemas.js";
import crypto from "node:crypto";

export interface ChunkingResult {
  chunks: Chunk[];
  oversized: boolean;
  empty: boolean;
}

export function chunkNote(params: {
  noteId: string;
  vaultRelativePath: string;
  title: string | null;
  headingPath: string[];
  body: string;
  fileSize: number;
  targetChunkSize?: number;
  maxChunkSize?: number;
}): ChunkingResult {
  const {
    noteId,
    vaultRelativePath,
    title,
    body,
    fileSize,
    targetChunkSize = TARGET_CHUNK_SIZE,
    maxChunkSize = MAX_CHUNK_SIZE,
  } = params;

  if (fileSize > MAX_MARKDOWN_SIZE_FOR_INDEXING) {
    return {
      chunks: [],
      oversized: true,
      empty: false,
    };
  }

  const trimmedBody = body.trim();
  if (trimmedBody.length === 0) {
    return {
      chunks: [],
      oversized: false,
      empty: true,
    };
  }

  const sections = splitByHeadings(trimmedBody);
  const chunks = mergeAndSplitSections(
    sections,
    noteId,
    vaultRelativePath,
    title,
    targetChunkSize,
    maxChunkSize,
  );

  return {
    chunks,
    oversized: false,
    empty: false,
  };
}

interface Section {
  heading: string | null;
  headingPath: string[];
  content: string;
  charStart: number;
}

function splitByHeadings(body: string): Section[] {
  const lines = body.split("\n");
  const sections: Section[] = [];
  let currentHeading: string | null = null;
  let currentPath: string[] = [];
  let currentLines: string[] = [];
  let charStart = 0;
  let currentCharPos = 0;

  const headingStack: { depth: number; text: string }[] = [];

  const flushSection = () => {
    const content = currentLines.join("\n").trim();
    if (content.length > 0 || currentHeading !== null) {
      sections.push({
        heading: currentHeading,
        headingPath: [...currentPath],
        content,
        charStart,
      });
    }
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)$/);

    if (headingMatch) {
      flushSection();
      const depth = headingMatch[1]!.length;
      const text = headingMatch[2]!.trim();

      while (
        headingStack.length > 0 &&
        headingStack[headingStack.length - 1]!.depth >= depth
      ) {
        headingStack.pop();
      }
      headingStack.push({ depth, text });

      currentPath = headingStack.map((h) => h.text);
      currentHeading = text;
      currentLines = [];
      charStart = currentCharPos;
    } else {
      currentLines.push(line);
    }
    currentCharPos += line.length + 1;
  }

  flushSection();

  if (sections.length === 0) {
    const content = body.trim();
    if (content.length > 0) {
      sections.push({
        heading: null,
        headingPath: [],
        content,
        charStart: 0,
      });
    }
  }

  return sections;
}

function mergeAndSplitSections(
  sections: Section[],
  noteId: string,
  vaultRelativePath: string,
  title: string | null,
  targetChunkSize: number,
  maxChunkSize: number,
): Chunk[] {
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const effectiveHeadingPath =
      section.heading !== null ? section.headingPath : [];

    if (section.content.length <= maxChunkSize) {
      const contentHash = hashContent(section.content);
      chunks.push({
        noteId,
        chunkIndex,
        vaultRelativePath,
        title,
        heading: section.heading,
        headingPath: effectiveHeadingPath,
        content: section.content,
        contentHash,
        charStart: section.charStart,
        charEnd: section.charStart + section.content.length,
      });
      chunkIndex++;
    } else {
      const subChunks = splitOversizedSection(
        section.content,
        targetChunkSize,
        maxChunkSize,
      );

      for (const subContent of subChunks) {
        const contentHash = hashContent(subContent);
        chunks.push({
          noteId,
          chunkIndex,
          vaultRelativePath,
          title,
          heading: section.heading,
          headingPath: effectiveHeadingPath,
          content: subContent,
          contentHash,
          charStart: section.charStart,
          charEnd: section.charStart + section.content.length,
        });
        chunkIndex++;
      }
    }
  }

  return chunks;
}

function splitOversizedSection(
  content: string,
  targetChunkSize: number,
  maxChunkSize: number,
): string[] {
  const paragraphs = splitByParagraphs(content);

  const chunks: string[] = [];
  let currentChunk = "";

  for (const paragraph of paragraphs) {
    if (currentChunk.length + paragraph.length + 1 <= maxChunkSize) {
      if (currentChunk.length > 0) {
        currentChunk += "\n\n" + paragraph;
      } else {
        currentChunk = paragraph;
      }
    } else {
      if (currentChunk.length > 0) {
        chunks.push(currentChunk);
        currentChunk = "";
      }

      if (paragraph.length <= maxChunkSize) {
        currentChunk = paragraph;
      } else {
        const hardSplits = hardSplitBySize(paragraph, maxChunkSize);
        for (let i = 0; i < hardSplits.length; i++) {
          if (i < hardSplits.length - 1) {
            chunks.push(hardSplits[i]!);
          } else {
            currentChunk = hardSplits[i]!;
          }
        }
      }
    }
  }

  if (currentChunk.length > 0) {
    chunks.push(currentChunk);
  }

  if (chunks.length === 0 && content.length > 0) {
    chunks.push(content.slice(0, maxChunkSize));
  }

  return chunks;
}

function splitByParagraphs(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/);
  return paragraphs.map((p) => p.trim()).filter((p) => p.length > 0);
}

function hardSplitBySize(text: string, maxSize: number): string[] {
  const result: string[] = [];
  let remaining = text;

  while (remaining.length > maxSize) {
    let splitPoint = remaining.lastIndexOf("\n", maxSize);
    if (splitPoint === -1 || splitPoint === 0) {
      splitPoint = maxSize;
    }
    result.push(remaining.slice(0, splitPoint).trim());
    remaining = remaining.slice(splitPoint).trim();
  }

  if (remaining.length > 0) {
    result.push(remaining);
  }

  return result;
}

function hashContent(content: string): string {
  return crypto
    .createHash("sha-256")
    .update(content)
    .digest("hex")
    .slice(0, 32);
}

# Chunking Strategy

Notes are split into chunks based on Markdown headings. Each heading section becomes a chunk when it fits within size limits.

## Size Limits

Target chunk size is 2,000 characters. Maximum chunk size is 4,000 characters. Oversized sections are split at paragraph boundaries when possible.

## Heading Hierarchy

Chunk metadata preserves the full heading path from the document root. This allows search results to show where a chunk appears within the document structure.

## Empty and Oversized Notes

Empty notes are indexed but produce no searchable chunks. Oversized notes are registered as note records even when their bodies are too large to chunk.
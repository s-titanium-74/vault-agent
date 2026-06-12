---
title: "Chunking Design"
tags:
  - design
  - chunking
---

# Chunking Design

Notes are split into chunks based on heading sections. Each section becomes a chunk when it fits within size limits.

Target chunk size is 2000 characters. Maximum chunk size is 4000 characters. Oversized sections are split at paragraph boundaries first, then by character count.

Chunk metadata preserves the heading hierarchy. This helps search results show where a chunk appears in the document structure.
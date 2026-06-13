---
title: "Search Architecture"
aliases:
  - "Search System"
tags:
  - architecture
  - search
created: "2025-02-01"
updated: "2025-03-10"
---

# Search Architecture

The search system uses a layered approach combining lexical and semantic signals.

## Lexical Search

Lexical search uses SQLite FTS5 with the unicode61 tokenizer. A supplemental trigram index improves matching for CJK and other non-whitespace languages.

User search input is safely tokenized before querying FTS5, preventing raw FTS syntax injection.

## Embedding Search

Embedding search uses sqlite-vec for vector similarity. Embeddings are generated from note titles, heading paths, and chunk content.

Embedding is disabled by default. When enabled, users must configure a local OpenAI-compatible embedding endpoint such as Ollama.

## Hybrid Search

Hybrid search combines lexical and embedding results using Reciprocal Rank Fusion. The default RRF constant is 60.

This approach provides better coverage than either signal alone while keeping the result set compact and relevant.

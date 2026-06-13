---
title: "Search Architecture"
aliases:
  - "Search System"
  - "Retrieval Engine"
tags:
  - architecture
  - search
  - retrieval
date: "2025-01-15"
---

# Search Architecture

The search system uses a layered approach to provide both lexical and semantic retrieval.

## Lexical Search

Lexical search uses SQLite FTS5 with the `unicode61` tokenizer. A supplemental trigram index supports non-whitespace languages.

The FTS5 query builder safely handles user input without exposing raw query syntax.

## Embedding Search

Embedding search uses `sqlite-vec` for vector similarity. Embeddings are generated from note titles, heading paths, and chunk content.

## Hybrid Search

Hybrid search combines lexical and embedding results using Reciprocal Rank Fusion (RRF). The default RRF constant is 60.

The fused results provide better coverage than either signal alone, while keeping the result set compact and relevant.

---
title: "Configuration Guide"
tags:
  - configuration
  - guide
created: "2025-02-01"
updated: "2025-03-10"
---

# Configuration Guide

Vault-agent uses TOML configuration files stored in a user-local directory.

## Vault Root

The vault root is the directory containing your Markdown notes. Only `.md` and `.markdown` files are indexed by default.

## Server Settings

The default server endpoint is `http://127.0.0.1:8787`. The server binds to localhost only by default.

## Embedding Settings

Embeddings are disabled by default. To enable semantic search, configure a local OpenAI-compatible embedding endpoint such as Ollama.

## Security

API key authentication is optional on localhost. Non-localhost access requires an API key with a minimum length of 32 characters.

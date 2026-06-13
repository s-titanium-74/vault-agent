# Configuration Guide

Vault-agent uses TOML configuration files stored in user-local directories.

## Vault Root

The vault root is the directory containing your Markdown notes. Files with `.md` and `.markdown` extensions are indexed.

Default exclusions include `.obsidian/`, `.git/`, `node_modules/`, and hidden files.

## Server Settings

Default server endpoint is `http://127.0.0.1:8787`. The server binds to localhost by default. Non-localhost access requires API key authentication.

## Embedding Settings

Embeddings are disabled by default. Enable by setting `embedding.enabled = true` and configuring a local endpoint.

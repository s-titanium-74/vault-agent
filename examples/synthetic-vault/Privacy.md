# Privacy and Security

Vault-agent is designed with local-first and private-by-default principles.

## Localhost Default

The server binds to `127.0.0.1` by default. Remote access requires explicit configuration and API key authentication.

## Data Minimization

Search results return only metadata and short snippets, never full note bodies. Note and chunk retrieval require explicit requests.

Error messages and logs do not include raw queries, secrets, full note content, or private absolute paths.

## Index Privacy

Index files are derived from private vault content and are stored in user-local directories. Indexes must not be committed to public repositories.
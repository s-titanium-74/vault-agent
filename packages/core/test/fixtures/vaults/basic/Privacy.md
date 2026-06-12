# Privacy and Security

Vault-agent is designed with local-first and private-by-default principles.

## Localhost Default

The server binds to `127.0.0.1` by default. Remote access requires explicit configuration and API key authentication.

## Data Minimization

Search results return only metadata and short snippets. Full note retrieval requires explicit requests. Error messages and logs avoid including raw queries or private paths.

## Index Privacy

Index files are derived from vault content and stored in user-local directories. Indexes should not be committed to public repositories.
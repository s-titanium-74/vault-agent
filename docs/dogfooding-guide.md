# Dogfooding Guide: Remote MCP With Docker, pCloud Notes And CloudFront

Goal: run `vault-agent` from a pulled Docker image, keep notes in pCloud, and
reach it from Perplexity (or another remote MCP client) over HTTPS through
Amazon CloudFront.

```
Perplexity ──HTTPS──> CloudFront ──HTTPS──> Cloudflare Tunnel ──> vault-agent (Docker)
                                                                     └─ /data/vault = pCloud mount
```

What the server already provides: Streamable HTTP MCP at `/mcp`,
`Authorization: Bearer` keys with separate read and admin roles, and opt-in
note writes (`preview_changes` / `apply_changes`). Writes require the admin key;
the read key cannot see or call the write tools. The server refuses non-localhost
binds without keys and never allows anonymous writes.

## 1. Pull the image

```bash
docker pull ghcr.io/s-titanium-74/vault-agent:latest   # published on v* tags
# or: docker pull namka0703/vault-agent:0.2.0
```

Tags `vX.Y.Z` trigger `.github/workflows/docker-publish.yml`, which pushes
multi-arch (amd64/arm64) images to GHCR. Make the package public (or
`docker login ghcr.io`) before pulling.

## 2. Make pCloud notes available (decision: rclone mount, default)

`vault-agent` needs a real filesystem directory. Options:

| Option                                                               | Writes         | Trade-offs                                                                |
| -------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------- |
| **rclone mount** (pcloud backend, `--vfs-cache-mode full`) — default | Yes            | Works on Linux headless hosts; cached writes are uploaded asynchronously. |
| pCloud Drive (official client)                                       | Yes            | Needs a desktop session/FUSE; fine on a desktop PC.                       |
| Local folder synced by pCloud client or `rclone bisync`              | Yes            | Fast local I/O; conflicts possible if edited elsewhere while syncing.     |
| Built-in pCloud source (Cloudflare deployment)                       | No (read-only) | See the pCloud source contract; not used for this setup.                  |

rclone example (create the remote once with `rclone config`, type `pcloud`;
EU accounts must choose the EU hostname):

```bash
mkdir -p ~/vault-notes
rclone mount pcloud:Notes ~/vault-notes \
  --vfs-cache-mode full --vfs-cache-max-age 1h \
  --dir-cache-time 30s --poll-interval 30s --daemon
```

Trade-offs and cautions:

- Latency: first reads and indexing go over the network; the local index in the
  `vault-agent-index` volume (not on pCloud) keeps search fast.
- Conflicts: if you edit the same note in Obsidian on another device, the
  write is detected as a version conflict and rejected, but pCloud/rclone
  propagation delay can still hide an in-flight external edit. Prefer short
  edit windows and `VAULT_AGENT_WRITE_MODE=review`.
- Remote changes appear after rclone's poll interval; inotify events are not
  generated for remote changes, so run `vault-agent reindex` (or restart) if
  search looks stale.
- The index directory must stay outside the vault (compose does this).

## 3. Run vault-agent

```bash
cp .env.example .env
# edit .env: VAULT_AGENT_HOST_VAULT_DIR=/home/you/vault-notes
#            VAULT_AGENT_READ_KEY / VAULT_AGENT_ADMIN_KEY  (openssl rand -hex 32)
docker compose up -d
curl -s -H "Authorization: Bearer $VAULT_AGENT_READ_KEY" http://127.0.0.1:8787/status
```

The port is published on `127.0.0.1` only; the public path goes through the
tunnel. Remote clients that must read _and_ update notes need the **admin**
key (write tools are hidden from the read key). Keep `.env` out of git.

## 4. Public HTTPS origin (decision: Cloudflare Tunnel, default)

CloudFront must reach the origin from AWS, so a home host needs a public
HTTPS hostname. Pragmatic default is a Cloudflare Tunnel (no inbound ports):

1. In Cloudflare Zero Trust, create a tunnel and a public hostname such as
   `origin.example.com` → service `http://vault-agent:8787`.
2. Put the tunnel token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
3. `docker compose --profile tunnel up -d`.

Alternatives: run the stack on an EC2/Lightsail instance with a public IP and a
reverse proxy (Caddy) terminating TLS; or ALB → EC2. If the origin is public,
restrict it so only CloudFront can use it (Cloudflare WAF rule on a secret
custom origin header, or the CloudFront managed prefix list in the security
group). The bearer key is still the real access control.

## 5. CloudFront

Deploy the template (or configure the same by hand):

```bash
aws cloudformation deploy --stack-name vault-agent-mcp \
  --template-file deploy/cloudfront/template.yaml \
  --parameter-overrides OriginDomainName=origin.example.com
aws cloudformation describe-stacks --stack-name vault-agent-mcp \
  --query 'Stacks[0].Outputs'
```

Settings that matter for MCP (all set by the template):

- **No caching**: managed `CachingDisabled` policy; all methods allowed
  (`GET`, `POST`, `DELETE` are used by Streamable HTTP).
- **Authorization forwarding**: managed `AllViewerExceptHostHeader` origin
  request policy forwards `Authorization` and `Mcp-Session-Id`. Do not forward
  `Host` (it must match the origin hostname).
- **HTTPS**: viewer `redirect-to-https`; origin `https-only`. The default
  `*.cloudfront.net` certificate works for Perplexity; for a custom domain, use
  an ACM certificate in `us-east-1`.
- **Streaming/timeouts**: origin read timeout defaults to 60 s (the standard
  maximum; higher needs a quota request). Responses are stream-compatible
  (compression disabled), but keep tool calls under the timeout. The server
  keeps MCP sessions in memory, so run a single container instance.

Test: `curl -i https://dXXXX.cloudfront.net/mcp` should return `401` without a
key.

## 6. Connect Perplexity

In Perplexity, open Settings → Connectors → add a custom/remote MCP connector:

- URL: `https://dXXXX.cloudfront.net/mcp`
- Transport: Streamable HTTP
- Authentication: API key / bearer token — use the admin key to read and
  update notes (read key for read-only). Perplexity availability and the exact
  UI differ by plan and platform; if it offers only OAuth or no-auth, this
  server cannot be used from it yet (OAuth is not implemented).

Other clients with header support use
`Authorization: Bearer <key>` as in the
[MCP client guide](phases/phase-3-mcp-bridge/specifications/mcp-client-guide.md).

## Operations notes

- Rotate keys with `VAULT_AGENT_PREVIOUS_READ_KEY` / `VAULT_AGENT_PREVIOUS_ADMIN_KEY`.
- Cloud-hosted LLM clients receive whatever tools return; narrow with `search`
  and fetch only needed notes with `get`.
- Store the admin key only in the client's secret field; it grants file changes.

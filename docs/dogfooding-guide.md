# Dogfooding Guide: Remote MCP With Docker, pCloud Notes And CloudFront

Goal: run `vault-agent` from a pulled Docker image, keep notes in pCloud, and
reach it from Perplexity (or another remote MCP client) over HTTPS through
Amazon CloudFront.

```
Perplexity ──HTTPS──> CloudFront ──HTTPS──> Cloudflare Tunnel ──> vault-agent (Docker Desktop, Windows PC)
                                                                     └─ /data/vault = pCloud Drive (P:/Notes)
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

## 2. Make pCloud notes available (Windows PC, Docker Desktop)

`vault-agent` needs a real directory inside the container. On a Windows PC the
pragmatic default is the **pCloud Drive** letter (for example `P:\Notes`)
bind-mounted into the container. Options, in order of preference:

| Option                                                            | Writes         | Trade-offs                                                                                                     |
| ----------------------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------- |
| **pCloud Drive** bind mount (`P:\Notes`) — default                | Yes            | Simple, but the drive is a virtual filesystem; Docker Desktop may not be able to share it (see below).         |
| **pCloud Sync** (a real local folder synced with a pCloud folder) | Yes            | Always bind-mountable and fast; conflicts possible if edited elsewhere while syncing. Fallback if Drive fails. |
| rclone mount on WSL2/Linux                                        | Yes            | More setup; works on headless Linux hosts.                                                                     |
| Built-in pCloud source (Cloudflare deployment)                    | No (read-only) | Not used here.                                                                                                 |

Windows caveats (not verified on a real Windows host from this repo's CI):

- Docker Desktop (WSL2 backend) shares local drives lazily; virtual drives such
  as pCloud Drive are often **not** shareable, and a bind mount may appear empty
  or fail. Test with the command below; if the folder is empty, use pCloud Sync
  instead.
- pCloud Drive must be running and the drive letter mounted before the container
  starts; start the container after login (or `restart: unless-stopped` will
  retry once Docker Desktop is up).
- Use forward slashes or quote the path in `.env`: `P:/Notes`.
- File-change events (inotify) do not cross Windows bind mounts, so the server
  watcher can miss edits made on the PC. Run `docker compose restart vault-agent`
  (or `docker compose run --rm vault-agent reindex` with the stack stopped) if
  search looks stale.
- Windows file permissions are mapped by Docker; the container user `node`
  needs write access. If writes fail, check the drive is not read-only.
- Antivirus/Drive caching add latency; the index lives in a Docker volume (not on
  pCloud), which keeps search fast.
- Conflicts: if the same note is edited in Obsidian on another device, the
  server rejects a detected version conflict, but pCloud propagation delay can
  hide an in-flight edit. Prefer `VAULT_AGENT_WRITE_MODE=review`.
- The index directory must stay outside the vault (compose does this).

Quick check that the container can see the notes (PowerShell):

```powershell
docker run --rm -v "P:/Notes:/data/vault" alpine sh -c "ls /data/vault | head"
```

## 3. Run vault-agent (PowerShell)

Install Docker Desktop first, then:

```powershell
git clone https://github.com/s-titanium-74/vault-agent.git
cd vault-agent
Copy-Item .env.example .env
# Generate two distinct keys and paste them into .env
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
notepad .env   # set VAULT_AGENT_HOST_VAULT_DIR=P:/Notes, READ_KEY, ADMIN_KEY
docker compose up -d
$k = "<your read key>"
curl.exe -s -H "Authorization: Bearer $k" http://127.0.0.1:8787/status
```

(`Get-Random` is fine for personal keys; `openssl rand -hex 32` is better if
available.) The port is published on `127.0.0.1` only; the public path goes
through the tunnel. Clients that must read _and_ update notes need the
**admin** key (write tools are hidden from the read key). Keep `.env` out of
git. Make sure Docker Desktop starts at login and the PC does not sleep.

## 4. Public HTTPS origin (decision: Cloudflare Tunnel, default)

CloudFront must reach the origin from AWS, so a home PC needs a public HTTPS
hostname. Pragmatic default is a Cloudflare Tunnel (outbound-only, no router
ports; requires a domain on Cloudflare, free plan is fine):

1. In Cloudflare Zero Trust, create a tunnel and a public hostname such as
   `origin.example.com` → service `http://vault-agent:8787`.
2. Put the tunnel token in `.env` as `CLOUDFLARE_TUNNEL_TOKEN`.
3. `docker compose --profile tunnel up -d`.

Alternatives: another outbound tunnel (Tailscale Funnel, ngrok with a reserved
domain); router port-forward + DDNS + Caddy (opens inbound ports, not
recommended); run the stack on an EC2/Lightsail instance with a public IP and a
reverse proxy (Caddy) terminating TLS; or ALB → EC2. If the origin is public,
restrict it so only CloudFront can use it (Cloudflare WAF rule on a secret
custom origin header, or the CloudFront managed prefix list in the security
group). The bearer key is still the real access control.

## 5. CloudFront

Deploy the template (or configure the same by hand):

```powershell
aws cloudformation deploy --stack-name vault-agent-mcp `
  --template-file deploy/cloudfront/template.yaml `
  --parameter-overrides OriginDomainName=origin.example.com
aws cloudformation describe-stacks --stack-name vault-agent-mcp `
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

Test: `curl.exe -i https://dXXXX.cloudfront.net/mcp` should return `401` without a
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

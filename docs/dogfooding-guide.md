# Dogfooding Guide: Remote MCP With Docker, pCloud Notes And CloudFront

Goal: run `vault-agent` from a pulled Docker image, keep notes in pCloud, and
reach it from Perplexity (or another remote MCP client) over HTTPS through
Amazon CloudFront.

```
Perplexity ──HTTPS──> CloudFront ──HTTPS──> Cloudflare Tunnel ──> vault-agent (Docker Desktop, Windows PC)
                                                                     └─ /data/vault = pCloud Sync folder (read-only)
```

Current scope (decided): **read-only** dogfooding. Search and note retrieval
only; the notes mount is `:ro` and write tools are disabled. Writing back to
pCloud via its API is out of scope (tracked separately). Switching on local
writes later is a documented setting change (section 6).

What the server provides: Streamable HTTP MCP at `/mcp` and
`Authorization: Bearer` keys. The server refuses non-localhost binds without
keys and never allows anonymous writes.

## 1. Pull the image

```powershell
docker pull namka0703/vault-agent:0.2.0
```

(Docker Hub; use the tag you want.) `docker compose up` pulls it automatically.

## 2. Notes access: pCloud Sync folder

Use **pCloud Sync** to sync your notes pCloud folder to a normal local folder
(for example `C:\Users\you\pCloud Sync\Notes`), and bind-mount that folder
read-only. A real local folder is shareable with Docker Desktop, unlike the
pCloud Drive virtual drive, which often cannot be bind-mounted.

Caveats (not verified on a real Windows host from this repo's CI):

- Docker Desktop (WSL2) must be allowed to access the folder (Settings →
  Resources → File sharing, if not under your user profile).
- Keep pCloud Sync running so the folder stays current; changes made by sync
  are not seen as file events across the Windows mount, so after large changes
  run `docker compose restart vault-agent` to re-scan.
- Pending sync conflict copies (`... (conflicted)`) are ordinary files and will
  be indexed; clean them up if unwanted.
- Use forward slashes or quote the path in `.env`. Paths with spaces are fine
  in `.env`.
- The index is stored in a Docker volume, not in the notes folder.

Check the container can see the notes (PowerShell):

```powershell
docker run --rm -v "C:/Users/you/pCloud Sync/Notes:/data/vault:ro" alpine sh -c "ls /data/vault | head"
```

## 3. Run vault-agent (PowerShell)

```powershell
git clone https://github.com/s-titanium-74/vault-agent.git
cd vault-agent
Copy-Item .env.example .env
# Generate two different keys (run twice) for VAULT_AGENT_READ_KEY and
# VAULT_AGENT_ADMIN_KEY in .env. The server requires both; only the read key
# goes to Perplexity.
-join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
notepad .env   # set VAULT_AGENT_HOST_VAULT_DIR and both keys
docker compose up -d
$k = "<your read key>"
curl.exe -s -H "Authorization: Bearer $k" http://127.0.0.1:8787/status
```

The port is published on `127.0.0.1` only; the public path goes through the
tunnel. Keep `.env` out of git. Make sure Docker Desktop starts at login and the
PC does not sleep.

## 4. Public HTTPS origin (decision: Cloudflare Tunnel, default)

CloudFront must reach the origin from AWS, so a home PC needs a public HTTPS
hostname. The chosen approach is a Cloudflare Tunnel (outbound-only, no router
ports) using your Cloudflare-managed domain:

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
- Authentication: API key / bearer token — use the read key. Perplexity availability and the exact
  UI differ by plan and platform; if it offers only OAuth or no-auth, this
  server cannot be used from it yet (OAuth is not implemented).

Other clients with header support use
`Authorization: Bearer <key>` as in the
[MCP client guide](phases/phase-3-mcp-bridge/specifications/mcp-client-guide.md).

## Operations notes

- Rotate keys with `VAULT_AGENT_PREVIOUS_READ_KEY`.
- Cloud-hosted LLM clients receive whatever tools return; narrow with `search`
  and fetch only needed notes with `get`.

## 6. Enabling writes later (optional)

Local file changes (not pCloud API writes) can be enabled by editing `.env`:

```
VAULT_AGENT_VAULT_MOUNT_MODE=rw
VAULT_AGENT_WRITE_ENABLED=true
VAULT_AGENT_WRITE_MODE=review
```

then `docker compose up -d`. The write tools are visible only to clients using
the existing admin key; keep the Perplexity connector on the read key unless it needs to
update notes. pCloud Sync then uploads changes; concurrent edits on another
device can create conflict copies, so keep `review` mode.

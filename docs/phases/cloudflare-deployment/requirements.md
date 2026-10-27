# Cloudflare Deployment Requirements

Status: Ready for Review

Tracking: [#29](https://github.com/s-titanium-74/vault-agent/issues/29).
Specification scope: [#30](https://github.com/s-titanium-74/vault-agent/issues/30).
This phase is a separate deployment track alongside the local feature phases.
No cloud implementation or deployment is included in #30.

## Product And Privacy Boundary

- Preserve local-first defaults, localhost binding, local-only lexical search,
  and ordinary installation without cloud dependencies or accounts.
- Offer a separately installed edition in the user's Cloudflare account with
  one vault per deployment. No multi-tenant service, billing product, note
  editing, answer generation, or automatic context expansion.
- Require explicit external-storage setup and scoped manual upload. Include
  allowed Markdown and attachments together in the selected scope. Require
  separate opt-in for Workers AI processing of chunk inputs and search queries.
- Authenticate every data, metadata, status, indexing, ingestion, and MCP
  surface. Keep source buckets private and diagnostics sanitized.

Details: [security and configuration](specifications/security-configuration.md).

## Portable Architecture

Define asynchronous read-only source, metadata/lexical, vector, and embedding
contracts. Keep parsing, chunking, filter semantics, ranking, IDs, and compact
schemas in core. Keep Node filesystem, SQLite/native extensions, configuration
loaders, watchers, Git, and Cloudflare bindings behind runtime adapters.

Use portable vault identity independent of absolute filesystem roots. Preserve
existing path-based note IDs and note/index-based chunk IDs; state their edit
and rename limits explicitly. Keep source and index storage independent.

Details: [architecture and contracts](specifications/architecture-contracts.md).
Extraction details: [portable core](specifications/portable-core.md).

## API And Client Scope

Inventory and specify all existing HTTP, CLI, and MCP retrieval surfaces,
including attachments, structured filters, orientation, links, guidance,
profiles, status, indexing, watch, and sync. Initial cloud delivery includes
Workers `/mcp` as well as HTTP retrieval; do not assume local stdio uses HTTP.
Unsupported operations fail explicitly; no silent capability gaps.

Details: [API and clients](specifications/api-clients.md).

## Ingestion And Consistency

Use a dedicated `vault-agent upload` workflow without changing `sync`.
Dry run sends no vault data. Bound jobs across requests, persist checkpoints,
and support idempotent retry. Define publication, stale reads, replacement,
deletion, recovery, model migrations, and exclusions across independent stores.

Details: [ingestion and consistency](specifications/ingestion-consistency.md).

## Validation And Delivery Gates

R2 + D1 + Workers AI + Vectorize is the selected initial composition subject
to the bounded compatibility tasks recorded in the validation specification.
Official documentation establishes feasibility, not application compatibility.
No production content may be onboarded before authentication, exclusions,
revision isolation, and synthetic end-to-end tests pass.

Details: [validation and rollout](specifications/validation-rollout.md).

Acceptance for #30:

- Data flows, API/capability scope, trust boundaries, and rollout gates are
  specified and linked from the product plan.
- Local defaults and no-external-provider operation remain explicit.
- Storage decisions and unresolved compatibility tasks have owners, pass
  criteria, and a defined failure action.
- Later issues have externally visible behavior to implement; failed
  validation requires a specification revision before changing that behavior.
- User scope decisions include initial Workers MCP and scoped Markdown plus
  attachments, with semantic processing separately enabled.

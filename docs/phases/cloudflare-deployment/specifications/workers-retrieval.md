# Workers Retrieval Milestone (#32)

The separately installed `packages/cloudflare` package implements the read
capabilities in api-clients.md. It bundles the portable core source only; local
installation does not install Workers tooling. No AI binding or provider calls
are used in this milestone. Upload and index jobs remain unsupported (#34).

## Storage and admission

D1 stores immutable snapshot-scoped source manifests, note and chunk rows. Each
snapshot has its own FTS5 corpus so staged revisions cannot change BM25 scores.
Gram queries use JSON table parameters to stay below D1's parameter ceiling.
The active pointer is checked again before responses; pinned gets never expose
historical revisions. R2 objects use vault ID, snapshot, and canonical relative
path keys. Reads validate exact byte size and SHA-256 before returning bytes.
Attachments stream from a bounded verified buffer; no unverified bytes escape.

Initial admission limits are 500 notes, 2,000 chunks, 500 source entries,
16 MiB total indexed JSON, 256 KiB per indexed row, 2 MiB per Markdown or
guidance source and 20 MiB per attachment. Aggregate APIs load bounded indexed
rows, never scan source objects. Exceeding a budget fails explicitly; no partial
aggregate is presented as complete. These conservative limits must be measured
on deployed Workers before expanding them. The synthetic seed is an offline
operator action, not an HTTP upload or indexing endpoint. Production onboarding
remains gated on #34 revision publication and exclusion validation.

## Access and validation

Require separate read/admin secrets, each 64 lowercase hex characters generated
from 32 random bytes. Fail closed on missing configuration, require HTTPS and
exact configured HTTPS Origins. All responses disable caching and application
request/content logging is disabled. A Workers rate-limit binding bounds
authenticated requests to 120 per minute
per deployment key per Cloudflare location; it is not a global quota. Configure
ingress abuse protection before deployment. Requests have a 30-second response
deadline; late binding results are discarded. Admin-only future operations
authenticate before returning 501.
No cloud watch or Git sync is enabled. Public health contains liveness only.

Local workerd/Miniflare tests exercise actual D1 and R2 bindings and migrations.
The package README describes reproducible local synthetic seeding and deployed
smoke validation. Local simulation is not evidence of a successful deployment;
record remote validation separately and do not onboard private content until
all rollout gates pass.

## Validation evidence (2026-10-28)

- `npm run typecheck`, `npm run lint`, `npm run format:check`, and
  `npm run build` passed.
- `npm test -- --maxWorkers=2`: 648 local tests passed. Unbounded parallel
  retries in this development environment intermittently reported timeouts
  across different existing suites; those retries were not clean passes.
- `npm run test:dist`: 8 packaged-artifact tests passed.
- Cloud package typecheck and Wrangler deployment dry-run passed;
  `npm test --prefix packages/cloudflare`: 18 workerd/D1/R2 tests passed,
  including a real SDK client connected to the local Worker simulator.
- Cloud package dependency audit reported zero vulnerabilities.

No Cloudflare account resources were provisioned and no deployed remote
Worker/client smoke test was performed. The remote compatibility gate in
validation-rollout.md remains open; #32 must not be closed on this evidence
alone. The README supplies the synthetic remote procedure.

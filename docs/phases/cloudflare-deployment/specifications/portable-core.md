# Portable Core Extraction

Status: Ready for Review (#31)

## Entrypoints And Compatibility

`@vault-agent/core/portable` exports runtime-neutral contracts, schemas,
parsing/chunking, filter evaluation, ranking/result construction, and asynchronous
search/related/retrieval use cases. `@vault-agent/core/local` exports the
filesystem, SQLite metadata, and sqlite-vec adapters. The existing root
entrypoint and synchronous local get/orientation/graph/profile APIs remain
compatible. Cloud adapters must not import the local or root entrypoints.

Node hash/path wrappers preserve the existing synchronous local API. Portable
identity/content hashing uses Web Crypto asynchronously; both produce the same
SHA-256 bytes. The existing local cache identity and index schema do not change.
Portable vault IDs are explicit, opaque deployment identity; source and index
instances must be scoped to the same vault. Canonical source path validation
is strict; legacy local query filter normalization is unchanged.

## Adapter Contracts

- `VaultSource` is read-only: paged enumeration, stat including content revision,
  bounded text and byte-stream reads with expected revision and abort signal.
  It is scoped at construction. Excluded paths fail distinctly from missing
  paths; neither errors nor adapter failures expose machine paths or content.
- `MetadataLexicalStore` provides asynchronous note/chunk/manifest reads,
  paged note and chunk enumeration, and bounded lexical/gram/metadata candidates with
  shared normalized filters. Storage rows retain current internal field names
  for extraction compatibility; those rows are not HTTP responses. No SQL,
  filesystem root, Config, or native database handle crosses the contract.
- `VectorStore` provides independently bounded query/upsert/delete operations
  with mutation receipts/status and backend metric interpretation. Local sqlite-vec retains its current
  distance threshold; cloud implementations must provide their own scoring.
- `EmbeddingProviderContract` provides model/input descriptor and ordered
  bounded embedding with cancellation. Unknown local dimensions are represented
  by null until first successful inference. Unknown model revision/token limits
  are also null; cloud adapters must explicitly identify their generation.
  Invalid, non-finite, inconsistent or incomplete vector responses are rejected,
  and provider failures do not echo response bodies or raw network errors.
  The same descriptor and input
  formatting are used for a single model generation.

Local search and related delegate through the asynchronous adapters. Existing
index coordinators continue to own local transactions/locks; the adapter
extraction does not introduce distributed publication into the local indexer.
Cloud staging/fencing/publication remains #34, using the revision protocol in
[ingestion and consistency](ingestion-consistency.md), not a generic CRUD API.
Orientation/graph/profile aggregation remains core-owned; #32 supplies bounded
cloud inputs without importing local storage or duplicating core rules.
The synchronous `AggregateIndexView` is an already loaded, bounded input view,
not an I/O interface. Cloud aggregation must meet the #32 CPU/read budgets;
exporting these functions does not establish whole-vault scan scalability.

Source revisions hash complete bytes. Legacy SQLite content hashes remain
32-hex decoded-text hashes; explicit portable get verifies these after text
decoding (including BOM handling) and independently pins the full byte revision
while reading. No local index migration is required. Local source enumeration
is a live view, with per-file revision protection; immutable cloud snapshot
publication is still #34.

## Verification

Contract tests use synthetic files and a genuinely asynchronous in-memory
metadata/vector implementation as well as the real local adapters. Cover
path/scope errors, missing/excluded content, revision mismatch, pagination,
aborts, IDs/hashes, filters, ranking and explicit retrieval. A browser-platform
bundle test rejects Node/native transitive imports and checks all dependencies
are bundled. A separate TypeScript build with DOM/ES types and no Node types
validates the public portable declarations. Existing local and dist tests
continue to verify HTTP/CLI/MCP behavior.

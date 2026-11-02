import { isPCloud, PCloudSnapshotSource } from "./source.js";
import {
  detectionStatus,
  ingestionEnabled,
  emptyManifest,
} from "./ingestion.js";
import mime from "mime/lite";
import * as core from "@vault-agent/core/portable";
import type { Env } from "./config.js";
import { config } from "./config.js";
import { D1MetadataStore, ftsName } from "./d1.js";
import { R2VaultSource } from "./r2.js";
import { CloudError } from "./errors.js";
import { z } from "zod";
import {
  WorkersAIEmbeddingProvider,
  ProviderOperations,
  type Usage,
} from "./provider.js";
import { VectorizeStore } from "./vectorize.js";
import { semanticProgress } from "./semantic-work.js";
import {
  mutationEpoch,
  mutationPath,
  mutationSuppression,
} from "./mutation-state.js";
import { readMutationSource } from "./mutations.js";

const compatibility = { stale: false, incompatible: false, details: "" };
function detectionFreshness(
  detection: Awaited<ReturnType<typeof detectionStatus>>,
): core.FreshnessState {
  if (!detection) return "fresh";
  return detection.state === "stale" || detection.state === "updating"
    ? detection.state
    : "unknown";
}
const getSchema = z.object({
  noteId: z.string().regex(/^[0-9a-f]{32}$/),
  chunkIndex: z.number().int().min(0).optional(),
  allowLarge: z.boolean().optional(),
  snapshot: z.string().optional(),
  expected_version: z.string().min(1).max(1024).optional(),
});
const fileSchema = z.object({
  path: z.string().min(1),
  allowLarge: z.boolean().optional(),
  download: z.boolean().optional(),
  snapshot: z.string().optional(),
});
function parse<T>(
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  input: unknown,
): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const fields = new Set(
      result.error.issues.map((issue) => String(issue.path[0])),
    );
    const code = fields.has("limit")
      ? "INVALID_LIMIT"
      : fields.has("mode")
        ? "INVALID_MODE"
        : fields.has("filters")
          ? result.error.issues.some((i) => i.path[1] === "frontmatter")
            ? "INVALID_FRONTMATTER_FILTER"
            : "INVALID_FILTER"
          : fields.has("query")
            ? "INVALID_QUERY"
            : fields.has("noteId") || fields.has("chunkIndex")
              ? "INVALID_ID"
              : "INVALID_PARAMETER";
    throw new CloudError(code);
  }
  return result.data;
}
export class RetrievalService {
  readonly source: core.VaultSource;
  readonly metadata: D1MetadataStore;
  readonly settings: ReturnType<typeof config>;
  readonly operations = new ProviderOperations();
  readonly vectors: VectorizeStore;
  constructor(
    readonly env: Env,
    readonly snapshot: string,
    manifest: core.IndexManifest,
    readonly store = snapshot,
    readonly epoch = 0,
    readonly incremental = false,
    readonly mutationReadEpoch: number | null = null,
    readonly suppressed: ReadonlySet<string> = new Set(),
    readonly unindexed = false,
  ) {
    ftsName(snapshot);
    this.settings = config(env);
    this.source = isPCloud(env)
      ? new PCloudSnapshotSource(env, store, this.settings.allowed)
      : new R2VaultSource(
          env.DB,
          env.SOURCE!,
          env.VAULT_ID,
          store,
          this.settings.allowed,
          incremental,
        );
    this.metadata = new D1MetadataStore(
      env.DB,
      env.VAULT_ID,
      store,
      manifest,
      this.settings.allowed,
      incremental,
      suppressed,
      this.settings.write.enabled ||
        (mutationReadEpoch !== null && mutationReadEpoch > 0),
    );
    this.vectors = new VectorizeStore(
      this.settings.semantic ? env.VECTORS : undefined,
      this.metadata,
      env.EMBEDDING_MODEL_REVISION,
      this.operations,
    );
  }
  static async open(env: Env, options: { allowUnindexed?: boolean } = {}) {
    // One ordered session, anchored at the primary, covers the complete read.
    const session = env.DB.withSession("first-primary");
    const DB = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare") return session.prepare.bind(session);
        if (key === "batch") return session.batch.bind(session);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    env = { ...env, DB };
    const sourceEpoch = isPCloud(env) ? null : await mutationEpoch(env);
    const incremental = !!(await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='publications'",
    ).first());
    const row = await env.DB.prepare(
      incremental
        ? "SELECT s.*,coalesce(p.snapshot,d.revision) AS public_snapshot,coalesce(p.epoch,0) AS epoch FROM deployment d JOIN snapshots s ON s.revision=d.revision LEFT JOIN publications p ON p.store=d.revision WHERE d.id=1"
        : "SELECT s.*,d.revision AS public_snapshot,0 AS epoch FROM deployment d JOIN snapshots s ON s.revision=d.revision WHERE d.id=1",
    ).first<{
      revision: string;
      vault_id: string;
      manifest: string;
      note_count: number;
      chunk_count: number;
      entry_count: number;
      indexed_bytes: number;
      public_snapshot: string;
      epoch: number;
    }>();
    if (!row) {
      if (
        options.allowUnindexed &&
        sourceEpoch !== null &&
        (config(env).write.enabled || sourceEpoch > 0)
      ) {
        const empty = "0".repeat(64);
        return new RetrievalService(
          env,
          empty,
          emptyManifest(env),
          empty,
          0,
          incremental,
          sourceEpoch,
          new Set(),
          true,
        );
      }
      throw new CloudError("INDEX_NOT_FOUND", 409);
    }
    if (row.vault_id !== env.VAULT_ID)
      throw new CloudError("INDEX_INCOMPATIBLE", 409);
    if (
      row.note_count > 500 ||
      row.chunk_count > 2000 ||
      row.entry_count > 500 ||
      row.indexed_bytes > 16 * 1024 * 1024
    )
      throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
    return new RetrievalService(
      env,
      row.public_snapshot,
      JSON.parse(row.manifest),
      row.revision,
      row.epoch,
      incremental,
      sourceEpoch,
      sourceEpoch === null
        ? new Set()
        : await mutationSuppression(env, row.revision),
    );
  }
  async current() {
    if (
      this.mutationReadEpoch !== null &&
      (await mutationEpoch(this.env)) !== this.mutationReadEpoch
    )
      throw new CloudError("REVISION_CHANGED", 409);
    const row = await this.env.DB.prepare(
      this.incremental
        ? "SELECT d.revision,coalesce(p.epoch,0) AS epoch FROM deployment d LEFT JOIN publications p ON p.store=d.revision WHERE d.id=1"
        : "SELECT revision,0 AS epoch FROM deployment WHERE id=1",
    ).first<{ revision: string; epoch: number }>();
    if (this.unindexed) {
      if (row) throw new CloudError("REVISION_CHANGED", 409);
      return;
    }
    if (row?.revision !== this.store || row?.epoch !== this.epoch)
      throw new CloudError("REVISION_CHANGED", 409);
  }
  pin(snapshot: unknown) {
    if (
      snapshot !== undefined &&
      (typeof snapshot !== "string" || snapshot !== this.snapshot)
    )
      throw new CloudError("REVISION_CHANGED", 409);
  }
  context(): core.RetrievalContext {
    return {
      metadata: this.metadata,
      compatibility,
      embeddingEnabled: this.settings.semantic,
      embeddingProvider: this.settings.semantic
        ? new WorkersAIEmbeddingProvider(
            this.env.AI!,
            this.env.EMBEDDING_MODEL_REVISION,
            this.operations,
          )
        : undefined,
      vectors: this.vectors,
    };
  }
  async aggregate(detection: Awaited<ReturnType<typeof detectionStatus>>) {
    return {
      store: await this.metadata.aggregate(),
      compatibility,
      config: this.settings,
      freshnessMachine: new core.FreshnessMachine(
        detectionFreshness(detection),
      ),
    };
  }
  async invoke(
    operation: string,
    input: unknown = {},
  ): Promise<{ data: unknown; warnings: core.WarningItem[]; usage?: Usage }> {
    try {
      return await this.execute(operation, input);
    } catch (error) {
      await this.current();
      throw error;
    }
  }
  private async execute(
    operation: string,
    input: unknown,
  ): Promise<{ data: unknown; warnings: core.WarningItem[]; usage?: Usage }> {
    const args = (input ?? {}) as Record<string, unknown>;
    if (this.unindexed && !["get_note", "get_attachment"].includes(operation))
      throw new CloudError("INDEX_NOT_FOUND", 409);
    const detection = await detectionStatus(this.env);
    let data: unknown;
    let warnings: core.WarningItem[] = [];
    if (
      this.mutationReadEpoch !== null &&
      ["get_note", "get_chunk"].includes(operation)
    ) {
      const p = parse(getSchema, args);
      this.pin(p.snapshot);
      let managed = await this.env.DB.prepare(
        "SELECT path FROM r2_mutation_paths WHERE note_id=?",
      )
        .bind(p.noteId)
        .first<{ path: string }>();
      if (!managed && this.settings.write.enabled) {
        const indexed = await this.env.DB.prepare(
          "SELECT path FROM notes WHERE revision=? AND note_id=?",
        )
          .bind(this.store, p.noteId)
          .first<{ path: string }>();
        managed = indexed;
      }
      if (managed) {
        const missing =
          operation === "get_chunk" ? "CHUNK_NOT_FOUND" : "NOTE_NOT_FOUND";
        const state = await mutationPath(this.env, managed.path);
        if (state?.state === "uncertain")
          throw new CloudError("SOURCE_UNAVAILABLE", 503);
        if (state?.state === "deleted") throw new CloudError(missing, 404);
        const value = await readMutationSource(
          this.env,
          managed.path,
          operation === "get_note",
          operation === "get_note" && !p.allowLarge
            ? core.DEFAULT_NOTE_RETRIEVAL_SIZE_LIMIT
            : 20 * 1024 * 1024,
        ).catch((error) => {
          if (
            error instanceof CloudError &&
            error.code === "SOURCE_TOO_LARGE" &&
            operation === "get_note"
          )
            throw new CloudError("NOTE_TOO_LARGE", 413);
          throw error;
        });
        if (!value) throw new CloudError(missing, 404);
        const indexed = await this.metadata.getNote(p.noteId);
        const observation = await this.env.DB.prepare(
          "SELECT object_version FROM source_observations WHERE revision=? AND path=?",
        )
          .bind(this.store, managed.path)
          .first<{ object_version: string }>();
        const fresh =
          indexed?.content_hash === value.digest &&
          observation?.object_version === value.object.version;
        if (operation === "get_chunk") {
          const chunk =
            p.chunkIndex === undefined
              ? null
              : await this.metadata.getChunk(p.noteId, p.chunkIndex);
          if (
            !indexed ||
            !chunk ||
            indexed.content_hash !== value.digest ||
            !p.expected_version ||
            ![value.version, core.indexedChunkVersion(indexed, chunk)].includes(
              p.expected_version,
            )
          )
            throw new CloudError("REVISION_CHANGED", 409);
          const payload = await core.getChunk(
            this.metadata,
            p.noteId,
            p.chunkIndex!,
          );
          await this.current();
          return { data: { ...payload, version: value.version }, warnings: [] };
        }
        const parsed = core.parseMarkdown(
          value.content!.replace(/^\uFEFF/, ""),
        );
        const latest: core.IndexRow = {
          path: managed.path,
          frontmatter_title: parsed.frontmatter?.title ?? parsed.title,
          aliases_json: JSON.stringify(parsed.aliases),
          tags_json: JSON.stringify(parsed.tags),
          date_value: parsed.frontmatter?.date ?? null,
          created_value: parsed.frontmatter?.created ?? null,
          updated_value: parsed.frontmatter?.updated ?? null,
          attachment_refs_json: JSON.stringify(parsed.attachmentReferences),
        };
        await this.current();
        return {
          data: {
            ...core.noteFromRow(
              p.noteId,
              latest,
              value.content!,
              value.bytes.length,
            ),
            version: value.version,
            index_state: fresh ? "fresh" : "pending",
            indexed_version: indexed?.content_hash ?? null,
          },
          warnings: fresh
            ? []
            : [
                {
                  code: "INDEX_UPDATING",
                  message: "Saved source is awaiting index publication.",
                },
              ],
        };
      }
    }
    if (operation === "search") {
      const p = parse(core.searchRequestSchema, args);
      const result = await core.search(
        this.context(),
        p.query,
        p.mode,
        p.limit ?? 10,
        p.filters,
      );
      const { warnings: resultWarnings, ...payload } = result;
      warnings = resultWarnings;
      data = payload;
    } else if (operation === "related") {
      const p = parse(core.relatedRequestSchema, args);
      const result = await core.getRelated(
        this.context(),
        p.type,
        p.id,
        p.mode,
        p.limit ?? 10,
      );
      const { warnings: resultWarnings, ...payload } = result;
      warnings = resultWarnings;
      data = payload;
    } else if (operation === "get_note" || operation === "get_chunk") {
      const p = parse(getSchema, args);
      this.pin(p.snapshot);
      if (operation === "get_note")
        data = await core.getNote(this.metadata, this.source, p.noteId, {
          allowLarge: p.allowLarge,
        });
      else {
        if (p.chunkIndex === undefined) throw new CloudError("INVALID_ID");
        const note = await this.metadata.getNote(p.noteId);
        if (note) {
          const entry = await this.source.stat(String(note.path));
          if (!entry || entry.revision !== note.content_hash)
            throw new CloudError("SOURCE_REVISION_MISMATCH", 409);
        }
        data = await core.getChunk(this.metadata, p.noteId, p.chunkIndex);
      }
      if (!data)
        throw new CloudError(
          operation === "get_note" ? "NOTE_NOT_FOUND" : "CHUNK_NOT_FOUND",
          404,
        );
    } else if (
      operation === "get_attachment" ||
      operation === "vault_guidance_get"
    ) {
      const p = parse(fileSchema, args);
      this.pin(p.snapshot);
      if (this.mutationReadEpoch !== null) {
        const state = await mutationPath(this.env, p.path);
        if (state?.state === "uncertain")
          throw new CloudError("SOURCE_UNAVAILABLE", 503);
        if (state?.state === "deleted")
          throw new CloudError(
            operation === "get_attachment"
              ? "ATTACHMENT_NOT_FOUND"
              : "GUIDANCE_NOT_FOUND",
            404,
          );
        if (
          (state || this.settings.write.enabled) &&
          operation === "get_attachment"
        ) {
          if (core.uploadKind(p.path) !== "attachment")
            throw new CloudError("ATTACHMENT_NOT_FOUND", 404);
          const value = await readMutationSource(
            this.env,
            p.path,
            false,
            p.download && !p.allowLarge ? 10 * 1024 * 1024 : 20 * 1024 * 1024,
          );
          if (!value) throw new CloudError("ATTACHMENT_NOT_FOUND", 404);
          const data = {
            path: p.path,
            fileName: p.path.split("/").at(-1)!,
            size: value.bytes.length,
            downloadAvailable: true,
            contentType: attachmentType(p.path),
            version: value.version,
            ...(p.download
              ? {
                  stream: new ReadableStream<Uint8Array>({
                    start(c) {
                      c.enqueue(value.bytes);
                      c.close();
                    },
                  }),
                }
              : {}),
          };
          await this.current();
          return { data, warnings: [] };
        }
        if (state && this.suppressed.has(p.path))
          throw new CloudError("REVISION_CHANGED", 409);
      }
      const entry = await this.source.stat(p.path);
      const guidance = operation === "vault_guidance_get";
      if (
        !entry ||
        (guidance ? !core.guidanceKind(p.path) : entry.kind !== "attachment")
      )
        throw new CloudError(
          guidance ? "GUIDANCE_NOT_FOUND" : "ATTACHMENT_NOT_FOUND",
          404,
        );
      if (guidance) {
        const candidate = this.guidance(entry);
        if (!p.allowLarge && entry.size > 200 * 1024)
          throw new CloudError("GUIDANCE_TOO_LARGE", 413);
        data = {
          ...candidate,
          content: await this.source.readText(p.path, {
            expectedRevision: entry.revision,
            maxBytes: p.allowLarge
              ? (this.mutationReadEpoch === null ? 2 : 20) * 1024 * 1024
              : 200 * 1024,
          }),
          contentType: /\.(md|markdown|mdc)$/i.test(p.path)
            ? "text/markdown; charset=utf-8"
            : "text/plain; charset=utf-8",
        };
      } else {
        const fileName = p.path.split("/").at(-1)!;
        data = {
          path: p.path,
          fileName,
          size: entry.size,
          downloadAvailable: true,
          contentType: attachmentType(p.path),
        };
        if (p.download) {
          if (!p.allowLarge && entry.size > 10 * 1024 * 1024)
            throw new CloudError("ATTACHMENT_TOO_LARGE", 413);
          const stream = await this.source.readBytes(p.path, {
            expectedRevision: entry.revision,
            maxBytes: p.allowLarge ? 20 * 1024 * 1024 : 10 * 1024 * 1024,
          });
          data = { ...(data as object), stream };
        }
      }
    } else if (operation === "vault_guidance_list") {
      const page = await this.source.list({ limit: 500 });
      if (page.cursor) throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
      data = {
        guidance: page.items
          .filter(
            (e) => !this.suppressed.has(e.path) && core.guidanceKind(e.path),
          )
          .map((e) => this.guidance(e)),
      };
    } else {
      const ctx = await this.aggregate(detection);
      let result: { data: unknown; warnings: core.WarningItem[] };
      switch (operation) {
        case "vault_overview":
          result = core.getOverview(ctx);
          break;
        case "vault_tree":
          result = core.getTree(ctx, parse(core.treeQuerySchema, args));
          break;
        case "vault_tags":
          result = core.getTags(ctx, parse(core.tagsQuerySchema, args));
          break;
        case "vault_facets":
          result = core.getFacets(ctx, parse(core.facetsQuerySchema, args));
          break;
        case "vault_links":
        case "vault_backlinks": {
          const p = parse(getSchema, args);
          result =
            operation === "vault_links"
              ? core.getNoteLinks(ctx, p.noteId)
              : core.getBacklinks(ctx, p.noteId);
          break;
        }
        case "vault_broken_links":
          result = core.getBrokenLinks(
            ctx,
            parse(core.linkLimitQuerySchema, args),
          );
          break;
        case "vault_orphans":
          result = core.getOrphanNotes(
            ctx,
            parse(core.linkLimitQuerySchema, args),
          );
          break;
        case "vault_link_summary":
          result = core.getLinkSummary(
            ctx,
            parse(core.linkSummaryQuerySchema, args),
          );
          break;
        case "vault_metadata_profile":
        case "vault_style_profile": {
          const p = parse(core.profileQuerySchema, args);
          const params = {
            limit: p.limit,
            pathPrefix: p.pathPrefix,
            noteIds: p.noteId,
            exampleSelection: p.exampleSelection,
            filters: {
              tags: p.tag,
              frontmatter: {
                type: p.frontmatterType,
                status: p.frontmatterStatus,
              },
            },
          };
          result =
            operation === "vault_metadata_profile"
              ? core.getMetadataProfile(ctx, params)
              : core.getStyleProfile(ctx, params);
          break;
        }
        default:
          throw new CloudError("CAPABILITY_UNSUPPORTED", 501);
      }
      data = result.data;
      warnings = result.warnings;
    }
    if (
      this.incremental &&
      this.settings.semantic &&
      ["search", "related"].includes(operation) &&
      args.mode !== "lexical"
    ) {
      const progress = await semanticProgress(this.env);
      if (progress.pendingInputs)
        warnings.push({
          code: "SEMANTIC_UPDATING",
          message:
            "Semantic updates are pending; results may omit changed notes.",
        });
    }
    if (detection)
      warnings.push({
        code:
          detection.state === "updating"
            ? "INDEX_UPDATING"
            : detection.state === "stale"
              ? "INDEX_STALE"
              : "INDEX_FRESHNESS_UNKNOWN",
        message:
          detection.state === "updating" || detection.state === "stale"
            ? "Serving the last published snapshot while source reconciliation is pending."
            : "Serving a published snapshot; recent source checks and Cron health are not persisted.",
      });
    await this.current();
    return {
      data,
      warnings,
      ...(this.settings.semantic && ["search", "related"].includes(operation)
        ? { usage: { ...this.operations.counts } }
        : {}),
    };
  }
  guidance(entry: core.SourceEntry) {
    const kind = core.guidanceKind(entry.path)!;
    const scope =
      kind === "cursor_rule"
        ? entry.path.split(/(?:^|\/)\.cursor\/rules\//)[0]!
        : entry.path.split("/").slice(0, -1).join("/");
    return {
      path: entry.path,
      kind,
      scope,
      appliesTo: scope ? `${scope}/**` : "**",
      size: entry.size,
      updated: entry.updated,
    };
  }
  revision() {
    return {
      vaultId: this.env.VAULT_ID,
      snapshot: this.unindexed ? null : this.snapshot,
    };
  }
  async status(host: string) {
    const ready = this.settings.semantic && (await this.vectors.available());
    return cloudStatus(
      this.env,
      host,
      this.snapshot,
      this.metadata.manifest.indexedAt,
      ready,
      this.incremental,
    );
  }
}
export async function cloudStatus(
  env: Env,
  host: string,
  snapshot: string | null,
  indexedAt: number | null,
  ready = false,
  incremental = false,
) {
  const detection = await detectionStatus(env);
  const semantic = incremental ? await semanticProgress(env) : null;
  return {
    server: { running: true, host, port: 443, apiKeyRequired: true },
    index: {
      freshness: {
        state: snapshot ? detectionFreshness(detection) : "unknown",
        lastSuccessfulUpdateAt: indexedAt,
        pendingChangeCount: 0,
        reindexRequired: false,
        reindexReasons: [],
      },
      embeddingState:
        ready && !semantic?.pendingInputs
          ? "ready"
          : config(env).semantic
            ? "unavailable"
            : "disabled",
    },
    watch: {
      enabled: false,
      state: "disabled",
      lastEventAt: null,
      pending: false,
      lastError: null,
    },
    sync: {
      enabled: false,
      configured: false,
      state: "idle",
      pending: false,
      lastSuccessfulSyncAt: null,
      consecutiveFailures: 0,
      lastError: null,
    },
    deployment: {
      runtime: "cloudflare",
      vaultId: env.VAULT_ID,
      activeRevision: snapshot,
      targetRevision: detection?.targetRevision ?? null,
      activeJobId: detection?.activeJobId ?? null,
      detection,
      ...(semantic ? { semantic } : {}),
      cleanupPending: detection?.cleanupPending ?? false,
      capabilities: {
        lexical: true,
        semantic: ready,
        attachments: !isPCloud(env),
        related: true,
        orientation: true,
        filters: true,
        links: true,
        guidance: !isPCloud(env),
        profiles: true,
        mcpHttp: true,
        upload: ingestionEnabled(env) && !isPCloud(env),
        indexJobs: ingestionEnabled(env),
        mutations: config(env).write.enabled,
        watch: false,
        gitSync: false,
      },
    },
  };
}
export function attachmentType(path: string) {
  return mime.getType(path) ?? "application/octet-stream";
}

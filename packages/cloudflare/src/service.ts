import mime from "mime/lite";
import * as core from "@vault-agent/core/portable";
import type { Env } from "./config.js";
import { config } from "./config.js";
import { D1MetadataStore, ftsName } from "./d1.js";
import { R2VaultSource } from "./r2.js";
import { CloudError } from "./errors.js";
import { z } from "zod";

const compatibility = { stale: false, incompatible: false, details: "" };
const getSchema = z.object({
  noteId: z.string().regex(/^[0-9a-f]{32}$/),
  chunkIndex: z.number().int().min(0).optional(),
  allowLarge: z.boolean().optional(),
  snapshot: z.string().optional(),
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
  readonly source: R2VaultSource;
  readonly metadata: D1MetadataStore;
  readonly settings: ReturnType<typeof config>;
  constructor(
    readonly env: Env,
    readonly snapshot: string,
    manifest: core.IndexManifest,
  ) {
    ftsName(snapshot);
    this.settings = config(env);
    this.source = new R2VaultSource(
      env.DB,
      env.SOURCE,
      env.VAULT_ID,
      snapshot,
      this.settings.allowed,
    );
    this.metadata = new D1MetadataStore(
      env.DB,
      env.VAULT_ID,
      snapshot,
      manifest,
      this.settings.allowed,
    );
  }
  static async open(env: Env) {
    const row = await env.DB.prepare(
      "SELECT s.* FROM deployment d JOIN snapshots s ON s.revision=d.revision WHERE d.id=1",
    ).first<{
      revision: string;
      vault_id: string;
      manifest: string;
      note_count: number;
      chunk_count: number;
      entry_count: number;
      indexed_bytes: number;
    }>();
    if (!row) throw new CloudError("INDEX_NOT_FOUND", 409);
    if (row.vault_id !== env.VAULT_ID)
      throw new CloudError("INDEX_INCOMPATIBLE", 409);
    if (
      row.note_count > 500 ||
      row.chunk_count > 2000 ||
      row.entry_count > 500 ||
      row.indexed_bytes > 16 * 1024 * 1024
    )
      throw new CloudError("INDEX_BUDGET_EXCEEDED", 413);
    return new RetrievalService(env, row.revision, JSON.parse(row.manifest));
  }
  async current() {
    const row = await this.env.DB.prepare(
      "SELECT revision FROM deployment WHERE id=1",
    ).first<{ revision: string }>();
    if (row?.revision !== this.snapshot)
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
    const unavailable = async () => ({ id: null, state: "failed" as const });
    return {
      metadata: this.metadata,
      compatibility,
      embeddingEnabled: false,
      vectors: {
        vaultId: this.env.VAULT_ID,
        available: async () => false,
        query: async () => [],
        upsert: unavailable,
        delete: unavailable,
        mutationStatus: async () => "failed",
        score: () => 0,
        minimumScore: 1,
      },
    };
  }
  async aggregate() {
    return {
      store: await this.metadata.aggregate(),
      compatibility,
      config: this.settings,
    };
  }
  async invoke(
    operation: string,
    input: unknown = {},
  ): Promise<{ data: unknown; warnings: core.WarningItem[] }> {
    const args = (input ?? {}) as Record<string, unknown>;
    let data: unknown;
    let warnings: core.WarningItem[] = [];
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
            maxBytes: p.allowLarge ? 2 * 1024 * 1024 : 200 * 1024,
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
          .filter((e) => core.guidanceKind(e.path))
          .map((e) => this.guidance(e)),
      };
    } else {
      const ctx = await this.aggregate();
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
    await this.current();
    return { data, warnings };
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
    return { vaultId: this.env.VAULT_ID, snapshot: this.snapshot };
  }
  status(host: string) {
    return {
      server: { running: true, host, port: 443, apiKeyRequired: true },
      index: {
        freshness: {
          state: "fresh",
          lastSuccessfulUpdateAt: this.metadata.manifest.indexedAt,
          pendingChangeCount: 0,
          reindexRequired: false,
          reindexReasons: [],
        },
        embeddingState: "disabled",
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
        vaultId: this.env.VAULT_ID,
        activeRevision: this.snapshot,
        targetRevision: null,
        activeJobId: null,
        cleanupPending: false,
        capabilities: {
          lexical: true,
          semantic: false,
          attachments: true,
          related: true,
          orientation: true,
          filters: true,
          links: true,
          guidance: true,
          profiles: true,
          mcpHttp: true,
          upload: false,
          indexJobs: false,
          watch: false,
          gitSync: false,
        },
      },
    };
  }
}
export function attachmentType(path: string) {
  return mime.getType(path) ?? "application/octet-stream";
}

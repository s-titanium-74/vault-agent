import { Command } from "commander";
import { loadConfig } from "@vault-agent/core";
import { CliContext } from "../context.js";
import {
  DEFAULT_TIMEOUT_MS,
  exitCodeFromStatus,
  fetchWithTimeout,
  formatError,
  headersWithAuth,
} from "../http.js";

type LinkData = Record<string, unknown>;

export function registerLinkCommands(
  program: Command,
  context: CliContext,
): void {
  const linksCmd = program
    .command("links")
    .description("Inspect explicit vault link graph relationships");

  linksCmd
    .command("note <noteId>")
    .description("Show outlinks and backlinks for a note")
    .option("--json", "Output as JSON")
    .action(async (noteId, opts) => {
      await runLinksRequest(
        context,
        `/links/notes/${noteId}`,
        opts,
        printNoteLinks,
      );
    });

  linksCmd
    .command("backlinks <noteId>")
    .description("Show backlinks for a note")
    .option("--json", "Output as JSON")
    .action(async (noteId, opts) => {
      await runLinksRequest(
        context,
        `/links/backlinks/${noteId}`,
        opts,
        printBacklinks,
      );
    });

  linksCmd
    .command("broken")
    .description("List unresolved vault links")
    .option("--limit <n>", "Maximum links", parseInt)
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      await runLinksRequest(
        context,
        buildPath("/links/broken", { limit: opts.limit }),
        opts,
        printBrokenLinks,
      );
    });

  linksCmd
    .command("orphans")
    .description("List notes with no resolved inbound or outbound note links")
    .option("--limit <n>", "Maximum notes", parseInt)
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      await runLinksRequest(
        context,
        buildPath("/links/orphans", { limit: opts.limit }),
        opts,
        printOrphans,
      );
    });

  linksCmd
    .command("summary")
    .description("Show compact link graph summary")
    .option("--limit <n>", "Maximum top linked notes", parseInt)
    .option("--path <prefix>", "Vault-relative path prefix")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      await runLinksRequest(
        context,
        buildPath("/links/summary", {
          limit: opts.limit,
          pathPrefix: opts.path,
        }),
        opts,
        printSummary,
      );
    });
}

async function runLinksRequest(
  context: CliContext,
  path: string,
  opts: { json?: boolean },
  printer: (result: LinkData) => void,
): Promise<void> {
  const config = loadConfig(context.resolveConfigPath());
  const endpoint = context.resolveEndpoint(config);
  const apiKey = context.resolveApiKey(config);

  try {
    const response = await fetchWithTimeout(
      `${endpoint}${path}`,
      { headers: headersWithAuth(apiKey) },
      DEFAULT_TIMEOUT_MS,
    );
    const data = await response.json();

    if (response.status >= 400) {
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.error(formatError(response, data));
      }
      process.exit(exitCodeFromStatus(response.status));
    }

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
    } else {
      printer((data.data ?? data) as LinkData);
      if (data.warnings?.length) {
        for (const warning of data.warnings) {
          console.warn(`Warning: ${warning.code}: ${warning.message}`);
        }
      }
    }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.error(`TIMEOUT: Request timed out.`);
    } else {
      console.error(
        `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
      );
    }
    process.exit(1);
  }
}

function buildPath(
  pathname: string,
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${pathname}?${qs}` : pathname;
}

function printNoteLinks(result: LinkData): void {
  console.log(`Path: ${result.path}`);
  console.log(`Outlinks: ${arrayLength(result.outlinks)}`);
  for (const link of arrayValue(result.outlinks)) {
    printLink(link);
  }
  console.log(`Backlinks: ${arrayLength(result.backlinks)}`);
  for (const link of arrayValue(result.backlinks)) {
    printLink(link);
  }
}

function printBacklinks(result: LinkData): void {
  console.log(`Path: ${result.path}`);
  console.log(`Backlinks: ${arrayLength(result.backlinks)}`);
  for (const link of arrayValue(result.backlinks)) {
    printLink(link);
  }
}

function printBrokenLinks(result: LinkData): void {
  console.log(`Broken links: ${arrayLength(result.links)}/${result.total}`);
  for (const link of arrayValue(result.links)) {
    printLink(link);
  }
}

function printOrphans(result: LinkData): void {
  console.log(`Orphan notes: ${arrayLength(result.notes)}/${result.total}`);
  for (const note of arrayValue(result.notes)) {
    const item = note as {
      path?: string;
      inboundCount?: number;
      outboundCount?: number;
    };
    console.log(
      `  ${item.path} inbound=${item.inboundCount ?? 0} outbound=${item.outboundCount ?? 0}`,
    );
  }
}

function printSummary(result: LinkData): void {
  console.log(`Notes: ${result.noteCount}`);
  console.log(`Resolved links: ${result.resolvedLinkCount}`);
  console.log(`Unresolved links: ${result.unresolvedLinkCount}`);
  console.log(`Orphan notes: ${result.orphanNoteCount}`);
  console.log("Top linked notes:");
  for (const note of arrayValue(result.topLinkedNotes)) {
    const item = note as {
      path?: string;
      inboundCount?: number;
      outboundCount?: number;
    };
    console.log(
      `  ${item.path} inbound=${item.inboundCount ?? 0} outbound=${item.outboundCount ?? 0}`,
    );
  }
}

function printLink(link: unknown): void {
  const item = link as {
    sourcePath?: string;
    targetPath?: string | null;
    rawTarget?: string;
    resolved?: boolean;
  };
  const target = item.resolved ? item.targetPath : `${item.rawTarget} (broken)`;
  console.log(`  ${item.sourcePath} -> ${target}`);
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function arrayLength(value: unknown): number {
  return arrayValue(value).length;
}

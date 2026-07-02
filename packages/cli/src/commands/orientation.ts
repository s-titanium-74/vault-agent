import { Command } from "commander";
import { loadConfig } from "@vault-agent/core";
import { CliContext } from "../context.js";
import {
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  formatError,
  headersWithAuth,
} from "../http.js";

export function registerOrientationCommands(
  program: Command,
  context: CliContext,
): void {
  program
    .command("overview")
    .description("Show compact vault-level metadata")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      await runOrientationCommand("/overview", {}, opts, context);
    });

  program
    .command("tree")
    .description("Show bounded directory tree with note counts")
    .option("--depth <n>", "Maximum folder depth (1-10)", parseInt)
    .option("--limit <n>", "Maximum tree nodes (1-500)", parseInt)
    .option("--direct-only", "Count only notes directly in each folder")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const params: Record<string, string> = {};
      if (opts.depth !== undefined) params.depth = String(opts.depth);
      if (opts.limit !== undefined) params.limit = String(opts.limit);
      if (opts.directOnly) params.directOnly = "true";
      await runOrientationCommand("/tree", params, opts, context);
    });

  program
    .command("tags")
    .description("Show tag names and note-level counts")
    .option("--limit <n>", "Maximum tags (1-200)", parseInt)
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const params: Record<string, string> = {};
      if (opts.limit !== undefined) params.limit = String(opts.limit);
      await runOrientationCommand("/tags", params, opts, context);
    });

  program
    .command("facets")
    .description("Show frontmatter field names, counts, and allowlisted values")
    .option("--limit <n>", "Maximum fields (1-200)", parseInt)
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const params: Record<string, string> = {};
      if (opts.limit !== undefined) params.limit = String(opts.limit);
      await runOrientationCommand("/facets", params, opts, context);
    });
}

interface OrientationData {
  warnings?: Array<{ code: string; message: string }>;
  [key: string]: unknown;
}

async function runOrientationCommand(
  path: string,
  params: Record<string, string>,
  opts: { json?: boolean },
  context: CliContext,
): Promise<void> {
  const config = loadConfig(context.resolveConfigPath());
  const endpoint = context.resolveEndpoint(config);
  const apiKey = context.resolveApiKey(config);

  const url = new URL(path, endpoint);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  try {
    const response = await fetchWithTimeout(
      url.toString(),
      {
        method: "GET",
        headers: headersWithAuth(apiKey),
      },
      DEFAULT_TIMEOUT_MS,
    );

    const data = (await response.json()) as {
      data?: OrientationData;
      warnings?: Array<{ code: string; message: string }>;
      error?: { code: string; message: string };
    };

    if (response.status >= 400) {
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.error(formatError(response, data));
      }
      process.exit(orientationExitCodeFromResponse(response.status, data));
    }

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const result = data.data ?? (data as OrientationData);
    printHumanReadable(path, result);

    const warnings = data.warnings ?? result.warnings;
    if (warnings && warnings.length > 0) {
      for (const w of warnings) {
        console.warn(`Warning: ${w.code} — ${w.message}`);
      }
    }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") {
      console.error(`TIMEOUT: Request to ${endpoint}${path} timed out.`);
    } else {
      console.error(
        `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
      );
    }
    process.exit(6);
  }
}

function printHumanReadable(path: string, result: OrientationData): void {
  switch (path) {
    case "/overview":
      printOverview(result);
      break;
    case "/tree":
      printTree(result);
      break;
    case "/tags":
      printTags(result);
      break;
    case "/facets":
      printFacets(result);
      break;
    default:
      console.log(JSON.stringify(result, null, 2));
  }
}

function printOverview(result: OrientationData): void {
  console.log(`Notes: ${result.noteCount ?? 0}`);
  console.log(`Chunks: ${result.chunkCount ?? 0}`);

  const folders = result.topLevelFolders as
    Array<{ path: string; noteCount: number }> | undefined;
  if (folders && folders.length > 0) {
    console.log("\nTop folders:");
    for (const f of folders) {
      console.log(`  ${f.path}  ${f.noteCount}`);
    }
  }

  const tags = result.topTags as
    Array<{ tag: string; noteCount: number }> | undefined;
  if (tags && tags.length > 0) {
    console.log("\nTop tags:");
    for (const t of tags) {
      console.log(`  ${t.tag}  ${t.noteCount}`);
    }
  }

  const fields = result.frontmatterFields as
    Array<{ name: string; noteCount: number }> | undefined;
  if (fields && fields.length > 0) {
    console.log("\nTop fields:");
    for (const f of fields) {
      console.log(`  ${f.name}  ${f.noteCount}`);
    }
  }
}

function printTree(result: OrientationData): void {
  const tree = result.tree as
    { path: string; noteCount: number; children: unknown[] } | undefined;
  if (!tree) return;
  printTreeNode(tree, 0);
}

function printTreeNode(
  node: { path: string; noteCount: number; children: unknown[] },
  indent: number,
): void {
  const prefix = "  ".repeat(indent);
  const name = node.path === "" ? "Vault root" : node.path;
  console.log(`${prefix}${name}  ${node.noteCount}`);
  for (const child of node.children ?? []) {
    printTreeNode(
      child as { path: string; noteCount: number; children: unknown[] },
      indent + 1,
    );
  }
}

function printTags(result: OrientationData): void {
  const tags = result.tags as
    Array<{ tag: string; noteCount: number }> | undefined;
  if (!tags || tags.length === 0) return;
  console.log("tag         notes");
  for (const t of tags) {
    console.log(`${t.tag.padEnd(12)} ${t.noteCount}`);
  }
}

function printFacets(result: OrientationData): void {
  const fields = result.fields as
    | Array<{
        name: string;
        noteCount: number;
        values?: Array<{ value: string; noteCount: number }>;
      }>
    | undefined;
  if (!fields || fields.length === 0) return;
  console.log("Field   Notes  Values");
  for (const f of fields) {
    const values = f.values
      ? f.values.map((v) => `${v.value} ${v.noteCount}`).join(", ")
      : "";
    console.log(
      `${f.name.padEnd(8)} ${f.noteCount.toString().padEnd(6)} ${values}`,
    );
  }
}

function orientationExitCodeFromResponse(
  status: number,
  data: { error?: { code?: string } },
): number {
  const code = data.error?.code;
  if (status === 401 || status === 403) return 3;
  if (code === "INDEX_NOT_FOUND") return 4;
  if (code === "INDEX_INCOMPATIBLE") return 7;
  if (code === "SERVER_UNAVAILABLE") return 6;
  if (status >= 400 && status < 500) return 2;
  if (status >= 500) return 1;
  return 1;
}

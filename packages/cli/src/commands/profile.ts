import { Command } from "commander";
import { loadConfig } from "@vault-agent/core";
import { CliContext } from "../context.js";
import {
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  formatError,
  headersWithAuth,
} from "../http.js";

export function registerProfileCommands(
  program: Command,
  context: CliContext,
): void {
  const profile = program
    .command("profile")
    .description("Show compact style and metadata profiles");

  profile
    .command("metadata")
    .description("Show frontmatter key and allowlisted value profile")
    .option("--path <prefix>", "Vault-relative path prefix")
    .option("--tag <tag>", "Include frontmatter tag", collect)
    .option(
      "--frontmatter <field=value>",
      "Include allowlisted frontmatter field/value filter",
      collect,
    )
    .option("--note-id <id>", "Include explicit note ID", collect)
    .option(
      "--examples <mode>",
      "Example selection mode: path or representative",
    )
    .option("--limit <n>", "Maximum list entries (1-100)", parseInt)
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      await runProfileCommand("/profiles/metadata", opts, context);
    });

  profile
    .command("style")
    .description("Show Markdown style and link convention profile")
    .option("--path <prefix>", "Vault-relative path prefix")
    .option("--tag <tag>", "Include frontmatter tag", collect)
    .option(
      "--frontmatter <field=value>",
      "Include allowlisted frontmatter field/value filter",
      collect,
    )
    .option("--note-id <id>", "Include explicit note ID", collect)
    .option(
      "--examples <mode>",
      "Example selection mode: path or representative",
    )
    .option("--limit <n>", "Maximum list entries (1-100)", parseInt)
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      await runProfileCommand("/profiles/style", opts, context);
    });
}

interface ProfileData {
  warnings?: Array<{ code: string; message: string }>;
  [key: string]: unknown;
}

async function runProfileCommand(
  path: string,
  opts: {
    path?: string;
    tag?: string[];
    frontmatter?: string[];
    noteId?: string[];
    examples?: string;
    limit?: number;
    json?: boolean;
  },
  context: CliContext,
): Promise<void> {
  const config = loadConfig(context.resolveConfigPath());
  const endpoint = context.resolveEndpoint(config);
  const apiKey = context.resolveApiKey(config);

  const url = new URL(path, endpoint);
  if (opts.path !== undefined) url.searchParams.set("pathPrefix", opts.path);
  if (opts.limit !== undefined)
    url.searchParams.set("limit", String(opts.limit));
  for (const tag of opts.tag ?? []) url.searchParams.append("tag", tag);
  for (const noteId of opts.noteId ?? []) {
    url.searchParams.append("noteId", noteId);
  }
  if (opts.examples !== undefined) {
    if (opts.examples !== "path" && opts.examples !== "representative") {
      console.error(
        "INVALID_PARAMETER: --examples must be path or representative.",
      );
      process.exit(2);
    }
    url.searchParams.set("exampleSelection", opts.examples);
  }
  for (const entry of opts.frontmatter ?? []) {
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex <= 0 || equalsIndex === entry.length - 1) {
      console.error(
        "INVALID_FRONTMATTER_FILTER: --frontmatter must use field=value.",
      );
      process.exit(2);
    }
    const field = entry.slice(0, equalsIndex).trim();
    const value = entry.slice(equalsIndex + 1).trim();
    if (field === "type") {
      url.searchParams.append("frontmatterType", value);
    } else if (field === "status") {
      url.searchParams.append("frontmatterStatus", value);
    } else {
      console.error(
        "INVALID_FRONTMATTER_FILTER: profile filters support only type and status.",
      );
      process.exit(2);
    }
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
      data?: ProfileData;
      warnings?: Array<{ code: string; message: string }>;
      error?: { code: string; message: string };
    };

    if (response.status >= 400) {
      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        console.error(formatError(response, data));
      }
      process.exit(profileExitCodeFromResponse(response.status, data));
    }

    if (opts.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const result = data.data ?? (data as ProfileData);
    printHumanReadable(path, result);

    const warnings = data.warnings ?? result.warnings;
    if (warnings && warnings.length > 0) {
      for (const w of warnings) {
        console.warn(`Warning: ${w.code} - ${w.message}`);
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

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

function printHumanReadable(path: string, result: ProfileData): void {
  const scope = result.scope as
    { pathPrefix: string | null; noteCount: number } | undefined;
  console.log(`Scope: ${scope?.pathPrefix ?? "vault"}`);
  console.log(`Notes: ${scope?.noteCount ?? 0}`);

  if (path === "/profiles/metadata") {
    printMetadataProfile(result);
  } else {
    printStyleProfile(result);
  }
}

function printMetadataProfile(result: ProfileData): void {
  const fields = result.frontmatterKeys as
    | Array<{
        name: string;
        noteCount: number;
        values?: Array<{ value: string; noteCount: number }>;
      }>
    | undefined;
  if (fields && fields.length > 0) {
    console.log("\nFrontmatter:");
    for (const field of fields) {
      const values = field.values
        ? ` (${field.values.map((v) => `${v.value} ${v.noteCount}`).join(", ")})`
        : "";
      console.log(`  ${field.name}  ${field.noteCount}${values}`);
    }
  }

  const tags = result.tags as
    Array<{ tag: string; noteCount: number }> | undefined;
  if (tags && tags.length > 0) {
    console.log("\nTags:");
    for (const tag of tags) {
      console.log(`  ${tag.tag}  ${tag.noteCount}`);
    }
  }
}

function printStyleProfile(result: ProfileData): void {
  const headings = result.headings as
    | {
        levelDistribution?: Array<{
          level: number;
          noteCount: number;
          headingCount: number;
        }>;
        commonHeadingNames?: Array<{ heading: string; noteCount: number }>;
        h1MatchesTitleCount?: number;
      }
    | undefined;
  if (headings) {
    console.log(`H1 matches title: ${headings.h1MatchesTitleCount ?? 0}`);
    if (headings.levelDistribution?.length) {
      console.log("\nHeading levels:");
      for (const item of headings.levelDistribution) {
        console.log(
          `  H${item.level}  notes=${item.noteCount} headings=${item.headingCount}`,
        );
      }
    }
    if (headings.commonHeadingNames?.length) {
      console.log("\nCommon headings:");
      for (const item of headings.commonHeadingNames) {
        console.log(`  ${item.heading}  ${item.noteCount}`);
      }
    }
  }

  const links = result.links as
    | {
        wikiLinkNoteCount: number;
        markdownLinkNoteCount: number;
        wikiLinkCount: number;
        markdownLinkCount: number;
      }
    | undefined;
  if (links) {
    console.log("\nLinks:");
    console.log(
      `  Wiki links: ${links.wikiLinkCount} in ${links.wikiLinkNoteCount} notes`,
    );
    console.log(
      `  Markdown links: ${links.markdownLinkCount} in ${links.markdownLinkNoteCount} notes`,
    );
  }

  const namingPatterns = result.namingPatterns as
    Array<{ pattern: string; noteCount: number }> | undefined;
  if (namingPatterns?.length) {
    console.log("\nNaming:");
    for (const item of namingPatterns) {
      console.log(`  ${item.pattern}  ${item.noteCount}`);
    }
  }
}

function profileExitCodeFromResponse(
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

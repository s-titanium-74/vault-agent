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

export function registerSearchCommands(
  program: Command,
  context: CliContext,
): void {
  program
    .command("search <query...>")
    .description("Search vault notes")
    .option("--mode <mode>", "Search mode: lexical, embedding, hybrid")
    .option("--limit <n>", "Result limit", parseInt)
    .option("--path <prefix>", "Include vault-relative path prefix", collect)
    .option(
      "--exclude-path <prefix>",
      "Exclude vault-relative path prefix",
      collect,
    )
    .option("--tag <tag>", "Include frontmatter tag", collect)
    .option("--exclude-tag <tag>", "Exclude frontmatter tag", collect)
    .option(
      "--frontmatter <field=value>",
      "Include allowlisted frontmatter field/value filter",
      collect,
    )
    .option("--json", "Output as JSON")
    .action(async (queryParts, opts) => {
      const config = loadConfig(context.resolveConfigPath());
      const endpoint = context.resolveEndpoint(config);
      const apiKey = context.resolveApiKey(config);
      const query = queryParts.join(" ");

      const filters = buildSearchFilters(opts);
      if (filters.error) {
        console.error(`${filters.error.code}: ${filters.error.message}`);
        process.exit(2);
        return;
      }

      try {
        const response = await fetchWithTimeout(
          `${endpoint}/search`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...headersWithAuth(apiKey),
            },
            body: JSON.stringify({
              query,
              mode: opts.mode,
              limit: opts.limit,
              ...(filters.value ? { filters: filters.value } : {}),
            }),
          },
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
          const result = data.data ?? data;
          console.log(`Mode: ${result.requestedMode} -> ${result.usedMode}`);
          console.log(`Results (${result.results.length}/${result.limit}):`);
          for (const r of result.results) {
            console.log(
              `  ${r.path} #${r.heading ?? "(untitled)"} [${r.reason}] score=${r.score.toFixed(3)}`,
            );
            if (r.snippet) {
              console.log(`    ${r.snippet}`);
            }
          }
          if (data.warnings?.length) {
            for (const w of data.warnings) {
              console.warn(`Warning: ${w.code}: ${w.message}`);
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          console.error(`TIMEOUT: Request to ${endpoint}/search timed out.`);
        } else {
          console.error(
            `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
          );
        }
        process.exit(1);
      }
    });

  program
    .command("related <id>")
    .description("Find related notes from a note or chunk ID")
    .option("--type <type>", "Input type: note or chunk")
    .option("--mode <mode>", "Search mode: lexical, embedding, hybrid")
    .option("--limit <n>", "Result limit", parseInt)
    .option("--json", "Output as JSON")
    .action(async (id, opts) => {
      const config = loadConfig(context.resolveConfigPath());
      const endpoint = context.resolveEndpoint(config);
      const apiKey = context.resolveApiKey(config);

      let type: "note" | "chunk";
      if (opts.type) {
        type = opts.type as "note" | "chunk";
      } else if (id.includes(":")) {
        type = "chunk";
      } else if (/^[0-9a-f]{32}$/.test(id)) {
        type = "note";
      } else {
        console.error(
          "INVALID_ID: Cannot determine type. Use --type note or --type chunk.",
        );
        process.exit(2);
        return;
      }

      try {
        const response = await fetchWithTimeout(
          `${endpoint}/related`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...headersWithAuth(apiKey),
            },
            body: JSON.stringify({
              type,
              id,
              mode: opts.mode,
              limit: opts.limit,
            }),
          },
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
          const result = data.data ?? data;
          console.log(`Input: ${result.input.type} ${result.input.id}`);
          console.log(`Mode: ${result.requestedMode} -> ${result.usedMode}`);
          console.log(`Results (${result.results.length}/${result.limit}):`);
          for (const r of result.results) {
            console.log(
              `  ${r.path} #${r.heading ?? "(untitled)"} [${r.reason}] score=${r.score.toFixed(3)}`,
            );
            if (r.snippet) {
              console.log(`    ${r.snippet}`);
            }
          }
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          console.error(`TIMEOUT: Request to ${endpoint}/related timed out.`);
        } else {
          console.error(
            `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
          );
        }
        process.exit(1);
      }
    });
}

function collect(value: string, previous: string[] | undefined): string[] {
  return [...(previous ?? []), value];
}

interface CliSearchFilters {
  pathPrefix?: string[];
  excludePathPrefix?: string[];
  tags?: string[];
  excludeTags?: string[];
  frontmatter?: {
    type?: string[];
    status?: string[];
  };
}

function buildSearchFilters(
  opts: Record<string, unknown>,
):
  | { value?: CliSearchFilters; error?: never }
  | { value?: never; error: { code: string; message: string } } {
  const filters: CliSearchFilters = {};

  const pathPrefix = readStringArray(opts.path);
  const excludePathPrefix = readStringArray(opts.excludePath);
  const tags = readStringArray(opts.tag);
  const excludeTags = readStringArray(opts.excludeTag);

  for (const pathValue of [...pathPrefix, ...excludePathPrefix]) {
    if (
      pathValue.trim().length === 0 ||
      pathValue.startsWith("/") ||
      pathValue.startsWith("\\") ||
      pathValue.split(/[\\/]+/).some((segment) => segment === "..")
    ) {
      return {
        error: {
          code: "INVALID_PATH_FILTER",
          message: "Path filters must be vault-relative prefixes.",
        },
      };
    }
  }

  for (const tagValue of [...tags, ...excludeTags]) {
    const normalized = tagValue.trim().replace(/^#/, "");
    if (normalized.length === 0) {
      return {
        error: {
          code: "INVALID_TAG_FILTER",
          message: "Tag filters must not be empty.",
        },
      };
    }
  }

  if (pathPrefix.length > 0) filters.pathPrefix = pathPrefix;
  if (excludePathPrefix.length > 0) {
    filters.excludePathPrefix = excludePathPrefix;
  }
  if (tags.length > 0) filters.tags = tags;
  if (excludeTags.length > 0) filters.excludeTags = excludeTags;

  const frontmatterFlags = readStringArray(opts.frontmatter);
  for (const entry of frontmatterFlags) {
    const equalsIndex = entry.indexOf("=");
    if (equalsIndex <= 0) {
      return {
        error: {
          code: "INVALID_FRONTMATTER_FILTER",
          message: "Frontmatter filters must use field=value.",
        },
      };
    }
    const field = entry.slice(0, equalsIndex).trim();
    const value = entry.slice(equalsIndex + 1).trim();
    if ((field !== "type" && field !== "status") || value.length === 0) {
      return {
        error: {
          code: "INVALID_FRONTMATTER_FILTER",
          message: "Frontmatter filters support only type and status.",
        },
      };
    }
    filters.frontmatter ??= {};
    const values = filters.frontmatter[field] ?? [];
    values.push(value);
    filters.frontmatter[field] = values;
  }

  return Object.keys(filters).length > 0 ? { value: filters } : {};
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

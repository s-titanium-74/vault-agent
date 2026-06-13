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
    .option("--json", "Output as JSON")
    .action(async (queryParts, opts) => {
      const config = loadConfig(context.resolveConfigPath());
      const endpoint = context.resolveEndpoint(config);
      const apiKey = context.resolveApiKey(config);
      const query = queryParts.join(" ");

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

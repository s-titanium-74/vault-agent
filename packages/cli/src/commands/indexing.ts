import { Command } from "commander";
import { loadConfig } from "@vault-agent/core";
import { CliContext } from "../context.js";
import {
  INDEXING_TIMEOUT_MS,
  fetchWithTimeout,
  getCommandResultFromHttpResponse,
  headersWithAuth,
} from "../http.js";

export function registerIndexingCommands(
  program: Command,
  context: CliContext,
): void {
  registerIndexCommand(
    program,
    context,
    "index",
    "Perform incremental indexing",
  );
  registerIndexCommand(program, context, "reindex", "Perform full reindexing");
}

function registerIndexCommand(
  program: Command,
  context: CliContext,
  commandName: "index" | "reindex",
  description: string,
): void {
  program
    .command(commandName)
    .description(description)
    .option("--require-embeddings", "Fail if embedding generation fails")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const config = loadConfig(context.resolveConfigPath());
      const endpoint = context.resolveEndpoint(config);
      const apiKey = context.resolveApiKey(config);

      try {
        const response = await fetchWithTimeout(
          `${endpoint}/${commandName}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...headersWithAuth(apiKey),
            },
            body: JSON.stringify({
              requireEmbeddings: opts.requireEmbeddings || false,
            }),
          },
          INDEXING_TIMEOUT_MS,
        );

        const data = await response.json();
        const commandResult = getCommandResultFromHttpResponse(
          response.status,
          data,
        );
        if (!commandResult.ok) {
          if (opts.json) {
            console.log(JSON.stringify(data, null, 2));
          } else {
            console.error(commandResult.message);
          }
          process.exit(commandResult.exitCode);
        }

        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          const result = data.data ?? data;
          console.log(`Indexing mode: ${result.mode}`);
          console.log(`Notes indexed: ${result.notesIndexed}`);
          console.log(`Chunks indexed: ${result.chunksIndexed}`);
          console.log(`Notes skipped: ${result.notesSkipped}`);
          if (result.warningCount > 0) {
            console.log(`Warnings: ${result.warningCount}`);
          }
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          console.error(
            `TIMEOUT: Request to ${endpoint}/${commandName} timed out.`,
          );
        } else {
          console.error(
            `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
          );
        }
        process.exit(1);
      }
    });
}

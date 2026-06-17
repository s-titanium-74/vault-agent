import { Command } from "commander";
import { loadConfig } from "@vault-agent/core";
import { CliContext } from "../context.js";
import {
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  getCommandResultFromHttpResponse,
  headersWithAuth,
} from "../http.js";

export function registerStatusCommands(
  program: Command,
  context: CliContext,
): void {
  program
    .command("status")
    .description("Show server, index, watcher, and sync status")
    .option("--json", "Output as JSON")
    .option("--verbose", "Show additional diagnostics")
    .action(async (options) => {
      const config = loadConfig(context.resolveConfigPath());
      const endpoint = context.resolveEndpoint(config);
      const apiKey = context.resolveApiKey(config);

      try {
        const response = await fetchWithTimeout(
          `${endpoint}/status`,
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              ...headersWithAuth(apiKey),
            },
          },
          DEFAULT_TIMEOUT_MS,
        );

        const data = await response.json();
        const commandResult = getCommandResultFromHttpResponse(
          response.status,
          data,
        );

        if (!commandResult.ok) {
          if (options.json) {
            console.log(JSON.stringify(data, null, 2));
          } else {
            console.error(commandResult.message);
          }
          process.exit(commandResult.exitCode);
        }

        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          renderStatus(data.data, options.verbose ?? false);
        }
      } catch (err: unknown) {
        const isTimeout =
          err instanceof DOMException && err.name === "AbortError";
        if (options.json) {
          const data = {
            data: {
              server: {
                running: false,
                endpoint,
                configPath: context.resolveConfigPath() ?? null,
              },
              index: null,
              watch: null,
              sync: null,
            },
            warnings: [
              {
                code: isTimeout ? "SERVER_TIMEOUT" : "SERVER_UNREACHABLE",
                message: isTimeout
                  ? `Request to ${endpoint}/status timed out.`
                  : `Server is not reachable at ${endpoint}.`,
              },
            ],
          };
          console.log(JSON.stringify(data, null, 2));
          process.exit(1);
        }
        if (isTimeout) {
          console.error(`TIMEOUT: Request to ${endpoint}/status timed out.`);
        } else {
          console.error(
            `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
          );
        }
        process.exit(1);
      }
    });

  const watchCmd = program.command("watch").description("Watcher commands");

  watchCmd
    .command("status")
    .description("Show watcher status only")
    .option("--json", "Output as JSON")
    .option("--verbose", "Show additional diagnostics")
    .action(async (options) => {
      const config = loadConfig(context.resolveConfigPath());
      const endpoint = context.resolveEndpoint(config);
      const apiKey = context.resolveApiKey(config);

      try {
        const response = await fetchWithTimeout(
          `${endpoint}/status`,
          {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
              ...headersWithAuth(apiKey),
            },
          },
          DEFAULT_TIMEOUT_MS,
        );

        const data = await response.json();
        const commandResult = getCommandResultFromHttpResponse(
          response.status,
          data,
        );

        if (!commandResult.ok) {
          if (options.json) {
            console.log(JSON.stringify(data, null, 2));
          } else {
            console.error(commandResult.message);
          }
          process.exit(commandResult.exitCode);
        }

        const watchData = data.data?.watch ?? {
          enabled: false,
          state: "unknown",
          lastEventAt: null,
          pending: false,
          lastError: null,
        };

        if (options.json) {
          console.log(
            JSON.stringify(
              { data: { watch: watchData }, warnings: data.warnings ?? [] },
              null,
              2,
            ),
          );
        } else {
          renderWatcherStatus(watchData, options.verbose ?? false);
        }
      } catch (err: unknown) {
        const isTimeout =
          err instanceof DOMException && err.name === "AbortError";
        if (options.json) {
          const data = {
            data: {
              watch: {
                enabled: false,
                state: "unknown",
                lastEventAt: null,
                pending: false,
                lastError: null,
              },
            },
            warnings: [
              {
                code: isTimeout ? "SERVER_TIMEOUT" : "SERVER_UNREACHABLE",
                message: isTimeout
                  ? `Request to ${endpoint}/status timed out.`
                  : `Server is not reachable at ${endpoint}.`,
              },
            ],
          };
          console.log(JSON.stringify(data, null, 2));
          process.exit(1);
        }
        if (isTimeout) {
          console.error(`TIMEOUT: Request to ${endpoint}/status timed out.`);
        } else {
          console.error(
            `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
          );
        }
        process.exit(1);
      }
    });
}

function renderStatus(status: Record<string, unknown>, verbose: boolean): void {
  const server = (status.server as Record<string, unknown>) ?? {};
  const index = (status.index as Record<string, unknown>) ?? {};
  const watch = (status.watch as Record<string, unknown>) ?? {};
  const sync = (status.sync as Record<string, unknown>) ?? {};

  console.log("=== Server ===");
  console.log(`  Running: ${server.running ?? false}`);
  console.log(
    `  Host: ${server.host ?? "unknown"}:${server.port ?? "unknown"}`,
  );
  console.log(`  API Key Required: ${server.apiKeyRequired ?? false}`);

  console.log("\n=== Index ===");
  const freshness = (index.freshness as Record<string, unknown>) ?? {};
  console.log(`  Freshness: ${freshness.state ?? "unknown"}`);
  if (freshness.lastSuccessfulUpdateAt) {
    console.log(
      `  Last Successful Update: ${new Date(freshness.lastSuccessfulUpdateAt as number).toISOString()}`,
    );
  }
  console.log(`  Pending Changes: ${freshness.pendingChangeCount ?? 0}`);
  console.log(`  Reindex Required: ${freshness.reindexRequired ?? false}`);
  if (
    verbose &&
    freshness.reindexReasons &&
    (freshness.reindexReasons as string[]).length > 0
  ) {
    console.log(`  Reindex Reasons:`);
    for (const reason of freshness.reindexReasons as string[]) {
      console.log(`    - ${reason}`);
    }
  }
  console.log(`  Embedding State: ${index.embeddingState ?? "unknown"}`);

  console.log("\n=== Watch ===");
  console.log(`  Enabled: ${watch.enabled ?? false}`);
  console.log(`  State: ${watch.state ?? "unknown"}`);
  if (watch.lastEventAt) {
    console.log(
      `  Last Event: ${new Date(watch.lastEventAt as number).toISOString()}`,
    );
  }
  console.log(`  Pending: ${watch.pending ?? false}`);
  if (verbose && watch.lastError) {
    const error = watch.lastError as Record<string, string>;
    console.log(`  Last Error: [${error.code}] ${error.message}`);
  }

  console.log("\n=== Sync ===");
  console.log(`  Enabled: ${sync.enabled ?? false}`);
  console.log(`  Configured: ${sync.configured ?? false}`);
  console.log(`  State: ${sync.state ?? "idle"}`);
  console.log(`  Pending: ${sync.pending ?? false}`);
  if (sync.lastSuccessfulSyncAt) {
    console.log(
      `  Last Successful Sync: ${new Date(sync.lastSuccessfulSyncAt as number).toISOString()}`,
    );
  }
  console.log(`  Consecutive Failures: ${sync.consecutiveFailures ?? 0}`);
  if (verbose && sync.lastError) {
    const error = sync.lastError as Record<string, string>;
    console.log(`  Last Error: [${error.code}] ${error.message}`);
  }
}

function renderWatcherStatus(
  watch: Record<string, unknown>,
  verbose: boolean,
): void {
  console.log("=== Watcher ===");
  console.log(`  Enabled: ${watch.enabled ?? false}`);
  console.log(`  State: ${watch.state ?? "unknown"}`);
  if (watch.lastEventAt) {
    console.log(
      `  Last Event: ${new Date(watch.lastEventAt as number).toISOString()}`,
    );
  }
  console.log(`  Pending: ${watch.pending ?? false}`);
  if (verbose && watch.lastError) {
    const error = watch.lastError as Record<string, string>;
    console.log(`  Last Error: [${error.code}] ${error.message}`);
  }
}

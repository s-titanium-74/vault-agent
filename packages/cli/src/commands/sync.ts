import { Command } from "commander";
import {
  ConfigManager,
  GitSync,
  indexVault,
  isAllowedGitRemoteUrl,
} from "@vault-agent/core";
import { CliContext } from "../context.js";
import { execFileSync } from "node:child_process";
import path from "node:path";
import {
  DEFAULT_TIMEOUT_MS,
  fetchWithTimeout,
  getCommandResultFromHttpResponse,
  headersWithAuth,
} from "../http.js";

export function registerSyncCommands(
  program: Command,
  context: CliContext,
): void {
  const syncCmd = program.command("sync").description("Git sync commands");

  syncCmd
    .command("status")
    .description("Show Git sync status only")
    .option("--json", "Output as JSON")
    .option("--verbose", "Show additional diagnostics")
    .action(async (options) => {
      const config = context.resolveConfigPath()
        ? new ConfigManager(context.resolveConfigPath()).load()
        : null;

      const endpoint = config
        ? context.resolveEndpoint(config)
        : "http://127.0.0.1:8787";
      const apiKey = config ? context.resolveApiKey(config) : "";

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

        if (options.json) {
          const syncData = data.data?.sync ?? {
            enabled: false,
            configured: false,
            state: "idle",
            pending: false,
            lastSuccessfulSyncAt: null,
            consecutiveFailures: 0,
            lastError: null,
          };
          console.log(
            JSON.stringify(
              { data: { sync: syncData }, warnings: data.warnings ?? [] },
              null,
              2,
            ),
          );
          return;
        }

        const sync = data.data?.sync ?? {};
        renderSyncStatus(sync, options.verbose ?? false);
      } catch {
        console.error(
          `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
        );
        process.exit(1);
      }
    });

  syncCmd
    .command("configure")
    .description("Configure Git sync for the current vault")
    .option("--repo <path>", "Repository path")
    .option("--remote <name>", "Remote name", "origin")
    .option("--remote-url <url>", "Remote URL")
    .option("--update-remote-url", "Update existing remote URL")
    .option("--branch <branch>", "Branch name")
    .option("--enable", "Enable sync after configuration")
    .option("--disable", "Disable sync after configuration")
    .action(async (options) => {
      const manager = new ConfigManager(context.resolveConfigPath());

      try {
        const config = manager.load();
        const repo = options.repo
          ? path.resolve(options.repo)
          : resolveGitRoot(config.vault.root);
        const remote = options.remote || "origin";

        if (!repo) {
          console.error(
            "SYNC_NOT_CONFIGURED: No Git worktree found. Pass --repo <path>.",
          );
          process.exit(2);
          return;
        }

        if (options.remoteUrl) {
          if (!isAllowedGitRemoteUrl(options.remoteUrl)) {
            console.error(
              "SYNC_REMOTE_URL_CONTAINS_CREDENTIALS: Remote URL is invalid or contains credentials.",
            );
            process.exit(2);
            return;
          }
          configureRemote(
            repo,
            remote,
            options.remoteUrl,
            Boolean(options.updateRemoteUrl),
          );
        }

        manager.set("sync.repo", repo);
        if (options.repo) {
          console.log("sync.repo set");
        }

        if (remote) {
          manager.set("sync.remote", remote);
          console.log("sync.remote set");
        }

        const branch = options.branch || resolveCurrentBranch(repo);
        if (branch) {
          manager.set("sync.branch", branch);
          console.log("sync.branch set");
        }

        if (options.enable) {
          manager.set("sync.enabled", "true");
          console.log("sync.enabled set to true");
        } else if (options.disable) {
          manager.set("sync.enabled", "false");
          console.log("sync.enabled set to false");
        }

        console.log("Sync configuration updated.");
      } catch (err: unknown) {
        console.error(
          `CONFIG_INVALID: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(2);
      }
    });

  syncCmd
    .command("clone <remote-url>")
    .description("Clone a remote repository")
    .requiredOption("--target <path>", "Target directory")
    .option("--branch <branch>", "Branch name")
    .option("--enable-sync", "Enable sync after clone")
    .option("--index", "Run initial index after clone")
    .action(async (remoteUrl, options) => {
      if (!isAllowedGitRemoteUrl(remoteUrl)) {
        console.error(
          "SYNC_REMOTE_URL_CONTAINS_CREDENTIALS: Remote URL is invalid or contains credentials.",
        );
        process.exit(2);
        return;
      }

      const target = path.resolve(options.target);
      const manager = new ConfigManager(context.resolveConfigPath());
      const sync = new GitSync({
        repo: "",
        remote: "origin",
        branch: options.branch ?? "",
      });

      try {
        console.log(`Cloning repository to ${target}...`);
        await sync.clone(remoteUrl, target);

        manager.set("vault.root", target);
        manager.set("sync.repo", target);
        manager.set("sync.remote", "origin");
        if (options.branch) {
          manager.set("sync.branch", options.branch);
        } else {
          const branch = resolveCurrentBranch(target);
          if (branch) manager.set("sync.branch", branch);
        }
        if (options.enableSync) {
          manager.set("sync.enabled", "true");
        }

        if (options.index) {
          const config = manager.load();
          await indexVault(config);
          console.log("Initial index complete.");
        } else {
          console.log("Next command: vault-agent index");
        }

        console.log("Clone complete.");
      } catch (err: unknown) {
        console.error(
          `SYNC_GIT_FAILED: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(1);
      }
    });

  syncCmd
    .command("pull")
    .description("Pull latest changes from remote")
    .option("--wait", "Wait for an already running sync")
    .option("--timeout <seconds>", "Wait timeout", "120")
    .option("--json", "Output as JSON")
    .action(async (options) => {
      const config = context.resolveConfigPath()
        ? new ConfigManager(context.resolveConfigPath()).load()
        : null;

      const endpoint = config
        ? context.resolveEndpoint(config)
        : "http://127.0.0.1:8787";
      const apiKey = config ? context.resolveApiKey(config) : "";

      try {
        const response = await fetchWithTimeout(
          `${endpoint}/sync/pull`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              ...headersWithAuth(apiKey),
            },
            body: JSON.stringify({
              wait: options.wait ?? false,
              timeoutSeconds: parseInt(options.timeout, 10) || 120,
            }),
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
          const result = data.data ?? {};
          console.log(`Sync status: ${result.status ?? "unknown"}`);
          console.log(`Changed: ${result.changed ?? false}`);
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === "AbortError") {
          console.error(`TIMEOUT: Request to ${endpoint}/sync/pull timed out.`);
        } else {
          console.error(
            `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
          );
        }
        process.exit(1);
      }
    });

  syncCmd
    .command("enable")
    .description("Enable scheduled sync")
    .action(async () => {
      const manager = new ConfigManager(context.resolveConfigPath());

      try {
        manager.set("sync.enabled", "true");
        console.log("Scheduled sync enabled.");
      } catch (err: unknown) {
        console.error(
          `CONFIG_INVALID: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(2);
      }
    });

  syncCmd
    .command("disable")
    .description("Disable scheduled sync")
    .action(async () => {
      const manager = new ConfigManager(context.resolveConfigPath());

      try {
        manager.set("sync.enabled", "false");
        console.log("Scheduled sync disabled.");
      } catch (err: unknown) {
        console.error(
          `CONFIG_INVALID: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(2);
      }
    });
}

function runGit(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
}

function resolveGitRoot(startPath: string): string | null {
  if (!startPath) return null;
  try {
    return runGit(["rev-parse", "--show-toplevel"], startPath);
  } catch {
    return null;
  }
}

function resolveCurrentBranch(repo: string): string | null {
  try {
    const branch = runGit(["branch", "--show-current"], repo);
    return branch || null;
  } catch {
    return null;
  }
}

function configureRemote(
  repo: string,
  remote: string,
  remoteUrl: string,
  updateRemoteUrl: boolean,
): void {
  let existingUrl: string | null = null;
  try {
    existingUrl = runGit(["remote", "get-url", remote], repo);
  } catch {
    existingUrl = null;
  }

  if (!existingUrl) {
    runGit(["remote", "add", remote, remoteUrl], repo);
    console.log("git remote added");
    return;
  }

  if (existingUrl === remoteUrl) {
    console.log("git remote already configured");
    return;
  }

  if (!updateRemoteUrl) {
    throw new Error(
      "Selected remote already exists with a different URL. Pass --update-remote-url to change it.",
    );
  }

  runGit(["remote", "set-url", remote, remoteUrl], repo);
  console.log("git remote updated");
}

function renderSyncStatus(
  sync: Record<string, unknown>,
  verbose: boolean,
): void {
  console.log("=== Git Sync ===");
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

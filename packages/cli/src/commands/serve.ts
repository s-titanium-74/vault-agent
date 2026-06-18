import { Command } from "commander";
import { loadConfig } from "@vault-agent/core";
import { CliContext } from "../context.js";

export function registerServeCommand(
  program: Command,
  context: CliContext,
): void {
  program
    .command("serve")
    .description("Start the vault-agent server")
    .option("--vault-root <path>", "Vault root path")
    .option("--host <host>", "Bind host")
    .option("--port <port>", "Bind port", parseInt)
    .option("--index-dir <path>", "Index directory")
    .option("--api-key <key>", "API key")
    .option("--mcp-enabled", "Enable MCP Streamable HTTP endpoint")
    .option("--no-mcp-enabled", "Disable MCP Streamable HTTP endpoint")
    .option("--mcp-http-endpoint <path>", "MCP Streamable HTTP endpoint path")
    .action(async (opts) => {
      const config = loadConfig(context.resolveConfigPath());
      if (opts.vaultRoot) config.vault.root = opts.vaultRoot;
      if (opts.host) config.server.host = opts.host;
      if (opts.port) config.server.port = opts.port;
      if (opts.indexDir) config.index.dir = opts.indexDir;
      if (opts.apiKey) config.server.apiKey = opts.apiKey;
      if (opts.mcpEnabled !== undefined) config.mcp.enabled = opts.mcpEnabled;
      if (opts.mcpHttpEndpoint) config.mcp.http.endpoint = opts.mcpHttpEndpoint;

      const { startServer } = await import("@vault-agent/server");
      await startServer(config, { configPath: context.resolveConfigPath() });
    });
}

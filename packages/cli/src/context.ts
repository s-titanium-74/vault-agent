import { Command } from "commander";
import { Config } from "@vault-agent/core";

export interface CliContext {
  resolveEndpoint(config: Config): string;
  resolveApiKey(config: Config, role?: "read" | "admin"): string;
  resolveConfigPath(): string | undefined;
}

export function createCliContext(program: Command): CliContext {
  function getGlobalOpts() {
    return program.opts<{
      config?: string;
      endpoint?: string;
      apiKey?: string;
      json?: boolean;
    }>();
  }

  return {
    resolveEndpoint(config: Config): string {
      const globals = getGlobalOpts();
      return globals.endpoint || config.server.endpoint;
    },

    resolveApiKey(config: Config, role: "read" | "admin" = "read"): string {
      const globals = getGlobalOpts();
      if (globals.apiKey) return globals.apiKey;
      const server = config.server;
      const split = [
        server.readKey,
        server.adminKey,
        server.previousReadKey,
        server.previousAdminKey,
      ].some(Boolean);
      if (split && server.apiKey)
        throw new Error(
          "CONFIG_INVALID: Do not mix role keys with a legacy API key.",
        );
      return split
        ? ((role === "admin" ? server.adminKey : server.readKey) ?? "")
        : server.apiKey;
    },

    resolveConfigPath(): string | undefined {
      const globals = getGlobalOpts();
      return globals.config;
    },
  };
}

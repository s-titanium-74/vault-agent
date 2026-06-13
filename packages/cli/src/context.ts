import { Command } from "commander";
import { Config } from "@vault-agent/core";

export interface CliContext {
  resolveEndpoint(config: Config): string;
  resolveApiKey(config: Config): string;
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

    resolveApiKey(config: Config): string {
      const globals = getGlobalOpts();
      return globals.apiKey || config.server.apiKey;
    },

    resolveConfigPath(): string | undefined {
      const globals = getGlobalOpts();
      return globals.config;
    },
  };
}

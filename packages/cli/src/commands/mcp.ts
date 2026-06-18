import { Command } from "commander";
import {
  FreshnessMachine,
  getIndexPath,
  IndexStore,
  loadConfig,
  DEFAULT_CONFIG,
  EmbeddingProvider,
} from "@vault-agent/core";
import { CliContext } from "../context.js";

export function registerMcpCommand(
  program: Command,
  context: CliContext,
): void {
  program
    .command("mcp")
    .description("Run the vault-agent MCP server over stdio")
    .action(async () => {
      let config: import("@vault-agent/core").Config;
      try {
        config = loadConfig(context.resolveConfigPath());
      } catch {
        console.error(
          "No vault root configured. MCP server will start but return VAULT_NOT_CONFIGURED for tool calls.",
        );
        config = structuredClone(DEFAULT_CONFIG);
      }

      let store: IndexStore | null = null;
      if (config.vault.root) {
        const dbPath = getIndexPath(config);
        try {
          store = await IndexStore.open(dbPath);
        } catch {
          store = null;
        }
      }

      const freshnessMachine = new FreshnessMachine();
      if (!config.vault.root) {
        freshnessMachine.transition("unknown", "No vault root configured");
      } else if (store) {
        const staleness = store.checkStaleness(config);
        if (staleness.incompatible) {
          freshnessMachine.markReindexRequired([staleness.details]);
        } else if (staleness.stale) {
          freshnessMachine.markStale(staleness.details);
        } else {
          freshnessMachine.transition("fresh", "Startup check passed");
        }
      } else {
        freshnessMachine.transition("unknown", "No usable index found");
      }

      const { createMcpServer } =
        await import("@vault-agent/server/mcp/adapter");
      const { runMcpStdio } = await import("@vault-agent/server/mcp/stdio");

      let embeddingProvider: EmbeddingProvider | null = null;
      if (config.embedding.enabled && config.embedding.model) {
        embeddingProvider = new EmbeddingProvider(config);
      }

      const mcpContext = {
        store,
        config,
        embeddingProvider,
        freshnessMachine,
      };
      const mcpServer = createMcpServer(mcpContext);

      try {
        await runMcpStdio(mcpServer);
      } finally {
        await store?.close();
      }
    });
}

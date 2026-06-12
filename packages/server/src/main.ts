import { startServer } from "./index.js";
import { loadConfig } from "@vault-agent/core";

async function main() {
  const config = loadConfig();

  if (!config.vault.root) {
    console.error(
      "CONFIG_INVALID: Vault root is not configured. Set vault.root in config, VAULT_AGENT_VAULT_ROOT env var, or use --vault-root flag.",
    );
    process.exit(2);
  }

  await startServer(config);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

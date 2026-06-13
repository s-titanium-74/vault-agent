import { Command } from "commander";
import { ConfigManager } from "@vault-agent/core";
import { CliContext } from "../context.js";
import { getNestedValue, maskSecrets, printConfig } from "../config-format.js";

export function registerConfigCommands(
  program: Command,
  context: CliContext,
): void {
  const configCmd = program
    .command("config")
    .description("Manage configuration");

  configCmd
    .command("get [key]")
    .description("Get configuration value")
    .option("--json", "Output as JSON")
    .action(async (key, opts) => {
      const manager = new ConfigManager(context.resolveConfigPath());
      const config = manager.load();

      if (key) {
        const isSecret = manager.isSecretKey(key);
        const value = getNestedValue(config, key);

        if (opts.json) {
          if (isSecret) {
            console.log(
              JSON.stringify({
                set:
                  value !== undefined &&
                  value !== null &&
                  String(value).length > 0,
              }),
            );
          } else {
            console.log(JSON.stringify({ [key]: value }));
          }
        } else {
          if (isSecret) {
            console.log(value ? "set" : "unset");
          } else {
            console.log(String(value ?? ""));
          }
        }
      } else {
        if (opts.json) {
          const masked = maskSecrets(config);
          console.log(JSON.stringify(masked, null, 2));
        } else {
          printConfig(config);
        }
      }
    });

  configCmd
    .command("set <dottedKey> <value>")
    .description("Set a configuration value")
    .action(async (dottedKey, value) => {
      const manager = new ConfigManager(context.resolveConfigPath());

      try {
        manager.set(dottedKey, value);
        console.log("set");
      } catch (err: unknown) {
        console.error(
          `CONFIG_INVALID: ${err instanceof Error ? err.message : String(err)}`,
        );
        process.exit(2);
      }
    });

  configCmd
    .command("path")
    .description("Print the configuration file path")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const manager = new ConfigManager(context.resolveConfigPath());

      if (opts.json) {
        console.log(JSON.stringify({ path: manager.getPath() }));
      } else {
        console.log(manager.getPath());
      }
    });

  configCmd
    .command("reveal-api-key")
    .description("Reveal the configured API key")
    .option("--json", "Output as JSON")
    .action(async (opts) => {
      const manager = new ConfigManager(context.resolveConfigPath());
      const config = manager.load();

      if (!config.server.apiKey) {
        console.error("No API key configured.");
        process.exit(1);
        return;
      }

      console.error(
        "Caution: This command reveals a secret value. Use it only for client setup.",
      );
      if (opts.json) {
        console.log(JSON.stringify({ apiKey: config.server.apiKey }));
      } else {
        console.log(config.server.apiKey);
      }
    });
}

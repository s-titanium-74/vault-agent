import { Config } from "@vault-agent/core";

export function getNestedValue(
  obj: Record<string, unknown>,
  dottedKey: string,
): unknown {
  const parts = dottedKey.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return current;
}

export function maskSecrets(config: Config): Record<string, unknown> {
  return {
    vault: config.vault,
    server: {
      ...config.server,
      apiKey: config.server.apiKey ? "***" : "",
    },
    index: config.index,
    embedding: config.embedding,
    cors: config.cors,
  };
}

export function printConfig(config: Config): void {
  console.log("[vault]");
  console.log(`  root = ${config.vault.root || "(not set)"}`);
  console.log(`  exclude = ${config.vault.exclude.join(", ") || "[]"}`);
  console.log();
  console.log("[server]");
  console.log(`  endpoint = ${config.server.endpoint}`);
  console.log(`  host = ${config.server.host}`);
  console.log(`  port = ${config.server.port}`);
  console.log(`  apiKey = ${config.server.apiKey ? "set" : "unset"}`);
  console.log(`  logLevel = ${config.server.logLevel}`);
  console.log();
  console.log("[index]");
  console.log(`  dir = ${config.index.dir || "(default)"}`);
  console.log();
  console.log("[embedding]");
  console.log(`  enabled = ${config.embedding.enabled}`);
  console.log(`  endpoint = ${config.embedding.endpoint}`);
  console.log(`  model = ${config.embedding.model || "(not set)"}`);
  console.log(`  require = ${config.embedding.require}`);
  console.log(
    `  allow_private_network_endpoint = ${config.embedding.allow_private_network_endpoint}`,
  );
  console.log();
  console.log("[cors]");
  console.log(`  enabled = ${config.cors.enabled}`);
  console.log(
    `  allowedOrigins = ${config.cors.allowedOrigins.join(", ") || "[]"}`,
  );
}

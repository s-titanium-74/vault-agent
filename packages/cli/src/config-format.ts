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
    vault: {
      ...config.vault,
      ...(config.vault.pcloud
        ? {
            pcloud: {
              ...config.vault.pcloud,
              access_token: config.vault.pcloud.access_token ? "***" : "",
            },
          }
        : {}),
    },
    server: {
      ...config.server,
      apiKey: config.server.apiKey ? "***" : "",
      readKey: config.server.readKey ? "***" : "",
      readwriteKey: config.server.readwriteKey ? "***" : "",
      previousReadwriteKey: config.server.previousReadwriteKey ? "***" : "",
      adminKey: config.server.adminKey ? "***" : "",
      previousReadKey: config.server.previousReadKey ? "***" : "",
      previousAdminKey: config.server.previousAdminKey ? "***" : "",
    },
    index: config.index,
    embedding: config.embedding,
    cors: config.cors,
    write: config.write,
  };
}

export function printConfig(config: Config): void {
  console.log("[write]");
  for (const [key, value] of Object.entries(config.write))
    console.log(`  ${key} = ${value}`);
  console.log();
  console.log("[vault]");
  console.log(`  root = ${config.vault.root || "(not set)"}`);
  console.log(`  exclude = ${config.vault.exclude.join(", ") || "[]"}`);
  console.log();
  console.log("[server]");
  console.log(`  endpoint = ${config.server.endpoint}`);
  console.log(`  host = ${config.server.host}`);
  console.log(`  port = ${config.server.port}`);
  console.log(`  apiKey = ${config.server.apiKey ? "set" : "unset"}`);
  console.log(
    `  readwriteKey = ${config.server.readwriteKey ? "set" : "unset"}`,
  );
  console.log(
    `  previousReadwriteKey = ${config.server.previousReadwriteKey ? "set" : "unset"}`,
  );
  console.log(`  readKey = ${config.server.readKey ? "set" : "unset"}`);
  console.log(`  adminKey = ${config.server.adminKey ? "set" : "unset"}`);
  console.log(
    `  previousReadKey = ${config.server.previousReadKey ? "set" : "unset"}`,
  );
  console.log(
    `  previousAdminKey = ${config.server.previousAdminKey ? "set" : "unset"}`,
  );
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

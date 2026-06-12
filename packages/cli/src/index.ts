import { Command } from "commander";
import { loadConfig, ConfigManager, Config } from "@vault-agent/core";

const INDEXING_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 60 * 1000;

function exitCodeFromStatus(status: number): number {
  if (status === 401 || status === 403) return 3;
  if (status === 404) return 4;
  if (status >= 400 && status < 500) return 2;
  if (status >= 500) return 1;
  return 1;
}

export const program = new Command();

program
  .name("vault-agent")
  .version("0.1.0")
  .option("--config <path>", "Path to config file")
  .option("--endpoint <url>", "Server endpoint URL")
  .option("--api-key <key>", "API key for authentication")
  .option("--json", "Output as JSON");

function getGlobalOpts() {
  return program.opts<{
    config?: string;
    endpoint?: string;
    apiKey?: string;
    json?: boolean;
  }>();
}

function resolveEndpoint(config: Config): string {
  const globals = getGlobalOpts();
  return globals.endpoint || config.server.endpoint;
}

function resolveApiKey(config: Config): string {
  const globals = getGlobalOpts();
  return globals.apiKey || config.server.apiKey;
}

function resolveConfigPath(): string | undefined {
  const globals = getGlobalOpts();
  return globals.config;
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function formatError(response: Response, data: unknown): string {
  return getCommandResultFromHttpResponse(response.status, data).message;
}

export interface CommandHttpResult {
  ok: boolean;
  exitCode: number;
  message: string;
}

export function getCommandResultFromHttpResponse(
  status: number,
  data: unknown,
): CommandHttpResult {
  if (status < 400) {
    return { ok: true, exitCode: 0, message: "" };
  }

  if (data && typeof data === "object") {
    const obj = data as Record<string, unknown>;
    const error =
      obj.error && typeof obj.error === "object"
        ? (obj.error as Record<string, unknown>)
        : obj;
    const code =
      typeof error.code === "string" ? error.code : `HTTP_${status}`;
    const message =
      typeof error.message === "string" ? error.message : "Request failed";
    return {
      ok: false,
      exitCode: exitCodeFromStatus(status),
      message: `${code}: ${message}`,
    };
  }
  return {
    ok: false,
    exitCode: exitCodeFromStatus(status),
    message: `HTTP_${status}: Request failed`,
  };
}

function headersWithAuth(apiKey: string | undefined): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

function buildAttachmentUrl(
  endpoint: string,
  encodedPath: string,
  params: Record<string, string>,
): string {
  const url = new URL(`/attachments/${encodedPath}`, endpoint);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

program
  .command("serve")
  .description("Start the vault-agent server")
  .option("--vault-root <path>", "Vault root path")
  .option("--host <host>", "Bind host")
  .option("--port <port>", "Bind port", parseInt)
  .option("--index-dir <path>", "Index directory")
  .option("--api-key <key>", "API key")
  .action(async (opts) => {
    const config = loadConfig(resolveConfigPath());
    if (opts.vaultRoot) config.vault.root = opts.vaultRoot;
    if (opts.host) config.server.host = opts.host;
    if (opts.port) config.server.port = opts.port;
    if (opts.indexDir) config.index.dir = opts.indexDir;
    if (opts.apiKey) config.server.apiKey = opts.apiKey;

    const { startServer } = await import("@vault-agent/server");
    await startServer(config, { configPath: resolveConfigPath() });
  });

program
  .command("index")
  .description("Perform incremental indexing")
  .option("--require-embeddings", "Fail if embedding generation fails")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const config = loadConfig(resolveConfigPath());
    const endpoint = resolveEndpoint(config);
    const apiKey = resolveApiKey(config);

    try {
      const response = await fetchWithTimeout(
        `${endpoint}/index`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headersWithAuth(apiKey),
          },
          body: JSON.stringify({
            requireEmbeddings: opts.requireEmbeddings || false,
          }),
        },
        INDEXING_TIMEOUT_MS,
      );

      const data = await response.json();
      const commandResult = getCommandResultFromHttpResponse(
        response.status,
        data,
      );
      if (!commandResult.ok) {
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.error(commandResult.message);
        }
        process.exit(commandResult.exitCode);
      }

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        const result = data.data ?? data;
        console.log(`Indexing mode: ${result.mode}`);
        console.log(`Notes indexed: ${result.notesIndexed}`);
        console.log(`Chunks indexed: ${result.chunksIndexed}`);
        console.log(`Notes skipped: ${result.notesSkipped}`);
        if (result.warningCount > 0) {
          console.log(`Warnings: ${result.warningCount}`);
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        console.error(`TIMEOUT: Request to ${endpoint}/index timed out.`);
      } else {
        console.error(
          `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
        );
      }
      process.exit(1);
    }
  });

program
  .command("reindex")
  .description("Perform full reindexing")
  .option("--require-embeddings", "Fail if embedding generation fails")
  .option("--json", "Output as JSON")
  .action(async (opts) => {
    const config = loadConfig(resolveConfigPath());
    const endpoint = resolveEndpoint(config);
    const apiKey = resolveApiKey(config);

    try {
      const response = await fetchWithTimeout(
        `${endpoint}/reindex`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headersWithAuth(apiKey),
          },
          body: JSON.stringify({
            requireEmbeddings: opts.requireEmbeddings || false,
          }),
        },
        INDEXING_TIMEOUT_MS,
      );

      const data = await response.json();
      const commandResult = getCommandResultFromHttpResponse(
        response.status,
        data,
      );
      if (!commandResult.ok) {
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.error(commandResult.message);
        }
        process.exit(commandResult.exitCode);
      }

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        const result = data.data ?? data;
        console.log(`Indexing mode: ${result.mode}`);
        console.log(`Notes indexed: ${result.notesIndexed}`);
        console.log(`Chunks indexed: ${result.chunksIndexed}`);
        console.log(`Notes skipped: ${result.notesSkipped}`);
        if (result.warningCount > 0) {
          console.log(`Warnings: ${result.warningCount}`);
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        console.error(`TIMEOUT: Request to ${endpoint}/reindex timed out.`);
      } else {
        console.error(
          `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
        );
      }
      process.exit(1);
    }
  });

program
  .command("search <query...>")
  .description("Search vault notes")
  .option("--mode <mode>", "Search mode: lexical, embedding, hybrid")
  .option("--limit <n>", "Result limit", parseInt)
  .option("--json", "Output as JSON")
  .action(async (queryParts, opts) => {
    const config = loadConfig(resolveConfigPath());
    const endpoint = resolveEndpoint(config);
    const apiKey = resolveApiKey(config);
    const query = queryParts.join(" ");

    try {
      const response = await fetchWithTimeout(
        `${endpoint}/search`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headersWithAuth(apiKey),
          },
          body: JSON.stringify({
            query,
            mode: opts.mode,
            limit: opts.limit,
          }),
        },
        DEFAULT_TIMEOUT_MS,
      );

      const data = await response.json();

      if (response.status >= 400) {
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.error(formatError(response, data));
        }
        process.exit(exitCodeFromStatus(response.status));
      }

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        const result = data.data ?? data;
        console.log(`Mode: ${result.requestedMode} -> ${result.usedMode}`);
        console.log(`Results (${result.results.length}/${result.limit}):`);
        for (const r of result.results) {
          console.log(
            `  ${r.path} #${r.heading ?? "(untitled)"} [${r.reason}] score=${r.score.toFixed(3)}`,
          );
          if (r.snippet) {
            console.log(`    ${r.snippet}`);
          }
        }
        if (data.warnings?.length) {
          for (const w of data.warnings) {
            console.warn(`Warning: ${w.code}: ${w.message}`);
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        console.error(`TIMEOUT: Request to ${endpoint}/search timed out.`);
      } else {
        console.error(
          `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
        );
      }
      process.exit(1);
    }
  });

program
  .command("related <id>")
  .description("Find related notes from a note or chunk ID")
  .option("--type <type>", "Input type: note or chunk")
  .option("--mode <mode>", "Search mode: lexical, embedding, hybrid")
  .option("--limit <n>", "Result limit", parseInt)
  .option("--json", "Output as JSON")
  .action(async (id, opts) => {
    const config = loadConfig(resolveConfigPath());
    const endpoint = resolveEndpoint(config);
    const apiKey = resolveApiKey(config);

    let type: "note" | "chunk";
    if (opts.type) {
      type = opts.type as "note" | "chunk";
    } else if (id.includes(":")) {
      type = "chunk";
    } else if (/^[0-9a-f]{32}$/.test(id)) {
      type = "note";
    } else {
      console.error(
        "INVALID_ID: Cannot determine type. Use --type note or --type chunk.",
      );
      process.exit(2);
      return;
    }

    try {
      const response = await fetchWithTimeout(
        `${endpoint}/related`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...headersWithAuth(apiKey),
          },
          body: JSON.stringify({
            type,
            id,
            mode: opts.mode,
            limit: opts.limit,
          }),
        },
        DEFAULT_TIMEOUT_MS,
      );

      const data = await response.json();

      if (response.status >= 400) {
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.error(formatError(response, data));
        }
        process.exit(exitCodeFromStatus(response.status));
      }

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        const result = data.data ?? data;
        console.log(`Input: ${result.input.type} ${result.input.id}`);
        console.log(`Mode: ${result.requestedMode} -> ${result.usedMode}`);
        console.log(`Results (${result.results.length}/${result.limit}):`);
        for (const r of result.results) {
          console.log(
            `  ${r.path} #${r.heading ?? "(untitled)"} [${r.reason}] score=${r.score.toFixed(3)}`,
          );
          if (r.snippet) {
            console.log(`    ${r.snippet}`);
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        console.error(`TIMEOUT: Request to ${endpoint}/related timed out.`);
      } else {
        console.error(
          `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
        );
      }
      process.exit(1);
    }
  });

const getCmd = program.command("get").description("Retrieve vault content");

getCmd
  .command("note <noteId>")
  .description("Retrieve a note by ID")
  .option("--allow-large", "Allow retrieval of large notes")
  .option("--json", "Output as JSON")
  .action(async (noteId, opts) => {
    const config = loadConfig(resolveConfigPath());
    const endpoint = resolveEndpoint(config);
    const apiKey = resolveApiKey(config);

    const params = new URLSearchParams();
    if (opts.allowLarge) params.set("allowLarge", "true");
    const qs = params.toString();
    const url = `${endpoint}/notes/${noteId}${qs ? `?${qs}` : ""}`;

    try {
      const response = await fetchWithTimeout(
        url,
        { headers: headersWithAuth(apiKey) },
        DEFAULT_TIMEOUT_MS,
      );

      const data = await response.json();

      if (response.status >= 400) {
        process.exit(exitCodeFromStatus(response.status));
      }

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        const result = data.data ?? data;
        console.error(`Path: ${result.path}`);
        console.error(`Title: ${result.title ?? "(untitled)"}`);
        console.error(`Size: ${result.size} bytes`);
        console.log(result.content);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        console.error(`TIMEOUT: Request timed out.`);
      } else {
        console.error(
          `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
        );
      }
      process.exit(1);
    }
  });

getCmd
  .command("chunk <noteId> [chunkIndex]")
  .description("Retrieve a chunk by note ID and chunk index")
  .option("--json", "Output as JSON")
  .action(async (noteId, chunkIndex, opts) => {
    const config = loadConfig(resolveConfigPath());
    const endpoint = resolveEndpoint(config);
    const apiKey = resolveApiKey(config);

    let url: string;
    if (chunkIndex !== undefined) {
      url = `${endpoint}/chunks/${noteId}/${chunkIndex}`;
    } else if (noteId.includes(":")) {
      const parts = noteId.split(":");
      url = `${endpoint}/chunks/${parts[0]}/${parts[1]}`;
    } else {
      console.error(
        "INVALID_ID: Provide note ID and chunk index, or a chunk ID in noteId:chunkIndex format.",
      );
      process.exit(2);
      return;
    }

    try {
      const response = await fetchWithTimeout(
        url,
        { headers: headersWithAuth(apiKey) },
        DEFAULT_TIMEOUT_MS,
      );

      const data = await response.json();

      if (response.status >= 400) {
        process.exit(exitCodeFromStatus(response.status));
      }

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        const result = data.data ?? data;
        console.error(`Path: ${result.path}`);
        console.error(`Heading: ${result.heading ?? "(untitled)"}`);
        console.error(`Size: ${result.size} bytes`);
        console.log(result.content);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        console.error(`TIMEOUT: Request timed out.`);
      } else {
        console.error(
          `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
        );
      }
      process.exit(1);
    }
  });

getCmd
  .command("attachment <vaultRelativePath>")
  .description("Retrieve attachment metadata or download")
  .option("--download", "Download attachment bytes")
  .option("--output <path>", "Output file path (required with --download)")
  .option("--allow-large", "Allow large attachment downloads")
  .option("--json", "Output as JSON")
  .action(async (vaultRelativePath, opts) => {
    const config = loadConfig(resolveConfigPath());
    const endpoint = resolveEndpoint(config);
    const apiKey = resolveApiKey(config);

    if (opts.download && !opts.output) {
      console.error(
        "INVALID_REQUEST: --download requires --output <path> or --output -",
      );
      process.exit(2);
      return;
    }

    const params: Record<string, string> = {};
    if (opts.download) params.download = "true";
    if (opts.allowLarge) params.allowLarge = "true";

    const encodedPath = encodeURIComponent(vaultRelativePath);
    const url = buildAttachmentUrl(endpoint, encodedPath, params);

    try {
      const response = await fetchWithTimeout(
        url,
        {
          headers: {
            ...headersWithAuth(apiKey),
            ...(opts.download ? { Accept: "application/octet-stream" } : {}),
          },
        },
        opts.download ? DEFAULT_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
      );

      if (opts.download && response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());

        if (opts.output === "-") {
          process.stdout.write(buffer);
        } else {
          const fs = await import("node:fs");
          fs.writeFileSync(opts.output, buffer);
          if (!opts.json) {
            console.log(`Saved to ${opts.output}`);
          } else {
            console.log(
              JSON.stringify({ saved: opts.output, size: buffer.length }),
            );
          }
        }
        return;
      }

      const data = await response.json();

      if (response.status >= 400) {
        if (opts.json) {
          console.log(JSON.stringify(data, null, 2));
        } else {
          console.error(formatError(response, data));
        }
        process.exit(exitCodeFromStatus(response.status));
      }

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
      } else {
        const result = data.data ?? data;
        console.log(`Path: ${result.path}`);
        console.log(`Type: ${result.contentType}`);
        console.log(`Size: ${result.size} bytes`);
        console.log(`Download available: ${result.downloadAvailable}`);
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        console.error(`TIMEOUT: Request timed out.`);
      } else {
        console.error(
          `SERVER_UNAVAILABLE: Cannot reach server at ${endpoint}. Start vault-agent serve or update endpoint.`,
        );
      }
      process.exit(1);
    }
  });

const configCmd = program.command("config").description("Manage configuration");

configCmd
  .command("get [key]")
  .description("Get configuration value")
  .option("--json", "Output as JSON")
  .action(async (key, opts) => {
    const manager = new ConfigManager(resolveConfigPath());
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
    const manager = new ConfigManager(resolveConfigPath());

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
    const manager = new ConfigManager(resolveConfigPath());

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
    const manager = new ConfigManager(resolveConfigPath());
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

export { program as default };

function getNestedValue(
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

function maskSecrets(config: Config): Record<string, unknown> {
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

function printConfig(config: Config): void {
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
  console.log();
  console.log("[cors]");
  console.log(`  enabled = ${config.cors.enabled}`);
  console.log(
    `  allowedOrigins = ${config.cors.allowedOrigins.join(", ") || "[]"}`,
  );
}

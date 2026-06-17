import { z } from "zod";
import TOML from "smol-toml";

export const vaultConfigSchema = z.object({
  root: z.string().min(1, "Vault root path is required"),
  exclude: z.array(z.string()).default([]),
});

export const serverConfigSchema = z.object({
  endpoint: z.string().url().default("http://127.0.0.1:8787"),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8787),
  apiKey: z.string().default(""),
  logLevel: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const indexConfigSchema = z.object({
  dir: z.string().default(""),
});

export const embeddingConfigSchema = z.object({
  enabled: z.boolean().default(false),
  endpoint: z.string().default("http://127.0.0.1:11434/v1/embeddings"),
  model: z.string().default(""),
  require: z.boolean().default(false),
});

export const corsConfigSchema = z.object({
  enabled: z.boolean().default(false),
  allowedOrigins: z.array(z.string()).default([]),
});

export const watchConfigSchema = z.object({
  enabled: z.boolean().default(true),
  debounce_ms: z.number().int().min(1).default(10000),
  max_batch_delay_ms: z.number().int().min(1).default(60000),
  ignore_initial: z.boolean().default(true),
});

export const syncConfigSchema = z.object({
  enabled: z.boolean().default(false),
  repo: z.string().default(""),
  remote: z.string().default("origin"),
  branch: z.string().default(""),
  interval_seconds: z.number().int().min(60).default(900),
  webhook_enabled: z.boolean().default(false),
  webhook_secret: z.string().default(""),
  pull_timeout_seconds: z.number().int().min(1).default(120),
  failure_backoff_seconds: z.number().int().min(1).default(3600),
});

export const configSchema = z
  .object({
    vault: vaultConfigSchema,
    server: serverConfigSchema,
    index: indexConfigSchema,
    embedding: embeddingConfigSchema,
    cors: corsConfigSchema,
    watch: watchConfigSchema,
    sync: syncConfigSchema,
  })
  .superRefine((config, ctx) => {
    if (config.watch.max_batch_delay_ms < config.watch.debounce_ms) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["watch", "max_batch_delay_ms"],
        message: `max_batch_delay_ms (${config.watch.max_batch_delay_ms}) must be >= debounce_ms (${config.watch.debounce_ms})`,
      });
    }
    if (config.sync.failure_backoff_seconds < config.sync.interval_seconds) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sync", "failure_backoff_seconds"],
        message: `failure_backoff_seconds (${config.sync.failure_backoff_seconds}) must be >= interval_seconds (${config.sync.interval_seconds})`,
      });
    }
  });

export type VaultConfig = z.infer<typeof vaultConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type IndexConfig = z.infer<typeof indexConfigSchema>;
export type EmbeddingConfig = z.infer<typeof embeddingConfigSchema>;
export type CorsConfig = z.infer<typeof corsConfigSchema>;
export type WatchConfig = z.infer<typeof watchConfigSchema>;
export type SyncConfig = z.infer<typeof syncConfigSchema>;
export type Config = z.infer<typeof configSchema>;

export const DEFAULT_CONFIG: Config = {
  vault: {
    root: "",
    exclude: [],
  },
  server: {
    endpoint: "http://127.0.0.1:8787",
    host: "127.0.0.1",
    port: 8787,
    apiKey: "",
    logLevel: "info",
  },
  index: {
    dir: "",
  },
  embedding: {
    enabled: false,
    endpoint: "http://127.0.0.1:11434/v1/embeddings",
    model: "",
    require: false,
  },
  cors: {
    enabled: false,
    allowedOrigins: [],
  },
  watch: {
    enabled: true,
    debounce_ms: 10000,
    max_batch_delay_ms: 60000,
    ignore_initial: true,
  },
  sync: {
    enabled: false,
    repo: "",
    remote: "origin",
    branch: "",
    interval_seconds: 900,
    webhook_enabled: false,
    webhook_secret: "",
    pull_timeout_seconds: 120,
    failure_backoff_seconds: 3600,
  },
};

const SECRET_KEYS = new Set(["server.apiKey", "sync.webhook_secret"]);

function applyEnvOverrides(config: Config): Config {
  const envMapping: Record<
    string,
    { path: string[]; type: "string" | "boolean" | "number" | "stringArray" }
  > = {
    VAULT_AGENT_VAULT_ROOT: { path: ["vault", "root"], type: "string" },
    VAULT_AGENT_SERVER_ENDPOINT: {
      path: ["server", "endpoint"],
      type: "string",
    },
    VAULT_AGENT_SERVER_HOST: { path: ["server", "host"], type: "string" },
    VAULT_AGENT_SERVER_PORT: { path: ["server", "port"], type: "number" },
    VAULT_AGENT_API_KEY: { path: ["server", "apiKey"], type: "string" },
    VAULT_AGENT_LOG_LEVEL: { path: ["server", "logLevel"], type: "string" },
    VAULT_AGENT_INDEX_DIR: { path: ["index", "dir"], type: "string" },
    VAULT_AGENT_EMBEDDING_ENABLED: {
      path: ["embedding", "enabled"],
      type: "boolean",
    },
    VAULT_AGENT_EMBEDDING_ENDPOINT: {
      path: ["embedding", "endpoint"],
      type: "string",
    },
    VAULT_AGENT_EMBEDDING_MODEL: {
      path: ["embedding", "model"],
      type: "string",
    },
    VAULT_AGENT_EMBEDDING_REQUIRE: {
      path: ["embedding", "require"],
      type: "boolean",
    },
    VAULT_AGENT_CORS_ENABLED: { path: ["cors", "enabled"], type: "boolean" },
    VAULT_AGENT_CORS_ALLOWED_ORIGINS: {
      path: ["cors", "allowedOrigins"],
      type: "stringArray",
    },
    VAULT_AGENT_WATCH_ENABLED: { path: ["watch", "enabled"], type: "boolean" },
    VAULT_AGENT_WATCH_DEBOUNCE_MS: {
      path: ["watch", "debounce_ms"],
      type: "number",
    },
    VAULT_AGENT_WATCH_MAX_BATCH_DELAY_MS: {
      path: ["watch", "max_batch_delay_ms"],
      type: "number",
    },
    VAULT_AGENT_WATCH_IGNORE_INITIAL: {
      path: ["watch", "ignore_initial"],
      type: "boolean",
    },
    VAULT_AGENT_SYNC_ENABLED: { path: ["sync", "enabled"], type: "boolean" },
    VAULT_AGENT_SYNC_REPO: { path: ["sync", "repo"], type: "string" },
    VAULT_AGENT_SYNC_REMOTE: { path: ["sync", "remote"], type: "string" },
    VAULT_AGENT_SYNC_BRANCH: { path: ["sync", "branch"], type: "string" },
    VAULT_AGENT_SYNC_INTERVAL_SECONDS: {
      path: ["sync", "interval_seconds"],
      type: "number",
    },
    VAULT_AGENT_SYNC_WEBHOOK_ENABLED: {
      path: ["sync", "webhook_enabled"],
      type: "boolean",
    },
    VAULT_AGENT_SYNC_WEBHOOK_SECRET: {
      path: ["sync", "webhook_secret"],
      type: "string",
    },
    VAULT_AGENT_SYNC_PULL_TIMEOUT_SECONDS: {
      path: ["sync", "pull_timeout_seconds"],
      type: "number",
    },
    VAULT_AGENT_SYNC_FAILURE_BACKOFF_SECONDS: {
      path: ["sync", "failure_backoff_seconds"],
      type: "number",
    },
  };

  const result = structuredClone(config) as Record<string, unknown>;

  for (const [envVar, mapping] of Object.entries(envMapping)) {
    const value = process.env[envVar];
    if (value === undefined || value === "") continue;

    let parsed: unknown;
    if (mapping.type === "boolean") {
      if (value === "true" || value === "1") {
        parsed = true;
      } else if (value === "false" || value === "0") {
        parsed = false;
      } else {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Invalid boolean value for ${envVar}: ${value}`,
        );
      }
    } else if (mapping.type === "number") {
      parsed = parseInt(value, 10);
      if (isNaN(parsed as number)) {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Invalid number value for ${envVar}: ${value}`,
        );
      }
    } else if (mapping.type === "stringArray") {
      parsed = value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    } else {
      parsed = value;
    }

    const section = mapping.path[0]!;
    const key = mapping.path[1]!;
    const sectionObj = result[section] as Record<string, unknown>;
    sectionObj[key] = parsed;
  }

  return configSchema.parse(result);
}

const KNOWN_SECTIONS: Record<string, Set<string>> = {
  vault: new Set(["root", "exclude"]),
  server: new Set([
    "endpoint",
    "host",
    "port",
    "apiKey",
    "api_key",
    "logLevel",
    "log_level",
  ]),
  index: new Set(["dir"]),
  embedding: new Set(["enabled", "endpoint", "model", "require"]),
  cors: new Set(["enabled", "allowedOrigins", "allowed_origins"]),
  watch: new Set([
    "enabled",
    "debounce_ms",
    "max_batch_delay_ms",
    "ignore_initial",
  ]),
  sync: new Set([
    "enabled",
    "repo",
    "remote",
    "branch",
    "interval_seconds",
    "webhook_enabled",
    "webhook_secret",
    "pull_timeout_seconds",
    "failure_backoff_seconds",
  ]),
};

function validateConfigKeys(parsed: Record<string, unknown>): void {
  for (const [section, value] of Object.entries(parsed)) {
    if (typeof value !== "object" || value === null) {
      throw new ConfigError(
        "CONFIG_INVALID",
        `Invalid configuration: section [${section}] must be a table`,
      );
    }
    const known = KNOWN_SECTIONS[section];
    if (!known) {
      throw new ConfigError(
        "CONFIG_INVALID",
        `Unknown configuration section: [${section}]`,
      );
    }
    for (const key of Object.keys(value as Record<string, unknown>)) {
      if (!known.has(key)) {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Unknown configuration key: ${section}.${key}`,
        );
      }
    }
  }
}

function toTOMLObject(config: Config): Record<string, unknown> {
  return {
    vault: { root: config.vault.root, exclude: config.vault.exclude },
    server: {
      endpoint: config.server.endpoint,
      host: config.server.host,
      port: config.server.port,
      api_key: config.server.apiKey,
      log_level: config.server.logLevel,
    },
    index: { dir: config.index.dir },
    embedding: {
      enabled: config.embedding.enabled,
      endpoint: config.embedding.endpoint,
      model: config.embedding.model,
      require: config.embedding.require,
    },
    cors: {
      enabled: config.cors.enabled,
      allowed_origins: config.cors.allowedOrigins,
    },
    watch: {
      enabled: config.watch.enabled,
      debounce_ms: config.watch.debounce_ms,
      max_batch_delay_ms: config.watch.max_batch_delay_ms,
      ignore_initial: config.watch.ignore_initial,
    },
    sync: {
      enabled: config.sync.enabled,
      repo: config.sync.repo,
      remote: config.sync.remote,
      branch: config.sync.branch,
      interval_seconds: config.sync.interval_seconds,
      webhook_enabled: config.sync.webhook_enabled,
      webhook_secret: config.sync.webhook_secret,
      pull_timeout_seconds: config.sync.pull_timeout_seconds,
      failure_backoff_seconds: config.sync.failure_backoff_seconds,
    },
  };
}

function serializeTOML(config: Config): string {
  return TOML.stringify(toTOMLObject(config));
}

import fs from "node:fs";
import path from "node:path";
import { defaultConfigPath } from "./paths.js";
import { ConfigError } from "./errors.js";

export class ConfigManager {
  private configPath: string;

  constructor(configPath?: string) {
    this.configPath = configPath ?? defaultConfigPath();
  }

  getPath(): string {
    return this.configPath;
  }

  load(): Config {
    let fileConfig: Partial<Config> = {} as Partial<Config>;

    if (fs.existsSync(this.configPath)) {
      const content = fs.readFileSync(this.configPath, "utf-8");
      const parsed = TOML.parse(content) as Record<string, unknown>;
      validateConfigKeys(parsed);
      fileConfig = configFromTOMLParsed(parsed);
    }

    const merged = mergeWithDefaults(fileConfig);
    const withEnv = applyEnvOverrides(merged);
    return configSchema.parse(withEnv);
  }

  set(dottedKey: string, value: unknown): void {
    const dir = path.dirname(this.configPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    let config: Config;
    if (fs.existsSync(this.configPath)) {
      const content = fs.readFileSync(this.configPath, "utf-8");
      const parsed = TOML.parse(content) as Record<string, unknown>;
      validateConfigKeys(parsed);
      const fileConfig = configFromTOMLParsed(parsed);
      config = mergeWithDefaults(fileConfig);
    } else {
      config = structuredClone(DEFAULT_CONFIG);
    }

    setDottedKey(config, dottedKey, value);

    const serialized = serializeTOML(config);
    fs.writeFileSync(this.configPath, serialized, "utf-8");
  }

  isSecretKey(dottedKey: string): boolean {
    return SECRET_KEYS.has(dottedKey);
  }

  formatValue(
    dottedKey: string,
    value: unknown,
  ): { set: boolean; value?: string } {
    if (this.isSecretKey(dottedKey)) {
      return {
        set: value !== undefined && value !== null && String(value).length > 0,
      };
    }
    return { set: true, value: String(value) };
  }
}

function configFromTOMLParsed(
  parsed: Record<string, unknown>,
): Partial<Config> {
  const result: Partial<Config> = {};

  if (parsed.vault && typeof parsed.vault === "object") {
    const v = parsed.vault as Record<string, unknown>;
    result.vault = {
      root: (v.root as string) ?? DEFAULT_CONFIG.vault.root,
      exclude: (v.exclude as string[]) ?? DEFAULT_CONFIG.vault.exclude,
    };
  }

  if (parsed.server && typeof parsed.server === "object") {
    const s = parsed.server as Record<string, unknown>;
    result.server = {
      endpoint: (s.endpoint as string) ?? DEFAULT_CONFIG.server.endpoint,
      host: (s.host as string) ?? DEFAULT_CONFIG.server.host,
      port: (s.port as number) ?? DEFAULT_CONFIG.server.port,
      apiKey:
        (s.api_key as string) ??
        (s.apiKey as string) ??
        DEFAULT_CONFIG.server.apiKey,
      logLevel: (s.log_level ??
        s.logLevel ??
        DEFAULT_CONFIG.server.logLevel) as ServerConfig["logLevel"],
    };
  }

  if (parsed.index && typeof parsed.index === "object") {
    const i = parsed.index as Record<string, unknown>;
    result.index = {
      dir: (i.dir as string) ?? DEFAULT_CONFIG.index.dir,
    };
  }

  if (parsed.embedding && typeof parsed.embedding === "object") {
    const e = parsed.embedding as Record<string, unknown>;
    result.embedding = {
      enabled: (e.enabled as boolean) ?? DEFAULT_CONFIG.embedding.enabled,
      endpoint: (e.endpoint as string) ?? DEFAULT_CONFIG.embedding.endpoint,
      model: (e.model as string) ?? DEFAULT_CONFIG.embedding.model,
      require: (e.require as boolean) ?? DEFAULT_CONFIG.embedding.require,
    };
  }

  if (parsed.cors && typeof parsed.cors === "object") {
    const c = parsed.cors as Record<string, unknown>;
    result.cors = {
      enabled: (c.enabled as boolean) ?? DEFAULT_CONFIG.cors.enabled,
      allowedOrigins:
        (c.allowed_origins as string[]) ??
        (c.allowedOrigins as string[]) ??
        DEFAULT_CONFIG.cors.allowedOrigins,
    };
  }

  if (parsed.watch && typeof parsed.watch === "object") {
    const w = parsed.watch as Record<string, unknown>;
    result.watch = {
      enabled: (w.enabled as boolean) ?? DEFAULT_CONFIG.watch.enabled,
      debounce_ms:
        (w.debounce_ms as number) ?? DEFAULT_CONFIG.watch.debounce_ms,
      max_batch_delay_ms:
        (w.max_batch_delay_ms as number) ??
        DEFAULT_CONFIG.watch.max_batch_delay_ms,
      ignore_initial:
        (w.ignore_initial as boolean) ?? DEFAULT_CONFIG.watch.ignore_initial,
    };
  }

  if (parsed.sync && typeof parsed.sync === "object") {
    const s = parsed.sync as Record<string, unknown>;
    result.sync = {
      enabled: (s.enabled as boolean) ?? DEFAULT_CONFIG.sync.enabled,
      repo: (s.repo as string) ?? DEFAULT_CONFIG.sync.repo,
      remote: (s.remote as string) ?? DEFAULT_CONFIG.sync.remote,
      branch: (s.branch as string) ?? DEFAULT_CONFIG.sync.branch,
      interval_seconds:
        (s.interval_seconds as number) ?? DEFAULT_CONFIG.sync.interval_seconds,
      webhook_enabled:
        (s.webhook_enabled as boolean) ?? DEFAULT_CONFIG.sync.webhook_enabled,
      webhook_secret:
        (s.webhook_secret as string) ?? DEFAULT_CONFIG.sync.webhook_secret,
      pull_timeout_seconds:
        (s.pull_timeout_seconds as number) ??
        DEFAULT_CONFIG.sync.pull_timeout_seconds,
      failure_backoff_seconds:
        (s.failure_backoff_seconds as number) ??
        DEFAULT_CONFIG.sync.failure_backoff_seconds,
    };
  }

  return result;
}

function mergeWithDefaults(partial: Partial<Config>): Config {
  return {
    vault: { ...DEFAULT_CONFIG.vault, ...partial.vault },
    server: { ...DEFAULT_CONFIG.server, ...partial.server },
    index: { ...DEFAULT_CONFIG.index, ...partial.index },
    embedding: { ...DEFAULT_CONFIG.embedding, ...partial.embedding },
    cors: { ...DEFAULT_CONFIG.cors, ...partial.cors },
    watch: { ...DEFAULT_CONFIG.watch, ...partial.watch },
    sync: { ...DEFAULT_CONFIG.sync, ...partial.sync },
  };
}

function setDottedKey(config: Config, dottedKey: string, value: unknown): void {
  const keyMapping: Record<string, [string, string]> = {
    "vault.root": ["vault", "root"],
    "vault.exclude": ["vault", "exclude"],
    "server.endpoint": ["server", "endpoint"],
    "server.host": ["server", "host"],
    "server.port": ["server", "port"],
    "server.apiKey": ["server", "apiKey"],
    "server.logLevel": ["server", "logLevel"],
    "index.dir": ["index", "dir"],
    "embedding.enabled": ["embedding", "enabled"],
    "embedding.endpoint": ["embedding", "endpoint"],
    "embedding.model": ["embedding", "model"],
    "embedding.require": ["embedding", "require"],
    "cors.enabled": ["cors", "enabled"],
    "cors.allowedOrigins": ["cors", "allowedOrigins"],
    "watch.enabled": ["watch", "enabled"],
    "watch.debounce_ms": ["watch", "debounce_ms"],
    "watch.max_batch_delay_ms": ["watch", "max_batch_delay_ms"],
    "watch.ignore_initial": ["watch", "ignore_initial"],
    "sync.enabled": ["sync", "enabled"],
    "sync.repo": ["sync", "repo"],
    "sync.remote": ["sync", "remote"],
    "sync.branch": ["sync", "branch"],
    "sync.interval_seconds": ["sync", "interval_seconds"],
    "sync.webhook_enabled": ["sync", "webhook_enabled"],
    "sync.webhook_secret": ["sync", "webhook_secret"],
    "sync.pull_timeout_seconds": ["sync", "pull_timeout_seconds"],
    "sync.failure_backoff_seconds": ["sync", "failure_backoff_seconds"],
  };

  const mapped = keyMapping[dottedKey];
  if (!mapped) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Unknown configuration key: ${dottedKey}`,
    );
  }

  const [section, key] = mapped;
  const sectionObj = config[section as keyof Config] as Record<string, unknown>;

  if (key === "port") {
    const num = typeof value === "string" ? parseInt(value, 10) : Number(value);
    if (isNaN(num) || num < 1 || num > 65535) {
      throw new ConfigError("CONFIG_INVALID", `Invalid port value: ${value}`);
    }
    sectionObj[key] = num;
  } else if (
    key === "enabled" ||
    key === "require" ||
    key === "ignore_initial" ||
    key === "webhook_enabled"
  ) {
    if (typeof value === "string") {
      if (value === "true" || value === "1") {
        sectionObj[key] = true;
      } else if (value === "false" || value === "0") {
        sectionObj[key] = false;
      } else {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Invalid boolean value: ${value}`,
        );
      }
    } else {
      sectionObj[key] = Boolean(value);
    }
  } else if (
    key === "port" ||
    key === "debounce_ms" ||
    key === "max_batch_delay_ms" ||
    key === "interval_seconds" ||
    key === "pull_timeout_seconds" ||
    key === "failure_backoff_seconds"
  ) {
    const num = typeof value === "string" ? parseInt(value, 10) : Number(value);
    if (isNaN(num) || num < 1) {
      throw new ConfigError("CONFIG_INVALID", `Invalid number value: ${value}`);
    }
    sectionObj[key] = num;
  } else if (key === "exclude" || key === "allowedOrigins") {
    if (typeof value === "string") {
      sectionObj[key] = value
        .split(",")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
    } else if (Array.isArray(value)) {
      sectionObj[key] = value;
    } else {
      throw new ConfigError("CONFIG_INVALID", `Invalid value for ${dottedKey}`);
    }
  } else {
    sectionObj[key] = String(value);
  }
}

export function loadConfig(configPath?: string): Config {
  const manager = new ConfigManager(configPath);
  return manager.load();
}

export function resolveConfig(
  configPath?: string,
  cliOverrides?: Partial<Config>,
): Config {
  const manager = new ConfigManager(configPath);
  let config = manager.load();

  if (cliOverrides) {
    config = mergeWithDefaults({ ...config, ...cliOverrides });
  }

  return configSchema.parse(config);
}

export { applyEnvOverrides, setDottedKey };

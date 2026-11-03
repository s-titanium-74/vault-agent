import {
  validRoleCredentials,
  type AccessCredentials,
} from "@vault-agent/core/access";
import crypto from "node:crypto";
import path from "node:path";
import {
  Config,
  ConfigManager,
  defaultConfigPath,
  IndexStore,
} from "@vault-agent/core";

export interface PrepareServerAccessOptions {
  configPath?: string;
  defaultConfigPathOverride?: string;
}

export interface StartupIndexState {
  usable: boolean;
  shouldBootstrap: boolean;
  warnings: Array<{
    code: string;
    message: string;
  }>;
}

export function prepareServerAccessConfig(
  appConfig: Config,
  options: PrepareServerAccessOptions = {},
): Config {
  const prepared = structuredClone(appConfig);
  localAccessCredentials(prepared.server);
  if (prepared.write?.enabled) {
    validateServerAccessConfig(prepared);
    return prepared;
  }
  const isLocalhost = isLocalhostHost(prepared.server.host);
  if (isLocalhost) return prepared;

  if (hasRoleKeys(prepared.server)) return prepared;

  if (prepared.server.apiKey) {
    validateRemoteApiKey(prepared.server.apiKey);
    return prepared;
  }

  const resolvedDefaultConfigPath =
    options.defaultConfigPathOverride ?? defaultConfigPath();
  if (
    options.configPath &&
    path.resolve(options.configPath) !== path.resolve(resolvedDefaultConfigPath)
  ) {
    throw new Error(
      "API_KEY_REQUIRED: Non-localhost bind requires a configured API key when using a custom config path.",
    );
  }

  const generatedKey = crypto.randomBytes(32).toString("base64url");
  const manager = new ConfigManager(resolvedDefaultConfigPath);
  manager.set("server.apiKey", generatedKey);
  prepared.server.apiKey = generatedKey;
  console.log(
    "Non-localhost bind detected. An API key was generated and saved to the config file.",
  );
  console.log(
    "Run `vault-agent config reveal-api-key` to view it for client setup.",
  );
  return prepared;
}

export function validateServerAccessConfig(appConfig: Config): void {
  localAccessCredentials(appConfig.server);
  if (appConfig.write?.enabled && !hasRoleKeys(appConfig.server))
    throw new Error(
      "CONFIG_INVALID: Local HTTP writes require distinct read/admin keys.",
    );
  if (hasRoleKeys(appConfig.server) || isLocalhostHost(appConfig.server.host))
    return;
  if (!appConfig.server.apiKey) {
    throw new Error(
      "API_KEY_REQUIRED: Non-localhost bind requires an API key.",
    );
  }
  validateRemoteApiKey(appConfig.server.apiKey);
}

export function validateStartupIndexState(
  appStore: IndexStore,
  appConfig: Config,
): StartupIndexState {
  const manifest = appStore.getManifest();
  if (!manifest) {
    return { usable: false, shouldBootstrap: true, warnings: [] };
  }

  const staleness = appStore.checkStaleness(appConfig);
  if (staleness.incompatible) {
    return {
      usable: false,
      shouldBootstrap: false,
      warnings: [
        {
          code: "INDEX_INCOMPATIBLE",
          message: `${staleness.details}. Run vault-agent reindex to rebuild the index.`,
        },
      ],
    };
  }

  if (staleness.stale) {
    return {
      usable: true,
      shouldBootstrap: false,
      warnings: [
        {
          code: "INDEX_STALE",
          message: `${staleness.details}. Run vault-agent index or vault-agent reindex to refresh the index.`,
        },
      ],
    };
  }

  return { usable: true, shouldBootstrap: false, warnings: [] };
}

function validateRemoteApiKey(apiKey: string): void {
  if (apiKey.length < 32) {
    throw new Error(
      "API_KEY_REQUIRED: Non-localhost bind requires an API key of at least 32 characters.",
    );
  }
}

function isLocalhostHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function hasRoleKeys(
  server: Pick<
    Config["server"],
    "readKey" | "adminKey" | "previousReadKey" | "previousAdminKey"
  >,
): boolean {
  return [
    server.readKey,
    server.adminKey,
    server.previousReadKey,
    server.previousAdminKey,
  ].some(Boolean);
}
export function localAccessCredentials(
  server: Pick<
    Config["server"],
    "apiKey" | "readKey" | "adminKey" | "previousReadKey" | "previousAdminKey"
  >,
): AccessCredentials | null {
  if (!hasRoleKeys(server)) {
    return server.apiKey ? { read: [], admin: [server.apiKey] } : null;
  }
  const credentials = {
    read: [server.readKey, server.previousReadKey].filter(
      (v): v is string => !!v,
    ),
    admin: [server.adminKey, server.previousAdminKey].filter(
      (v): v is string => !!v,
    ),
  };
  if (
    server.apiKey ||
    !server.readKey ||
    !server.adminKey ||
    !validRoleCredentials(credentials) ||
    [...credentials.read, ...credentials.admin].some(
      (key) => !/^[A-Za-z0-9_-]{32,}$/.test(key),
    )
  ) {
    throw new Error(
      "CONFIG_INVALID: Configure distinct read/admin keys of at least 32 characters without a legacy API key.",
    );
  }
  return credentials;
}

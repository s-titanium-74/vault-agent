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
  const isLocalhost = isLocalhostHost(prepared.server.host);
  if (isLocalhost) return prepared;

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
  return prepared;
}

export function validateServerAccessConfig(appConfig: Config): void {
  if (isLocalhostHost(appConfig.server.host)) return;
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

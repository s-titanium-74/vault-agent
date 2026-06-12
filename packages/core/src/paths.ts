import envPathsFn from "env-paths";
import path from "node:path";

const APP_NAME = "vault-agent";

export function envPaths() {
  return envPathsFn(APP_NAME);
}

export function defaultConfigPath(): string {
  const paths = envPaths();
  return path.join(paths.config, "config.toml");
}

export function defaultIndexDir(): string {
  return path.join(envPaths().data, "indexes");
}

export function resolveIndexDir(override: string | undefined): string {
  if (override && override.trim().length > 0) {
    return override;
  }
  return defaultIndexDir();
}

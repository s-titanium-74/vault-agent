// Keep Wrangler's tsconfig normalization and esbuild project root aligned.
// This also lets generated configurations live outside the cloud package.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
export function runWrangler(command, args) {
  const cli = fileURLToPath(
    new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url),
  );
  const index = args.indexOf("--config");
  const config =
    index >= 0
      ? path.resolve(args[index + 1] ?? "")
      : fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  const forwarded =
    index >= 0 ? args.filter((_, i) => i !== index && i !== index + 1) : args;
  const result = spawnSync(
    process.execPath,
    [cli, ...command, "--config", config, ...forwarded],
    { stdio: "inherit", env: process.env, cwd: path.dirname(config) },
  );
  return result.error ? 1 : (result.status ?? 1);
}

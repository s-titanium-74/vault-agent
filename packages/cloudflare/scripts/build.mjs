import { fileURLToPath } from "node:url";
import { runWrangler } from "./wrangler.mjs";
process.exitCode = runWrangler(
  [
    "deploy",
    "--dry-run",
    "--outdir",
    fileURLToPath(new URL("../dist", import.meta.url)),
  ],
  process.argv.slice(2),
);

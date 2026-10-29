import { runWrangler } from "./wrangler.mjs";
const args = process.argv.slice(2);
if (args.includes("--dry-run")) {
  console.error(
    "Use npm run build for a dry run; deploy applies remote migrations.",
  );
  process.exit(2);
}
for (const command of [
  ["d1", "migrations", "apply", "DB", "--remote"],
  ["deploy"],
]) {
  const code = runWrangler(command, args);
  if (code !== 0) process.exit(code);
}

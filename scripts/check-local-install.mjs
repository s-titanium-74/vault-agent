// Run immediately after a clean root npm ci, before any cloud installation.
import { existsSync, readFileSync } from "node:fs";
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
const forbidden =
  /(^|\/)node_modules\/(wrangler|miniflare|workerd|@cloudflare\/[^/]+)$/;
const violations = Object.keys(lock.packages).filter((name) =>
  forbidden.test(name),
);
if (
  violations.length ||
  existsSync("packages/cloudflare/node_modules/wrangler")
) {
  console.error("Local installation must exclude the Cloudflare toolchain.");
  process.exit(1);
}
console.log("Local dependency closure excludes Cloudflare tooling.");

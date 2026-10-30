// Local configuration only. Resource creation and billing are explicit operator steps.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../../../", import.meta.url));
const [name, databaseId, mode = "lexical", plan = "free"] =
  process.argv.slice(2);
if (
  !/^[a-z][a-z0-9-]{1,46}[a-z0-9]$/.test(name ?? "") ||
  !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(databaseId ?? "") ||
  databaseId === "00000000-0000-0000-0000-000000000000" ||
  !["lexical", "semantic"].includes(mode) ||
  !["free", "paid"].includes(plan)
) {
  console.error("Usage: configure NAME D1_UUID [lexical|semantic] [free|paid]");
  process.exit(2);
}
const config = JSON.parse(
  await readFile(path.join(root, "wrangler.json"), "utf8"),
);
config.name = name;
config.main = "../" + config.main;
config.tsconfig = "../" + config.tsconfig;
config.$schema = "../" + config.$schema;
config.d1_databases[0] = {
  ...config.d1_databases[0],
  database_name: name,
  database_id: databaseId,
  migrations_dir: "../packages/cloudflare/migrations",
};
config.r2_buckets[0].bucket_name = name;
config.vars.VAULT_ID = randomUUID();
if (plan === "paid") config.limits = { cpu_ms: 1000 };
if (mode === "semantic") {
  config.vars.EXTERNAL_EMBEDDING_CONSENT = "true";
  config.ai = { binding: "AI" };
  config.vectorize = [{ binding: "VECTORS", index_name: name }];
}
await mkdir(path.join(root, ".cloudflare"), { recursive: true, mode: 0o700 });
// Exclusive creation: never replace an existing deployment's stable vault UUID.
await writeFile(
  path.join(root, ".cloudflare/wrangler.jsonc"),
  JSON.stringify(config, null, 2) + "\n",
  { mode: 0o600, flag: "wx" },
);
console.log(
  "Created .cloudflare/wrangler.jsonc. Review scope and billing before deployment. No resources created.",
);

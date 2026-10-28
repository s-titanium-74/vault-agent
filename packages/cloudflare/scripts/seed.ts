import { mkdir, writeFile } from "node:fs/promises";
import { fixture } from "./fixture.js";
const seed = await fixture();
await mkdir(".wrangler/fixture", { recursive: true });
await writeFile(
  ".wrangler/fixture/seed.sql",
  seed.statements.join(";\n") + ";\n",
);
for (let i = 0; i < seed.objects.length; i++)
  await writeFile(`.wrangler/fixture/object-${i}`, seed.objects[i]!.content);
await writeFile(
  ".wrangler/fixture/objects.json",
  JSON.stringify(
    seed.objects.map((o, i) => ({
      key: o.key,
      file: `.wrangler/fixture/object-${i}`,
    })),
    null,
    2,
  ),
);
console.log(
  "Synthetic fixture written under .wrangler/fixture. Apply migration, seed.sql, then upload listed objects through private R2 bindings.",
);

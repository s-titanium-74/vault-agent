import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const [destination, countValue = "2"] = process.argv.slice(2);
const count = Number(countValue);
if (!destination || !Number.isInteger(count) || count < 1 || count > 1000) {
  console.error("Usage: sample DESTINATION [NOTE_COUNT: 1..1000]");
  process.exit(2);
}
// Fail if the destination already exists: never overwrite a user's vault.
await mkdir(destination, { mode: 0o700 });
await mkdir(path.join(destination, "Notes"));
await mkdir(path.join(destination, "images"));
for (let i = 0; i < count; i++) {
  const id = String(i).padStart(4, "0");
  const next = String((i + 1) % count).padStart(4, "0");
  const text = `---\ntags: [synthetic, orchard]\ntype: example\n---\n# Orchard ${id}\n\nSynthetic apple trees and winter pruning. 日本語の合成ノート。果樹園と冬の剪定。\n\n[[Note-${next}]] ![chart](../images/chart.svg)\n\n## Checklist\n\n${"Water the synthetic orchard. 果樹園の水やり。\n".repeat(24)}`;
  await writeFile(path.join(destination, "Notes", `Note-${id}.md`), text);
}
await writeFile(
  path.join(destination, "images/chart.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>\n',
);
await writeFile(
  path.join(destination, "Notes/secret.md"),
  "Synthetic exclusion probe; excluded by the sample configuration.\n",
);
console.log(
  JSON.stringify({
    notes: count,
    attachments: 1,
    excluded: 1,
    synthetic: true,
  }),
);

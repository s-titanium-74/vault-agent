import { mutationTextBytes } from "./mutation-text.js";
import {
  mutationBatchSummary,
  type PreparedMutationBatch,
} from "./mutations.js";
import { MutationError } from "./mutation-schemas.js";

export const MUTATION_PREVIEW_MAX_BYTES = 16 * 1024;
export interface MutationNoteDiff {
  offset: number;
  removed: string;
  added: string;
  removed_bytes: number;
  added_bytes: number;
  truncated: boolean;
}

function prefix(text: string, maxBytes: number): string {
  let length = 0,
    end = 0;
  for (const char of text) {
    const size = mutationTextBytes(char).length;
    if (length + size > maxBytes) break;
    length += size;
    end += char.length;
  }
  return text.slice(0, end);
}
function difference(
  before: string,
  after: string,
  maxBytes: number,
): MutationNoteDiff | undefined {
  let start = 0;
  while (
    start < before.length &&
    start < after.length &&
    before[start] === after[start]
  )
    start++;
  // Never cut a surrogate pair at a changed-span boundary.
  if (start > 0 && /[\udc00-\udfff]/.test(before[start] ?? after[start] ?? ""))
    start--;
  let b = before.length,
    a = after.length;
  while (b > start && a > start && before[b - 1] === after[a - 1]) {
    b--;
    a--;
  }
  if (b < before.length && /[\udc00-\udfff]/.test(before[b] ?? "")) {
    b++;
    a++;
  }
  const removed = before.slice(start, b),
    added = after.slice(start, a);
  const removedBytes = mutationTextBytes(removed).length;
  const addedBytes = mutationTextBytes(added).length;
  const diff: MutationNoteDiff = {
    offset: start,
    removed,
    added,
    removed_bytes: removedBytes,
    added_bytes: addedBytes,
    truncated: false,
  };
  // Bound JSON-rendered bytes too, including escaping/control characters.
  let allowance = Math.min(maxBytes, removedBytes + addedBytes);
  while (mutationTextBytes(JSON.stringify(diff)).length > maxBytes) {
    if (allowance === 0) return undefined;
    allowance = Math.floor(allowance / 2);
    diff.removed = prefix(removed, Math.floor(allowance / 2));
    diff.added = prefix(added, allowance - Math.floor(allowance / 2));
    diff.truncated = true;
  }
  return diff;
}

/** Explicit, ephemeral note previews; never call from logs or ordinary status responses. */
export function previewMutationBatch(
  batch: PreparedMutationBatch,
  maxBytes = MUTATION_PREVIEW_MAX_BYTES,
) {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 0 ||
    maxBytes > MUTATION_PREVIEW_MAX_BYTES
  )
    throw new MutationError("INVALID_REQUEST");
  let remaining = maxBytes;
  const summary = mutationBatchSummary(batch);
  const results = summary.results.map((summaryItem, index) => {
    const item = batch.items[index]!;
    if (
      item.status !== "prepared" ||
      !item.note_id ||
      item.action === "delete" ||
      !item.bytes
    )
      return summaryItem;
    if (item.before === undefined) throw new MutationError("INVALID_REQUEST");
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(item.bytes);
    const diff = difference(item.before, text, remaining);
    if (!diff) return { ...summaryItem, preview_truncated: true };
    remaining -= mutationTextBytes(JSON.stringify(diff)).length;
    return { ...summaryItem, diff, preview_truncated: diff.truncated };
  });
  return { ...summary, results };
}

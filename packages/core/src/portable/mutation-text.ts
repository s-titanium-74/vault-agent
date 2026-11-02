import { RE2JS } from "re2js";
import { MutationError, type MutationReplacement } from "./mutation-schemas.js";

export const MUTATION_REGEX_WORK_BUDGET = 16_000_000;
export interface MutationWorkBudget {
  remaining: number;
}
export function mutationTextBytes(text: string): Uint8Array {
  const bytes = new TextEncoder().encode(text);
  // ignoreBOM preserves a supplied BOM during the round trip.
  if (
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !==
    text
  )
    throw new MutationError("INVALID_UTF8");
  return bytes;
}
export function checkMutationSize(bytes: number, limit: number): void {
  if (bytes > limit) throw new MutationError("SIZE_LIMIT_EXCEEDED");
}

/** Canonical RFC 4648 padded Base64, without Buffer/atob or provider I/O. */
export function decodeMutationBase64(
  value: string,
  maxBytes: number,
): Uint8Array {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  checkMutationSize(value.length, Math.ceil(maxBytes / 3) * 4);
  if (value.length % 4 !== 0) throw new MutationError("INVALID_BASE64");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const length = (value.length / 4) * 3 - padding;
  checkMutationSize(length, maxBytes);
  const bytes = new Uint8Array(length);
  for (let i = 0, out = 0; i < value.length; i += 4) {
    const a = alphabet.indexOf(value[i]!);
    const b = alphabet.indexOf(value[i + 1]!);
    const c = value[i + 2] === "=" ? 0 : alphabet.indexOf(value[i + 2]!);
    const d = value[i + 3] === "=" ? 0 : alphabet.indexOf(value[i + 3]!);
    const last = i + 4 === value.length;
    if (
      a < 0 ||
      b < 0 ||
      c < 0 ||
      d < 0 ||
      ((!last || padding !== 2) && value[i + 2] === "=") ||
      (!last && value[i + 3] === "=") ||
      (last && padding === 2 && (b & 15) !== 0) ||
      (last && padding === 1 && (c & 3) !== 0)
    )
      throw new MutationError("INVALID_BASE64");
    const n = (a << 18) | (b << 12) | (c << 6) | d;
    if (out < length) bytes[out++] = n >>> 16;
    if (out < length) bytes[out++] = (n >>> 8) & 255;
    if (out < length) bytes[out++] = n & 255;
  }
  return bytes;
}

function compileRegex(pattern: string, flags: string): RE2JS {
  if (pattern.length > 1024) throw new MutationError("REGEX_BUDGET_EXCEEDED");
  if (!/^[ims]*$/.test(flags) || new Set(flags).size !== flags.length)
    throw new MutationError("INVALID_PATTERN");
  // Do not allow compact repetitions to expand before checking programSize.
  // Character classes and escapes are scanned rather than parsed with user regex.
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      // RE2 quoted regions would invalidate the class scanner's state.
      if (pattern[i + 1] === "Q" || pattern[i + 1] === "E")
        throw new MutationError("INVALID_PATTERN");
      i++;
      continue;
    }
    if (c === "[") inClass = true;
    if (c === "]") inClass = false;
    if (
      !inClass &&
      (c === "{" ||
        c === "}" ||
        (c === "(" && pattern[i + 1] === "?" && pattern[i + 2] !== ":"))
    )
      throw new MutationError("INVALID_PATTERN");
  }
  try {
    const compiled = RE2JS.compile(
      pattern,
      (flags.includes("i") ? RE2JS.CASE_INSENSITIVE : 0) |
        (flags.includes("m") ? RE2JS.MULTILINE : 0) |
        (flags.includes("s") ? RE2JS.DOTALL : 0),
    );
    if (compiled.programSize() > 2048 || compiled.groupCount() > 32)
      throw new MutationError("REGEX_BUDGET_EXCEEDED");
    return compiled;
  } catch (error) {
    if (error instanceof MutationError) throw error;
    throw new MutationError("INVALID_PATTERN");
  }
}

type ReplacementToken = string | number;
function replacementTokens(value: string, groups: number): ReplacementToken[] {
  const tokens: ReplacementToken[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== "$") continue;
    tokens.push(value.slice(start, i));
    if (value[i + 1] === "$") {
      tokens.push("$");
      i++;
    } else {
      const digit = value[i + 1];
      if (!digit || digit < "1" || digit > "9")
        throw new MutationError("INVALID_PATTERN");
      let reference = digit;
      i++;
      const next = value[i + 1];
      if (next && next >= "0" && next <= "9") {
        reference += next;
        i++;
      }
      const group = Number(reference);
      if (group > groups) throw new MutationError("INVALID_PATTERN");
      tokens.push(group);
    }
    start = i + 1;
  }
  tokens.push(value.slice(start));
  return tokens;
}

/** Pure preparation. All replacements succeed together or no output is returned. */
export function prepareMutationText(
  content: string,
  replacements: readonly MutationReplacement[],
  maxBytes: number,
  budget: MutationWorkBudget = { remaining: MUTATION_REGEX_WORK_BUDGET },
): string {
  checkMutationSize(mutationTextBytes(content).length, maxBytes);
  let text = content;
  for (const r of replacements) {
    const compiled =
      r.match_type === "regex" ? compileRegex(r.pattern, r.flags) : null;
    const matcher = compiled?.matcher(text);
    const tokens = compiled
      ? replacementTokens(r.replacement, compiled.groupCount())
      : null;
    const parts: string[] = [];
    let offset = 0,
      search = 0,
      count = 0,
      outputBytes = 0;
    const append = (part: string) => {
      outputBytes += mutationTextBytes(part).length;
      checkMutationSize(outputBytes, maxBytes);
      parts.push(part);
    };
    while (search <= text.length) {
      let start: number, end: number;
      if (matcher && compiled) {
        const cost =
          (text.length - search + 1) *
          compiled.programSize() *
          (compiled.groupCount() + 1);
        if (cost > budget.remaining)
          throw new MutationError("REGEX_BUDGET_EXCEEDED");
        budget.remaining -= cost;
        if (!matcher.find(search)) break;
        start = matcher.start();
        end = matcher.end();
      } else {
        start = text.indexOf(r.pattern, search);
        if (start < 0) break;
        end = start + r.pattern.length;
      }
      count++;
      if (count > r.expected_matches)
        throw new MutationError("MATCH_COUNT_MISMATCH");
      append(text.slice(offset, start));
      if (tokens && matcher) {
        for (const token of tokens)
          append(
            typeof token === "string" ? token : (matcher.group(token) ?? ""),
          );
      } else append(r.replacement);
      offset = end;
      // Explicit Unicode code-point progress for empty matches, once at EOF.
      search =
        end > start
          ? end
          : end + ((text.codePointAt(end) ?? 0) > 0xffff ? 2 : 1);
    }
    if (count !== r.expected_matches)
      throw new MutationError("MATCH_COUNT_MISMATCH");
    append(text.slice(offset));
    text = parts.join("");
  }
  return text;
}

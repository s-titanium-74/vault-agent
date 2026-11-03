export function escapeFTSQuery(query: string): string {
  const tokens = query
    .trim()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (tokens.length === 0) return "";

  return tokens
    .map((token) => {
      const cleaned = token.replace(/[*"'(){}[\]:;,.!?]/g, "");
      if (cleaned.length === 0) return "";
      const escaped = cleaned.replace(/"/g, '""');
      return `"${escaped}"*`;
    })
    .filter((t) => t.length > 0)
    .join(" ");
}

export function textToTrigrams(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, " ");
  const grams = new Set<string>();

  for (let i = 0; i <= normalized.length - 3; i++) {
    const gram = normalized.slice(i, i + 3);
    if (gram.trim().length === 3) {
      grams.add(gram);
    }
  }

  return Array.from(grams);
}

export function matchFallbackNotes(
  rows: Record<string, unknown>[],
  query: string,
  limit: number,
) {
  const normalizedQuery = query.trim().toLowerCase();
  const tokens = normalizedQuery.split(/\s+/).filter((t) => t.length > 0);

  const matched = rows.filter((row) => {
    const title = ((row.title as string) ?? "").toLowerCase();
    const path = ((row.path as string) ?? "").toLowerCase();
    const aliases = JSON.parse(
      (row.aliases_json as string) ?? "[]",
    ) as string[];
    const tags = JSON.parse((row.tags_json as string) ?? "[]") as string[];

    const fields = [
      title,
      path,
      ...aliases.map((a) => a.toLowerCase()),
      ...tags.map((t) => t.toLowerCase()),
    ];
    if (fields.includes(normalizedQuery)) return true;

    const searchable = fields.join(" ");
    const words = new Set(searchable.split(/[^\p{L}\p{M}\p{N}]+/u));

    return tokens.some((token) =>
      Array.from(token).length > 2 ||
      /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(token)
        ? searchable.includes(token)
        : words.has(token) || fields.includes(token),
    );
  });

  return matched.slice(0, limit);
}

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

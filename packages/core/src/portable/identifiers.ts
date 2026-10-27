import { canonicalSourcePath } from "./source-policy.js";
export async function contentRevision(
  content: string | Uint8Array,
): Promise<string> {
  const bytes =
    typeof content === "string"
      ? new TextEncoder().encode(content)
      : new Uint8Array(content);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}
export async function noteIdFromPath(path: string): Promise<string> {
  return (await contentRevision(canonicalSourcePath(path))).slice(0, 32);
}
export function createVaultId(): string {
  return crypto.randomUUID();
}

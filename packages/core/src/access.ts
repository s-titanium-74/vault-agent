/** Runtime-neutral HTTP policy. Callers own secret loading and safe comparison. */
export type AccessRole = "read" | "readwrite" | "admin";
export interface AccessCredentials {
  read: readonly string[];
  admin: readonly string[];
  readwrite?: readonly string[];
}
export type AccessFailure =
  "AUTH_REQUIRED" | "AUTH_FAILED" | "ADMIN_REQUIRED" | "READWRITE_REQUIRED";
export function requiredHttpRole(pathname: string, method: string): AccessRole {
  return /^\/(index|reindex|uploads?|sync|watch)(\/|$)/.test(pathname) ||
    (/^\/jobs(?:\/|$)/.test(pathname) && method !== "GET")
    ? "admin"
    : "read";
}
export function validRoleCredentials(credentials: AccessCredentials): boolean {
  return (
    credentials.read.length > 0 &&
    credentials.admin.length > 0 &&
    !credentials.read.some(
      (key) =>
        credentials.admin.includes(key) || credentials.readwrite?.includes(key),
    ) &&
    !(credentials.readwrite ?? []).some((key) =>
      credentials.admin.includes(key),
    )
  );
}
export async function authorizeBearer(
  header: string | undefined | null,
  credentials: AccessCredentials,
  required: AccessRole,
  equal: (incoming: string, expected: string) => boolean | Promise<boolean>,
): Promise<AccessFailure | null> {
  if (!header) return "AUTH_REQUIRED";
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/i.exec(header);
  if (!match) return "AUTH_FAILED";
  const token = match[1]!;
  // Evaluate every candidate, even when an earlier credential matches.
  const [read, admin, readwrite] = await Promise.all([
    Promise.all(credentials.read.map((key) => equal(token, key))),
    Promise.all(credentials.admin.map((key) => equal(token, key))),
    Promise.all((credentials.readwrite ?? []).map((key) => equal(token, key))),
  ]);
  if (!read.some(Boolean) && !admin.some(Boolean) && !readwrite.some(Boolean))
    return "AUTH_FAILED";
  if (required === "admin" && !admin.some(Boolean)) return "ADMIN_REQUIRED";
  if (
    required === "readwrite" &&
    !admin.some(Boolean) &&
    !readwrite.some(Boolean)
  )
    return "READWRITE_REQUIRED";
  return null;
}

/** Shared MCP mutation permission; stdio adapters separately trust their process. */
export function canWrite(role: AccessRole | undefined): boolean {
  return role === "readwrite" || role === "admin";
}

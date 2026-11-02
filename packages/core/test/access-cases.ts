import type { AccessRole, AccessFailure } from "../src/access.js";
export const keys = {
  read: "a".repeat(64),
  admin: "b".repeat(64),
  oldRead: "c".repeat(64),
  oldAdmin: "d".repeat(64),
  revoked: "e".repeat(64),
};
export const credentials = {
  read: [keys.read, keys.oldRead],
  admin: [keys.admin, keys.oldAdmin],
};
export const accessCases: {
  name: string;
  header?: string;
  role: AccessRole;
  failure: AccessFailure | null;
}[] = [
  { name: "missing", role: "read", failure: "AUTH_REQUIRED" },
  {
    name: "malformed",
    header: "Basic synthetic",
    role: "read",
    failure: "AUTH_FAILED",
  },
  {
    name: "empty bearer",
    header: "Bearer ",
    role: "admin",
    failure: "AUTH_FAILED",
  },
  {
    name: "multiple credentials",
    header: `Bearer ${keys.read}, Bearer ${keys.admin}`,
    role: "read",
    failure: "AUTH_FAILED",
  },
  {
    name: "revoked",
    header: `Bearer ${keys.revoked}`,
    role: "read",
    failure: "AUTH_FAILED",
  },
  ...(["read", "admin"] as const).flatMap((role) => [
    {
      name: `read to ${role}`,
      header: `Bearer ${keys.read}`,
      role,
      failure: role === "admin" ? ("ADMIN_REQUIRED" as const) : null,
    },
    {
      name: `admin to ${role}`,
      header: `Bearer ${keys.admin}`,
      role,
      failure: null,
    },
    {
      name: `old read to ${role}`,
      header: `Bearer ${keys.oldRead}`,
      role,
      failure: role === "admin" ? ("ADMIN_REQUIRED" as const) : null,
    },
    {
      name: `old admin to ${role}`,
      header: `Bearer ${keys.oldAdmin}`,
      role,
      failure: null,
    },
  ]),
];

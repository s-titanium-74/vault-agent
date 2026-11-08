import { expect, it } from "vitest";
import {
  authorizeBearer,
  requiredHttpRole,
  validRoleCredentials,
} from "../src/access.js";
import { accessCases, credentials, keys } from "./access-cases.js";
it.each(accessCases)("$name", async ({ header, role, failure }) => {
  expect(
    await authorizeBearer(header, credentials, role, (a, b) => a === b),
  ).toBe(failure);
});
it("revokes removed overlap keys and rejects cross-role collisions", async () => {
  expect(
    await authorizeBearer(
      `Bearer ${keys.oldAdmin}`,
      { read: [keys.read], admin: [keys.admin] },
      "read",
      (a, b) => a === b,
    ),
  ).toBe("AUTH_FAILED");
  expect(
    validRoleCredentials({ read: [keys.read], admin: [keys.admin, keys.read] }),
  ).toBe(false);
});
it("classifies operations independently of HTTP write verbs", () => {
  for (const path of ["/search", "/related", "/mcp"])
    expect(requiredHttpRole(path, "POST")).toBe("read");
  for (const path of [
    "/index",
    "/reindex",
    "/uploads/a",
    "/sync/webhook",
    "/watch",
    "/jobs/id",
  ])
    expect(requiredHttpRole(path, "DELETE")).toBe("admin");
  expect(requiredHttpRole("/jobs/id", "GET")).toBe("read");
});

it("enforces the full three-role mutation matrix and readwrite revocation", async () => {
  for (const [token, permitted] of [
    [keys.read, false],
    [keys.oldRead, false],
    [keys.readwrite, true],
    [keys.oldReadwrite, true],
    [keys.admin, true],
    [keys.oldAdmin, true],
  ] as const) {
    expect(
      await authorizeBearer(
        `Bearer ${token}`,
        credentials,
        "readwrite",
        (a, b) => a === b,
      ),
    ).toBe(permitted ? null : "READWRITE_REQUIRED");
  }
  for (const header of [undefined, "Basic synthetic", `Bearer ${keys.revoked}`])
    expect(
      await authorizeBearer(
        header,
        credentials,
        "readwrite",
        (a, b) => a === b,
      ),
    ).toBe(header ? "AUTH_FAILED" : "AUTH_REQUIRED");
  expect(
    await authorizeBearer(
      `Bearer ${keys.oldReadwrite}`,
      { ...credentials, readwrite: [keys.readwrite] },
      "read",
      (a, b) => a === b,
    ),
  ).toBe("AUTH_FAILED");
  for (const override of [
    { readwrite: [keys.read] },
    { readwrite: [keys.oldAdmin] },
    { read: [keys.oldReadwrite] },
  ])
    expect(validRoleCredentials({ ...credentials, ...override })).toBe(false);
});

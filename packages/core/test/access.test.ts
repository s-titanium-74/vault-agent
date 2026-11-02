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

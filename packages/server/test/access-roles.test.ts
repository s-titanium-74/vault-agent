import { afterEach, expect, it, vi } from "vitest";
import {
  DEFAULT_CONFIG,
  FreshnessMachine,
  IndexStore,
  indexVault,
  getIndexPath,
} from "@vault-agent/core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer, initApp, resetApp } from "../src/index.js";
import {
  localAccessCredentials,
  prepareServerAccessConfig,
  validateServerAccessConfig,
} from "../src/access.js";
import { accessCases, keys } from "../../core/test/access-cases.js";
const roleKeys = {
  readKey: keys.read,
  adminKey: keys.admin,
  previousReadKey: keys.oldRead,
  previousAdminKey: keys.oldAdmin,
};
const config = () => ({
  ...structuredClone(DEFAULT_CONFIG),
  server: { ...DEFAULT_CONFIG.server, ...roleKeys, logLevel: "error" as const },
});
afterEach(() => {
  resetApp();
  vi.restoreAllMocks();
});
it.each(accessCases)(
  "REST $name before parsing",
  async ({ header, role, failure }) => {
    const app = await createServer(config());
    try {
      const response = await app.inject({
        method: role === "admin" ? "POST" : "GET",
        url: role === "admin" ? "/watch" : "/health",
        headers: header
          ? { authorization: header, "content-type": "application/json" }
          : {},
        ...(role === "admin" ? { payload: "invalid JSON" } : {}),
      });
      expect(response.statusCode).toBe(
        failure
          ? failure === "AUTH_REQUIRED"
            ? 401
            : 403
          : role === "admin"
            ? 400
            : 200,
      );
      if (failure) expect(response.json().error.code).toBe(failure);
    } finally {
      await app.close();
    }
  },
);
it("fails closed for partial, legacy-mixed and cross-role rotation settings on all hosts", () => {
  for (const host of ["127.0.0.1", "0.0.0.0"]) {
    for (const override of [
      { adminKey: "" },
      { apiKey: "legacy" },
      { previousReadKey: keys.admin },
      { previousAdminKey: keys.read },
      { readKey: "short" },
    ]) {
      const c = config();
      Object.assign(c.server, { host }, override);
      expect(() => validateServerAccessConfig(c)).toThrow("CONFIG_INVALID");
      expect(() => prepareServerAccessConfig(c)).toThrow("CONFIG_INVALID");
    }
    const c = config();
    c.server.host = host;
    expect(() => validateServerAccessConfig(c)).not.toThrow();
  }
  expect(localAccessCredentials(DEFAULT_CONFIG.server)).toBeNull();
});
it("revokes previous keys on restart and protects unavailable MCP routes", async () => {
  const c = config();
  c.server.previousReadKey = "";
  c.server.previousAdminKey = "";
  c.mcp.enabled = true;
  const app = await createServer(c);
  try {
    for (const token of [keys.oldRead, keys.oldAdmin]) {
      const r = await app.inject({
        method: "GET",
        url: "/health",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe("AUTH_FAILED");
    }
    for (const method of ["GET", "POST", "PUT", "DELETE"] as const) {
      const r = await app.inject({ method, url: "/mcp" });
      expect(r.statusCode).toBe(401);
    }
  } finally {
    await app.close();
  }
});
it("rejects management before changing files, index, sync jobs or webhook state", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "access-roles-"));
  const c = config();
  c.vault.root = path.join(dir, "vault");
  c.index.dir = path.join(dir, "index");
  fs.mkdirSync(c.vault.root);
  fs.writeFileSync(
    path.join(c.vault.root, "Example.md"),
    "# Example\nSynthetic content.",
  );
  await indexVault(c);
  const store = await IndexStore.open(getIndexPath(c));
  const sync = {
    pull: vi.fn(),
    handleWebhook: vi.fn(),
    stopScheduledSync: vi.fn(),
  };
  initApp(store, c, undefined, sync as never, new FreshnessMachine());
  const app = await createServer(c);
  const before = fs.readFileSync(getIndexPath(c));
  try {
    for (const url of [
      "/index",
      "/reindex",
      "/sync/pull",
      "/uploads",
      "/jobs/id/advance",
      "/watch",
    ]) {
      const response = await app.inject({
        method: "POST",
        url,
        headers: {
          authorization: `Bearer ${keys.read}`,
          "content-type": "application/json",
        },
        payload: "invalid JSON",
      });
      expect(response.statusCode).toBe(403);
      expect(response.json().error.code).toBe("ADMIN_REQUIRED");
    }
    for (const method of ["GET", "PUT", "DELETE"] as const) {
      const r = await app.inject({
        method,
        url: "/sync/webhook",
        headers: { authorization: `Bearer ${keys.read}` },
      });
      expect(r.statusCode).toBe(403);
    }
    const webhook = await app.inject({
      method: "POST",
      url: "/sync/webhook",
      payload: {},
    });
    expect(webhook.statusCode).not.toBe(200);
    expect(sync.pull).not.toHaveBeenCalled();
    expect(sync.handleWebhook).not.toHaveBeenCalled();
    expect(fs.readFileSync(getIndexPath(c))).toEqual(before);
    expect(fs.readFileSync(path.join(c.vault.root, "Example.md"), "utf8")).toBe(
      "# Example\nSynthetic content.",
    );
    const adminIndex = await app.inject({
      method: "POST",
      url: "/index",
      headers: { authorization: `Bearer ${keys.admin}` },
      payload: {},
    });
    expect(adminIndex.statusCode).toBe(200);
    expect(adminIndex.json().data.mode).toBeDefined();
    for (const key of [keys.read, keys.admin]) {
      const r = await app.inject({
        method: "POST",
        url: "/search",
        headers: { authorization: `Bearer ${key}` },
        payload: { query: "Example", mode: "lexical" },
      });
      expect(r.statusCode).toBe(200);
    }
  } finally {
    await app.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

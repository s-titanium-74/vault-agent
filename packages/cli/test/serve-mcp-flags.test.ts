import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.resolve(__dirname, "../dist/main.js");

describe("serve command MCP flags", () => {
  it("exposes --mcp-enabled and --mcp-http-endpoint in help", async () => {
    const { stdout } = await execFileAsync("node", [
      cliPath,
      "serve",
      "--help",
    ]);
    expect(stdout).toContain("--mcp-enabled");
    expect(stdout).toContain("--mcp-http-endpoint");
  });
});

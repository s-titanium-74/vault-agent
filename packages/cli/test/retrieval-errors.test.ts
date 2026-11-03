import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";

const cli = fileURLToPath(new URL("../dist/main.js", import.meta.url));

let vaultDir: string;
let configPath: string;

beforeAll(async () => {
  vaultDir = await mkdtemp(join(tmpdir(), "vault-agent-retrieval-"));
  configPath = join(vaultDir, "config.toml");
  await writeFile(configPath, `vault.root = ${JSON.stringify(vaultDir)}\n`);
});

afterAll(async () => {
  if (vaultDir) await rm(vaultDir, { recursive: true, force: true });
});

const note = {
  path: "synthetic.md",
  title: "Synthetic note",
  heading: "Synthetic heading",
  size: 17,
  content: "Synthetic content",
};

it.each([
  [200, 0, ""],
  [401, 3, "AUTH_REQUIRED"],
  [403, 3, "AUTH_FAILED"],
  [404, 4, "NOT_FOUND"],
  [413, 2, "TOO_LARGE"],
  [500, 1, "HTTP_500"],
])(
  "handles HTTP %i for note and chunk in both output modes",
  async (status, exitCode, code) => {
    const expectedError = (kind: string) => ({
      code: status === 404 ? `${kind.toUpperCase()}_${code}` : code,
      message:
        status === 500
          ? "Request failed"
          : kind === "note"
            ? "Synthetic request failed"
            : "The operation could not be completed.",
    });
    const server = createServer((request, response) => {
      if (request.headers.authorization !== "Bearer synthetic-key") {
        response.writeHead(400).end();
        return;
      }
      if (status === 500) {
        response.writeHead(status).end("Synthetic upstream diagnostics");
        return;
      }
      const kind = request.url?.startsWith("/notes/") ? "note" : "chunk";
      const body =
        status === 200
          ? { data: note }
          : {
              error: {
                ...expectedError(kind),
                details: { requestId: "synthetic-request" },
              },
            };
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(JSON.stringify(body));
    });
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected a TCP address");
      }
      await Promise.all(
        [
          ["note", "synthetic-id"],
          ["chunk", "synthetic-id", "0"],
        ].flatMap((args) =>
          [false, true].map(async (json) => {
            const { code, message } = expectedError(args[0]);
            const result = await new Promise((resolve) => {
              execFile(
                process.execPath,
                [
                  cli,
                  "--config",
                  configPath,
                  "--endpoint",
                  `http://127.0.0.1:${address.port}`,
                  "--api-key",
                  "synthetic-key",
                  "get",
                  ...args,
                  ...(json ? ["--json"] : []),
                ],
                {
                  timeout: 4000,
                  env: Object.fromEntries(
                    Object.entries(process.env).filter(
                      ([key]) => !key.startsWith("VAULT_AGENT_"),
                    ),
                  ),
                },
                (error, stdout, stderr) =>
                  resolve({ code: error?.code ?? 0, stdout, stderr }),
              );
            });
            if (status === 200) {
              expect(result).toEqual({
                code: 0,
                stdout: json
                  ? JSON.stringify({ data: note }, null, 2) + "\n"
                  : note.content + "\n",
                stderr: json
                  ? ""
                  : `Path: synthetic.md\n${args[0] === "note" ? "Title: Synthetic note" : "Heading: Synthetic heading"}\nSize: 17 bytes\n`,
              });
              return;
            }
            expect(result).toEqual({
              code: exitCode,
              stdout: json
                ? JSON.stringify({ error: { code, message } }, null, 2) + "\n"
                : "",
              stderr: json ? "" : `${code}: ${message}\n`,
            });
          }),
        ),
      );
    } finally {
      server.close();
    }
  },
);

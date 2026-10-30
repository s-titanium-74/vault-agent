// Read-only checks against an operator-created synthetic deployment.
// Args: private state JSON, content-free report JSON.
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const state = JSON.parse(await readFile(process.argv[2]!, "utf8"));
const reportFile = process.argv[3]!;
assert(reportFile);
const report = {
  date: new Date().toISOString(),
  groups: [] as string[],
  tools: 0,
  passed: false,
};
async function request(route: string, token?: string, body?: unknown) {
  return fetch(state.endpoint + route, {
    method: body === undefined ? "GET" : "POST",
    redirect: "error",
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "Content-Type": "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
}
try {
  assert.equal((await request("/health")).status, 200);
  assert.equal((await request("/status")).status, 401);
  assert.equal((await request("/status", "invalid")).status, 403);
  assert.equal((await request("/uploads", state.readToken, {})).status, 403);
  assert.equal((await request("/status", state.readToken)).status, 200);
  report.groups.push("authenticated-http-and-read-admin-separation");
  const response = await request("/search", state.readToken, {
    query: "citrus",
    mode: "lexical",
    limit: 5,
  });
  assert.equal(response.status, 200);
  const search = (await response.json()) as any;
  assert(search.data.results.length > 0);
  const id = search.data.results[0].noteId;
  assert.equal(
    (
      await request(
        `/notes/${id}?snapshot=${search.revision.snapshot}`,
        state.readToken,
      )
    ).status,
    200,
  );
  assert.equal(
    (await request(`/notes/${id}?snapshot=${"0".repeat(64)}`, state.readToken))
      .status,
    409,
  );
  report.groups.push("http-search-and-revision-pinned-explicit-get");
  const client = new Client({
    name: "synthetic-deployment-client",
    version: "1.0",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(state.endpoint + "/mcp"), {
        requestInit: {
          headers: { Authorization: `Bearer ${state.readToken}` },
        },
      }),
    );
    report.tools = (await client.listTools()).tools.length;
    assert.equal(report.tools, 18);
    const found = await client.callTool({
      name: "search",
      arguments: { query: "citrus", mode: "lexical" },
    });
    assert.notEqual(found.isError, true);
    assert(JSON.stringify(found).includes("Notes/Orchard.md"));
    const note = await client.callTool({
      name: "get_note",
      arguments: { noteId: id },
    });
    assert.notEqual(note.isError, true);
    assert(JSON.stringify(note).includes("Changed citrus orchard"));
    report.groups.push("native-remote-mcp-initialize-list-search-explicit-get");
  } finally {
    await client.close();
  }
  report.passed = true;
  console.log(
    JSON.stringify({
      passed: true,
      groups: report.groups,
      tools: report.tools,
    }),
  );
} catch (error) {
  // Do not print request URLs, response bodies or transport error messages.
  console.error(
    JSON.stringify({
      passed: false,
      errorType: error instanceof Error ? error.name : "unknown",
    }),
  );
  process.exitCode = 1;
} finally {
  await writeFile(reportFile, JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
}

// Run only against the disposable test/remote-semantic-worker.ts deployment.
// Credentials and endpoint are read from a private operator-supplied JSON file.
import { readFile, writeFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const state = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  endpoint: string;
  readToken: string;
  adminToken: string;
};
const reportFile = process.argv[3]!;
assert(reportFile, "An output report file is required.");
const report: {
  groups: string[];
  relevance: unknown[];
  durationsMs: number[];
  usage: Record<string, number>;
} = { groups: [], relevance: [], durationsMs: [], usage: {} };
async function call(path: string, body?: unknown, token = state.readToken) {
  const start = Date.now();
  const response = await fetch(state.endpoint + path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(35000),
  });
  const result = (await response.json()) as any;
  report.durationsMs.push(Date.now() - start);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  for (const [name, count] of Object.entries(result.usage ?? {}))
    report.usage[name] = (report.usage[name] ?? 0) + Number(count);
  return { status: response.status, result };
}
async function admin(name: string) {
  const response = await call(`/__smoke/${name}`, {}, state.adminToken);
  assert.equal(
    response.status,
    200,
    `Synthetic administration ${name} failed.`,
  );
  return response.result;
}
function passed(name: string) {
  report.groups.push(name);
  console.log(JSON.stringify({ group: name, passed: true }));
}
async function search(query: string, mode: string, filters?: unknown) {
  const response = await call("/search", {
    query,
    mode,
    limit: 3,
    ...(filters ? { filters } : {}),
  });
  assert.equal(response.status, 200, "Search failed.");
  return response.result;
}
try {
  const resume = process.argv.includes("--resume-visibility");
  if (resume) {
    const previous = JSON.parse(await readFile(reportFile, "utf8"));
    assert(
      previous.groups.includes("remote-mcp-sdk-semantic-and-related") &&
        previous.relevance.some(
          (row: any) => row.kind === "asynchronous-visibility",
        ),
      "Only a completed pre-visibility smoke run can be resumed.",
    );
    report.groups = previous.groups;
    report.relevance = previous.relevance;
    report.durationsMs = previous.durationsMs;
    report.usage = previous.usage;
  }
  if (!resume) {
    const status = await call("/status");
    assert.equal(status.status, 200);
    assert.equal(status.result.data.deployment.capabilities.semantic, true);
    assert.equal(
      (await call("/search", { query: "router", mode: "embedding" }, "invalid"))
        .status,
      403,
    );
    assert.equal(
      (await call("/__smoke/pending", {}, state.readToken)).status,
      403,
    );
    passed("authentication-and-ready-status");

    const cases = [
      {
        topic: "garden",
        language: "en",
        query: "How do I grow fruit trees in an orchard?",
        expected: [
          "Guide/Orchard.md",
          "Guide/Seasons.md",
          "Guide/Huerto.md",
          "Guide/Fruit-ja.md",
          "Archive/Orchard.md",
        ],
      },
      {
        topic: "garden",
        language: "ja",
        query: "果物の木を育てるにはどんな土や水やりが必要ですか",
        expected: [
          "Guide/Orchard.md",
          "Guide/Seasons.md",
          "Guide/Huerto.md",
          "Guide/Fruit-ja.md",
          "Archive/Orchard.md",
        ],
      },
      {
        topic: "garden",
        language: "es",
        query: "Cómo cultivar árboles frutales y podar sus ramas",
        expected: [
          "Guide/Orchard.md",
          "Guide/Seasons.md",
          "Guide/Huerto.md",
          "Guide/Fruit-ja.md",
          "Archive/Orchard.md",
        ],
      },
      {
        topic: "network",
        language: "en",
        query:
          "Configure a router with IP addresses and DNS for internet access",
        expected: ["Guide/Network.md"],
      },
      {
        topic: "network",
        language: "ja",
        query: "IPアドレスとDNSを設定してコンピュータを接続する",
        expected: ["Guide/Network.md"],
      },
      {
        topic: "network",
        language: "es",
        query: "Configurar un enrutador con direcciones IP y servidores DNS",
        expected: ["Guide/Network.md"],
      },
      {
        topic: "astronomy",
        language: "en",
        query: "Observe distant galaxies and stars through a telescope",
        expected: ["Guide/Astronomy.md"],
      },
      {
        topic: "astronomy",
        language: "ja",
        query: "望遠鏡で夜空の星や遠い銀河を観測する方法",
        expected: ["Guide/Astronomy.md"],
      },
      {
        topic: "astronomy",
        language: "es",
        query: "Observar estrellas y galaxias lejanas con un telescopio",
        expected: ["Guide/Astronomy.md"],
      },
    ];
    let chosen: any;
    for (const mode of ["embedding", "hybrid"]) {
      for (const fixture of cases) {
        const response = await search(fixture.query, mode);
        assert.equal(response.data.usedMode, mode);
        const rank = response.data.results.findIndex((r: any) =>
          fixture.expected.includes(r.path),
        );
        assert(rank >= 0, "Expected synthetic topic missing from top three.");
        if (mode === "embedding")
          assert.equal(rank, 0, "Unexpected top-ranked semantic topic.");
        assert(response.data.results.length <= 3);
        report.relevance.push({
          topic: fixture.topic,
          language: fixture.language,
          mode,
          top1: rank === 0,
          top3: true,
          rank: rank + 1,
          durationMs: report.durationsMs.at(-1),
        });
        if (fixture.topic === "garden") chosen = response;
      }
      passed(`multilingual-${mode}-9-cases`);
    }
    for (const mode of ["lexical", "embedding", "hybrid"]) {
      const response = await search("fruit trees", mode, {
        pathPrefix: ["Guide"],
        excludePathPrefix: ["Guide/Huerto.md"],
        tags: ["garden"],
        excludeTags: ["fruit"],
        frontmatter: { type: ["guide"], status: ["active"] },
      });
      assert(
        response.data.results.every((r: any) => r.path === "Guide/Fruit-ja.md"),
      );
      if (mode !== "lexical") assert(response.data.results.length > 0);
      if (mode === "lexical") assert.equal(response.usage.attempts, 0);
    }
    const none = await search("router", "embedding", {
      tags: ["nonexistent-synthetic-tag"],
    });
    assert.equal(none.data.results.length, 0);
    assert.equal(none.usage.embeddingInputs, 0);
    passed("structured-filters-and-lexical-no-inference");

    const note = chosen.data.results[0];
    const get = await call(
      `/notes/${note.noteId}?snapshot=${chosen.revision.snapshot}`,
    );
    assert.equal(get.status, 200);
    const chunk = await call(
      `/chunks/${note.noteId}/${note.chunkIndex}?snapshot=${chosen.revision.snapshot}`,
    );
    assert.equal(chunk.status, 200);
    const changed = await call(
      `/notes/${note.noteId}?snapshot=${"0".repeat(64)}`,
    );
    assert.equal(changed.status, 409);
    passed("explicit-get-and-snapshot-pin");

    for (const stateName of ["pending", "incompatible"]) {
      await admin(stateName);
      try {
        const embedding = await call("/search", {
          query: "fruit trees",
          mode: "embedding",
        });
        assert.equal(embedding.status, 503);
        assert.equal(embedding.result.error.code, "EMBEDDING_UNAVAILABLE");
        const hybrid = await search("apple", "hybrid");
        assert.equal(hybrid.data.usedMode, "lexical");
        assert(
          hybrid.warnings.some((w: any) => w.code === "EMBEDDING_UNAVAILABLE"),
        );
        assert.equal(hybrid.usage.embeddingInputs, 0);
      } finally {
        await admin(stateName === "pending" ? "ready" : "compatible");
      }
    }
    passed("pending-and-incompatible-generation-fallback");
    assert.equal((await admin("dimension-error")).rejected, true);
    passed("hosted-vector-dimension-rejection");

    const client = new Client({
      name: "synthetic-semantic-smoke",
      version: "0.0.0",
    });
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${state.endpoint}/mcp`), {
          requestInit: {
            headers: { Authorization: `Bearer ${state.readToken}` },
          },
        }),
      );
      const tools = await client.listTools();
      assert.equal(tools.tools.length, 18);
      const rpc = await client.callTool({
        name: "search",
        arguments: {
          query: "望遠鏡で星を観測する",
          mode: "embedding",
          limit: 2,
        },
      });
      const text = (rpc.content as { type: string; text: string }[]).find(
        (c) => c.type === "text",
      )!.text;
      const payload = JSON.parse(text);
      assert.equal(payload.usedMode, "embedding");
      assert.equal(payload.results[0].path, "Guide/Astronomy.md");
      assert.equal(payload.usage.embeddingInputs, 1);
      const related = await client.callTool({
        name: "related",
        arguments: { type: "note", id: note.noteId, mode: "hybrid", limit: 3 },
      });
      const relatedPayload = JSON.parse(
        (related.content as { type: string; text: string }[]).find(
          (c) => c.type === "text",
        )!.text,
      );
      assert.equal(relatedPayload.usedMode, "hybrid");
      assert(relatedPayload.results.length <= 3);
    } finally {
      await client.close();
    }
    passed("remote-mcp-sdk-semantic-and-related");
  }

  const beforeStage = await search("router IP DNS", "embedding");
  const cycle = await admin(resume ? "visibility-probe" : "visibility-cycle");
  if (!resume)
    report.relevance.push({ kind: "asynchronous-visibility", ...cycle });
  let visibility = cycle;
  for (let attempt = 0; !visibility.ready && attempt < 12; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10000));
    visibility = await admin("visibility-probe");
  }
  assert.equal(visibility.ready, true);
  report.relevance.push({
    kind: "query-visible",
    elapsedMs: visibility.elapsedMs,
  });
  const afterStage = await search("router IP DNS", "embedding");
  assert.deepEqual(
    afterStage.data.results.map((r: any) => r.id),
    beforeStage.data.results.map((r: any) => r.id),
  );
  for (let i = 0; i < afterStage.data.results.length; i++)
    assert(
      Math.abs(
        afterStage.data.results[i].score - beforeStage.data.results[i].score,
      ) < 0.0001,
    );
  assert.deepEqual(afterStage.revision, beforeStage.revision);
  passed("real-vector-mutation-visibility-and-staged-isolation");

  const revoked = await admin("revoke");
  const afterRevoke = await search("router IP DNS", "embedding");
  assert(
    afterRevoke.data.results.every(
      (r: any) => r.noteId !== revoked.revokedNoteId,
    ),
  );
  assert.equal((await call(`/notes/${revoked.revokedNoteId}`)).status, 404);
  assert.equal((await admin("stats")).vectorCount >= 7, true);
  passed("deleted-membership-revokes-retained-vector");

  await writeFile(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(
    JSON.stringify({
      passed: true,
      groups: report.groups.length,
      relevanceCases: 18,
      usage: report.usage,
    }),
  );
} catch (error) {
  await writeFile(
    reportFile,
    JSON.stringify(
      {
        ...report,
        passed: false,
        failure: error instanceof Error ? error.name : "unknown",
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  console.error(
    JSON.stringify({
      passed: false,
      completedGroups: report.groups,
      errorType: error instanceof Error ? error.name : "unknown",
    }),
  );
  process.exitCode = 1;
}

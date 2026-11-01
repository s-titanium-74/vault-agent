// Disposable synthetic verification only; never deploy with private vault bindings.
import worker from "./remote-retention-worker.js";
import { authenticate, config, type Env } from "../src/config.js";
export default {
  async fetch(
    request: Request,
    env: Env & { SYNTHETIC_VERIFICATION?: string; TRIAL_NAME?: string },
  ) {
    const p = new URL(request.url).pathname;
    if (!p.startsWith("/__verify/")) return worker.fetch(request, env);
    if (
      env.SYNTHETIC_VERIFICATION !== "true" ||
      !/^vault-agent-trial-[a-f0-9]{10}$/.test(env.TRIAL_NAME ?? "")
    )
      return new Response(null, { status: 403 });
    try {
      if (new URL(request.url).protocol !== "https:")
        return new Response(null, { status: 403 });
      const settings = config(env);
      await authenticate(request, env, true);
      const origin = request.headers.get("Origin");
      if (origin && !settings.origins.includes(origin))
        return new Response(null, { status: 403 });
    } catch {
      return new Response(null, { status: 403 });
    }
    if (p === "/__verify/probe") {
      await env.DB.prepare("SELECT 1").first();
      await env.SOURCE.list({ prefix: env.VAULT_ID + "/source/", limit: 1 });
      return Response.json({ ok: true });
    }
    if (p === "/__verify/seed" && request.method === "POST") {
      const { start = 0, count = 10 } = (await request.json()) as {
        start?: number;
        count?: number;
      };
      if (
        !Number.isInteger(start) ||
        start < 0 ||
        start >= 100 ||
        !Number.isInteger(count) ||
        count < 1 ||
        count > 10
      )
        return new Response(null, { status: 400 });
      for (let i = start; i < Math.min(100, start + count); i++) {
        const id = String(i).padStart(4, "0"),
          next = String((i + 1) % 100).padStart(4, "0");
        const text =
          "---\ntags: [synthetic, orchard]\ntype: example\n---\n# Orchard " +
          id +
          "\n\nSynthetic apple trees and winter pruning. 日本語の合成ノート。果樹園と冬の剪定。\n\n[[Note-" +
          next +
          "]] ![chart](../images/chart.svg)\n\n## Checklist\n\n" +
          "Water the synthetic orchard. 果樹園の水やり。\n".repeat(24);
        await env.SOURCE.put(
          env.VAULT_ID + "/source/Notes/Note-" + id + ".md",
          text,
        );
      }
      await env.SOURCE.put(
        env.VAULT_ID + "/source/images/chart.svg",
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="green"/></svg>\n',
      );
      return Response.json({ notes: Math.min(100, start + count) - start });
    }
    if (p === "/__verify/change" && request.method === "POST") {
      const body = (await request.json()) as { kind: string };
      if (!["restore", "update"].includes(body.kind))
        return new Response(null, { status: 400 });
      const key = env.VAULT_ID + "/source/Notes/Note-0000.md";
      const obj = await env.SOURCE.get(key);
      if (!obj) return new Response(null, { status: 404 });
      const old = await obj.text();
      const base = old.replace(/\nSynthetic revisionmarker 改訂\.\n$/, "");
      await env.SOURCE.put(
        key,
        body.kind === "restore"
          ? base
          : base + "\nSynthetic revisionmarker 改訂.\n",
      );
      return Response.json({ ok: true });
    }
    if (p === "/__verify/telemetry") {
      const rows = await env.DB.prepare(
        "SELECT kind,wall_ms,counts FROM synthetic_telemetry",
      ).all();
      return Response.json({ rows: rows.results });
    }
    if (p === "/__verify/reset" && request.method === "POST") {
      await env.DB.prepare("DELETE FROM synthetic_telemetry").run();
      return Response.json({ ok: true });
    }
    if (p === "/__verify/purge" && request.method === "POST") {
      const list = await env.SOURCE.list({ limit: 1000 });
      if (list.objects.length)
        await env.SOURCE.delete(list.objects.map((o) => o.key));
      return Response.json({
        removed: list.objects.length,
        bytes: list.objects.reduce((n, o) => n + o.size, 0),
      });
    }
    return new Response(null, { status: 404 });
  },
  scheduled: worker.scheduled,
};

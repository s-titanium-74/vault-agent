// Internal synthetic capability harness. Never deploy this entry point.
import worker from "../src/index.js";
import { config, authenticate, type Env } from "../src/config.js";
import { CloudError, boundedBytes } from "../src/errors.js";
import { R2MutationService, R2MutationInterruption } from "../src/mutations.js";
import { RetrievalService } from "../src/service.js";
import { tick } from "../src/ingestion.js";
export default {
  async fetch(request: Request, env: Env) {
    const route = new URL(request.url).pathname;
    if (route === "/__tick") {
      await tick(env, () => {});
      return Response.json({ ok: true });
    }
    if (route !== "/__mutations") return worker.fetch(request, env);
    try {
      config(env);
      await authenticate(request, env, true);
      const args = JSON.parse(
        new TextDecoder().decode(
          await boundedBytes(request.body!, 32 * 1024 * 1024),
        ),
      );
      const now = args.now ?? Date.now();
      if (args.adminToken) env = { ...env, ADMIN_TOKEN: args.adminToken };
      if (args.vaultId) env = { ...env, VAULT_ID: args.vaultId };
      if (args.provider === "pcloud")
        env = {
          ...env,
          SOURCE_PROVIDER: "pcloud",
          PCLOUD_REGION: "us",
          PCLOUD_FOLDER_ID: "1",
          PCLOUD_ACCESS_TOKEN: env.ADMIN_TOKEN,
        };
      if (args.conditional_race) {
        env = {
          ...env,
          SOURCE: new Proxy(env.SOURCE!, {
            get(target, key) {
              if (key === "put")
                return async (
                  name: string,
                  bytes: Uint8Array,
                  options?: R2PutOptions,
                ) => {
                  if (options?.customMetadata?.mutation)
                    await target.put(name, "external conditional race");
                  return target.put(name, bytes, options);
                };
              const value = Reflect.get(target, key);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        };
      }
      const service = await R2MutationService.open(env, {
        settings: { enabled: true, ...args.settings },
        now: () => now,
        async checkpoint(phase) {
          if (phase === "committing" && args.generation_race)
            await env.SOURCE!.put(
              `${env.VAULT_ID}/source/${args.generation_race}`,
              args.generation_content ?? "external generation race",
            );
          if (args.interrupt === phase) throw new R2MutationInterruption();
        },
      });
      let data: unknown;
      if (args.action === "preview")
        data = await service.preview(args.input, args.preview !== false);
      else if (args.action === "apply")
        data = await service.apply(args.id, args.input, args.binding);
      else if (args.action === "status") data = await service.status(args.id);
      else if (args.action === "recover") data = await service.recover();
      else if (args.action === "cleanup") data = await service.cleanup();
      else if (args.action === "read") {
        const source = await service.read(args.path, true);
        data = source
          ? { version: source.version, content: source.content }
          : null;
      } else if (args.action === "read-race") {
        const read = await RetrievalService.open(env);
        const op = await service.preview(args.input);
        await service.apply(op.operation_id, args.input, op.preview_binding);
        data = await read.invoke("search", {
          query: "synthetic",
          mode: "lexical",
        });
      }
      return Response.json({ data });
    } catch (error) {
      return Response.json(
        {
          error: {
            code:
              error instanceof CloudError
                ? error.code
                : error instanceof R2MutationInterruption
                  ? "INTERRUPTED"
                  : "INTERNAL_ERROR",
          },
        },
        { status: error instanceof CloudError ? error.status : 500 },
      );
    }
  },
};

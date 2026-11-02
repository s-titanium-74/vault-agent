// Synthetic fault injection only. Never deploy this entry point.
import worker from "../src/index.js";
import type { Env } from "../src/config.js";
import { contentRevision } from "@vault-agent/core/portable";

export default {
  async fetch(request: Request, env: Env) {
    let interrupted = false;
    const mode = request.headers.get("X-Synthetic-Upload-Fault");
    const db = env.DB;
    if (mode) {
      env = {
        ...env,
        DB: new Proxy(db, {
          get(target, key) {
            if (key === "batch")
              return async (statements: D1PreparedStatement[]) => {
                if (interrupted) throw new Error("synthetic-interruption");
                return target.batch(statements);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
        SOURCE: new Proxy(env.SOURCE!, {
          get(target, key) {
            if (key === "put")
              return async (
                name: string,
                value: ReadableStream | Uint8Array,
                options?: R2PutOptions,
              ) => {
                if (options?.customMetadata?.upload) {
                  if (mode === "before-put") {
                    interrupted = true;
                    if (value instanceof ReadableStream) await value.cancel();
                    throw new Error("synthetic-interruption");
                  }
                  if (mode === "racing-edit")
                    await target.put(name, "# Synthetic\nlate cloud edit\n");
                  const result = await target.put(name, value, options);
                  if (mode === "newer-ack") {
                    const text = "# Synthetic\nnewer acknowledged upload\n";
                    await target.put(name, text);
                    await db
                      .prepare(
                        "UPDATE upload_baselines SET digest=?,job='synthetic-newer-owner' WHERE path=?",
                      )
                      .bind(
                        await contentRevision(text),
                        name.slice(`${env.VAULT_ID}/source/`.length),
                      )
                      .run();
                  }
                  if (mode === "after-put") {
                    interrupted = true;
                    throw new Error("synthetic-interruption");
                  }
                  return result;
                }
                return target.put(name, value, options);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        }),
      };
    }
    return worker.fetch(request, env);
  },
};

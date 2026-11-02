import {
  authorizeBearer,
  validRoleCredentials,
} from "@vault-agent/core/access";
import type { SubtleCrypto as WorkersSubtleCrypto } from "@cloudflare/workers-types";
import { sourcePolicy } from "@vault-agent/core/portable";
import { CloudError } from "./errors.js";
import { MODEL } from "./provider.js";
// Wrangler emits the legacy VectorizeIndex name when runtime declarations are
// omitted. Use the installed platform's V2 type for the generated binding.
export type Env = Omit<Cloudflare.Env, "VECTORS" | "SOURCE"> & {
  VECTORS?: Vectorize;
  SOURCE?: R2Bucket;
  SOURCE_PROVIDER?: "r2" | "pcloud";
  PCLOUD_REGION?: "us" | "eu";
  PCLOUD_FOLDER_ID?: string;
  PCLOUD_ACCESS_TOKEN?: string;
  READ_TOKEN: string;
  ADMIN_TOKEN: string;
  PREVIOUS_READ_TOKEN?: string;
  PREVIOUS_ADMIN_TOKEN?: string;
};
function strings(value: string): string[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed) || parsed.some((v) => typeof v !== "string"))
    throw new CloudError("CONFIG_INVALID", 503);
  return parsed;
}
export function config(env: Env) {
  try {
    if (
      !env.DB ||
      (env.SOURCE_PROVIDER !== "pcloud" && !env.SOURCE) ||
      (env.SOURCE_PROVIDER !== undefined &&
        !["r2", "pcloud"].includes(env.SOURCE_PROVIDER)) ||
      (env.SOURCE_PROVIDER === "pcloud" &&
        (!/^[0-9]+$/.test(env.PCLOUD_FOLDER_ID ?? "") ||
          !["us", "eu"].includes(env.PCLOUD_REGION ?? "") ||
          !env.PCLOUD_ACCESS_TOKEN)) ||
      !env.REQUEST_LIMITER ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
        env.VAULT_ID,
      ) ||
      !/^[a-f0-9]{64}$/.test(env.READ_TOKEN ?? "") ||
      !/^[a-f0-9]{64}$/.test(env.ADMIN_TOKEN ?? "") ||
      env.READ_TOKEN === env.ADMIN_TOKEN
    )
      throw new Error();
    for (const previous of [env.PREVIOUS_READ_TOKEN, env.PREVIOUS_ADMIN_TOKEN])
      if (previous !== undefined && !/^[a-f0-9]{64}$/.test(previous))
        throw new Error();
    if (
      !validRoleCredentials({
        read: [env.READ_TOKEN, env.PREVIOUS_READ_TOKEN].filter(
          (v): v is string => v !== undefined,
        ),
        admin: [env.ADMIN_TOKEN, env.PREVIOUS_ADMIN_TOKEN].filter(
          (v): v is string => v !== undefined,
        ),
      })
    )
      throw new Error();
    if (
      env.INGESTION_ENABLED !== undefined &&
      !["true", "false"].includes(String(env.INGESTION_ENABLED))
    )
      throw new Error();
    const includes = strings(env.INCLUDE_PATHS);
    if (!includes.length) throw new Error();
    const origins = strings(env.ALLOWED_ORIGINS);
    if (
      origins.some((o) => new URL(o).origin !== o || !o.startsWith("https://"))
    )
      throw new Error();
    const allowlist = strings(env.PROFILE_VALUE_ALLOWLIST);
    if (allowlist.some((v) => !["type", "status"].includes(v)))
      throw new Error();
    if (
      env.EXTERNAL_EMBEDDING_CONSENT !== undefined &&
      !["true", "false"].includes(env.EXTERNAL_EMBEDDING_CONSENT)
    )
      throw new Error();
    const semantic = String(env.EXTERNAL_EMBEDDING_CONSENT) === "true";
    if (
      semantic &&
      (!env.AI ||
        !env.VECTORS ||
        env.EMBEDDING_MODEL !== MODEL ||
        typeof env.EMBEDDING_MODEL_REVISION !== "string" ||
        !/^[A-Za-z0-9._-]{1,64}$/.test(env.EMBEDDING_MODEL_REVISION))
    )
      throw new Error();
    return {
      semantic,
      allowed: sourcePolicy(includes, strings(env.EXCLUDE_PATHS)),
      origins,
      profiles: { frontmatter_value_allowlist: allowlist },
    };
  } catch {
    throw new CloudError("CONFIG_INVALID", 503);
  }
}
export async function authenticate(request: Request, env: Env, admin: boolean) {
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const subtle = crypto.subtle as WorkersSubtleCrypto;
  const failure = await authorizeBearer(
    request.headers.get("Authorization"),
    {
      read: [env.READ_TOKEN, env.PREVIOUS_READ_TOKEN].filter(
        (v): v is string => v !== undefined,
      ),
      admin: [env.ADMIN_TOKEN, env.PREVIOUS_ADMIN_TOKEN].filter(
        (v): v is string => v !== undefined,
      ),
    },
    admin ? "admin" : "read",
    async (incoming, expected) => {
      const [a, b] = await Promise.all([digest(incoming), digest(expected)]);
      return subtle.timingSafeEqual(a, b);
    },
  );
  if (failure)
    throw new CloudError(failure, failure === "AUTH_REQUIRED" ? 401 : 403);
}

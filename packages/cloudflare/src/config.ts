import {
  authorizeBearer,
  validRoleCredentials,
} from "@vault-agent/core/access";
import type { SubtleCrypto as WorkersSubtleCrypto } from "@cloudflare/workers-types";
import {
  sourcePolicy,
  mutationSettingsSchema,
} from "@vault-agent/core/portable";
import { CloudError } from "./errors.js";
import { MODEL } from "./provider.js";
// Wrangler emits the legacy VectorizeIndex name when runtime declarations are
// omitted. Use the installed platform's V2 type for the generated binding.
export type Env = Omit<
  Cloudflare.Env,
  | "VECTORS"
  | "SOURCE"
  | "WRITE_ENABLED"
  | "WRITE_MODE"
  | "WRITE_MAX_FILE_BYTES"
  | "WRITE_MAX_BATCH_BYTES"
  | "WRITE_MAX_BATCH_OPERATIONS"
  | "WRITE_HISTORY_RETENTION_DAYS"
> & {
  VECTORS?: Vectorize;
  SOURCE?: R2Bucket;
  SOURCE_PROVIDER?: "r2" | "pcloud";
  PCLOUD_REGION?: "us" | "eu";
  PCLOUD_FOLDER_ID?: string;
  PCLOUD_ACCESS_TOKEN?: string;
  READ_TOKEN: string;
  ADMIN_TOKEN: string;
  READWRITE_TOKEN?: string;
  PREVIOUS_READWRITE_TOKEN?: string;
  PREVIOUS_READ_TOKEN?: string;
  PREVIOUS_ADMIN_TOKEN?: string;
  WRITE_ENABLED?: string;
  WRITE_MODE?: string;
  WRITE_MAX_FILE_BYTES?: string;
  WRITE_MAX_BATCH_BYTES?: string;
  WRITE_MAX_BATCH_OPERATIONS?: string;
  WRITE_HISTORY_RETENTION_DAYS?: string;
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
    for (const previous of [
      env.PREVIOUS_READ_TOKEN,
      env.PREVIOUS_ADMIN_TOKEN,
      env.READWRITE_TOKEN,
      env.PREVIOUS_READWRITE_TOKEN,
    ])
      if (previous !== undefined && !/^[a-f0-9]{64}$/.test(previous))
        throw new Error();
    if (
      env.PREVIOUS_READWRITE_TOKEN !== undefined &&
      env.READWRITE_TOKEN === undefined
    )
      throw new Error();
    if (
      !validRoleCredentials({
        read: [env.READ_TOKEN, env.PREVIOUS_READ_TOKEN].filter(
          (v): v is string => v !== undefined,
        ),
        readwrite: [env.READWRITE_TOKEN, env.PREVIOUS_READWRITE_TOKEN].filter(
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
    const write = writeSettings(env);
    if (
      write.enabled &&
      (String(env.INGESTION_ENABLED) !== "true" ||
        (env.SOURCE_PROVIDER === "pcloud" && write.mode !== "review"))
    )
      throw new Error();
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
      write,
      allowed: sourcePolicy(includes, strings(env.EXCLUDE_PATHS)),
      origins,
      profiles: { frontmatter_value_allowlist: allowlist },
    };
  } catch {
    throw new CloudError("CONFIG_INVALID", 503);
  }
}
export function writeSettings(env: Env) {
  if (
    env.WRITE_ENABLED !== undefined &&
    !["true", "false"].includes(env.WRITE_ENABLED)
  )
    throw new CloudError("CONFIG_INVALID", 503);
  const numeric: Record<string, number> = {};
  for (const [key, value] of Object.entries({
    max_file_bytes: env.WRITE_MAX_FILE_BYTES,
    max_batch_bytes: env.WRITE_MAX_BATCH_BYTES,
    max_batch_operations: env.WRITE_MAX_BATCH_OPERATIONS,
    history_retention_days: env.WRITE_HISTORY_RETENTION_DAYS,
  })) {
    if (value === undefined) continue;
    if (!/^[1-9][0-9]*$/.test(value))
      throw new CloudError("CONFIG_INVALID", 503);
    numeric[key] = Number(value);
  }
  const parsed = mutationSettingsSchema.safeParse({
    ...numeric,
    enabled: env.WRITE_ENABLED === "true",
    ...(env.WRITE_MODE === undefined ? {} : { mode: env.WRITE_MODE }),
  });
  if (!parsed.success || parsed.data.max_batch_bytes > 20 * 1024 * 1024)
    throw new CloudError("CONFIG_INVALID", 503);
  return parsed.data;
}
export async function authenticate(request: Request, env: Env, admin: boolean) {
  let matchedAdmin = false;
  let matchedReadwrite = false;
  const adminKeys = [env.ADMIN_TOKEN, env.PREVIOUS_ADMIN_TOKEN].filter(
    (v): v is string => v !== undefined,
  );
  const digest = (value: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const subtle = crypto.subtle as WorkersSubtleCrypto;
  const failure = await authorizeBearer(
    request.headers.get("Authorization"),
    {
      read: [env.READ_TOKEN, env.PREVIOUS_READ_TOKEN].filter(
        (v): v is string => v !== undefined,
      ),
      readwrite: [env.READWRITE_TOKEN, env.PREVIOUS_READWRITE_TOKEN].filter(
        (v): v is string => v !== undefined,
      ),
      admin: [env.ADMIN_TOKEN, env.PREVIOUS_ADMIN_TOKEN].filter(
        (v): v is string => v !== undefined,
      ),
    },
    admin ? "admin" : "read",
    async (incoming, expected) => {
      const [a, b] = await Promise.all([digest(incoming), digest(expected)]);
      const matches = subtle.timingSafeEqual(a, b);
      if (matches && adminKeys.includes(expected)) matchedAdmin = true;
      if (
        matches &&
        [env.READWRITE_TOKEN, env.PREVIOUS_READWRITE_TOKEN].includes(expected)
      )
        matchedReadwrite = true;
      return matches;
    },
  );
  if (failure)
    throw new CloudError(failure, failure === "AUTH_REQUIRED" ? 401 : 403);
  return matchedAdmin
    ? ("admin" as const)
    : matchedReadwrite
      ? ("readwrite" as const)
      : ("read" as const);
}

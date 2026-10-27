import type { IndexStore } from "./index-store.js";
import type { Config } from "./config.js";
import type { FreshnessMachine } from "./freshness.js";
import * as shared from "./profile-shared.js";
export interface ProfileContext {
  store: IndexStore;
  config: Config;
  freshnessMachine?: FreshnessMachine | null;
}
export function getMetadataProfile(
  ctx: ProfileContext,
  ...args: Parameters<typeof shared.getMetadataProfile> extends [
    unknown,
    ...infer A,
  ]
    ? A
    : never
) {
  return shared.getMetadataProfile(
    { ...ctx, compatibility: ctx.store.checkStaleness(ctx.config) },
    ...args,
  );
}
export function getStyleProfile(
  ctx: ProfileContext,
  ...args: Parameters<typeof shared.getStyleProfile> extends [
    unknown,
    ...infer A,
  ]
    ? A
    : never
) {
  return shared.getStyleProfile(
    { ...ctx, compatibility: ctx.store.checkStaleness(ctx.config) },
    ...args,
  );
}

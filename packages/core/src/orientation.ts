import type { IndexStore } from "./index-store.js";
import type { Config } from "./config.js";
import type { FreshnessMachine } from "./freshness.js";
import * as shared from "./orientation-shared.js";
export interface OrientationContext {
  store: IndexStore;
  config: Config;
  freshnessMachine?: FreshnessMachine | null;
}
export function getOverview(
  ctx: OrientationContext,
  ...args: Parameters<typeof shared.getOverview> extends [unknown, ...infer A]
    ? A
    : never
) {
  return shared.getOverview(
    { ...ctx, compatibility: ctx.store.checkStaleness(ctx.config) },
    ...args,
  );
}
export function getTree(
  ctx: OrientationContext,
  ...args: Parameters<typeof shared.getTree> extends [unknown, ...infer A]
    ? A
    : never
) {
  return shared.getTree(
    { ...ctx, compatibility: ctx.store.checkStaleness(ctx.config) },
    ...args,
  );
}
export function getTags(
  ctx: OrientationContext,
  ...args: Parameters<typeof shared.getTags> extends [unknown, ...infer A]
    ? A
    : never
) {
  return shared.getTags(
    { ...ctx, compatibility: ctx.store.checkStaleness(ctx.config) },
    ...args,
  );
}
export function getFacets(
  ctx: OrientationContext,
  ...args: Parameters<typeof shared.getFacets> extends [unknown, ...infer A]
    ? A
    : never
) {
  return shared.getFacets(
    { ...ctx, compatibility: ctx.store.checkStaleness(ctx.config) },
    ...args,
  );
}

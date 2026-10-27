import type { IndexStore } from "./index-store.js";
import type { Config } from "./config.js";
import type { FreshnessMachine } from "./freshness.js";
import * as shared from "./link-graph-shared.js";
export interface LinkGraphContext {
  store: IndexStore;
  config: Config;
  freshnessMachine?: FreshnessMachine | null;
}
export function getNoteLinks(
  ctx: LinkGraphContext,
  ...args: Parameters<typeof shared.getNoteLinks> extends [unknown, ...infer A]
    ? A
    : never
) {
  return shared.getNoteLinks(
    { ...ctx, compatibility: ctx.store.checkStaleness(ctx.config) },
    ...args,
  );
}
export function getBacklinks(
  ctx: LinkGraphContext,
  ...args: Parameters<typeof shared.getBacklinks> extends [unknown, ...infer A]
    ? A
    : never
) {
  return shared.getBacklinks(
    { ...ctx, compatibility: ctx.store.checkStaleness(ctx.config) },
    ...args,
  );
}
export function getBrokenLinks(
  ctx: LinkGraphContext,
  ...args: Parameters<typeof shared.getBrokenLinks> extends [
    unknown,
    ...infer A,
  ]
    ? A
    : never
) {
  return shared.getBrokenLinks(
    { ...ctx, compatibility: ctx.store.checkStaleness(ctx.config) },
    ...args,
  );
}
export function getOrphanNotes(
  ctx: LinkGraphContext,
  ...args: Parameters<typeof shared.getOrphanNotes> extends [
    unknown,
    ...infer A,
  ]
    ? A
    : never
) {
  return shared.getOrphanNotes(
    { ...ctx, compatibility: ctx.store.checkStaleness(ctx.config) },
    ...args,
  );
}
export function getLinkSummary(
  ctx: LinkGraphContext,
  ...args: Parameters<typeof shared.getLinkSummary> extends [
    unknown,
    ...infer A,
  ]
    ? A
    : never
) {
  return shared.getLinkSummary(
    { ...ctx, compatibility: ctx.store.checkStaleness(ctx.config) },
    ...args,
  );
}
export type { LinkGraphParams } from "./link-graph-shared.js";

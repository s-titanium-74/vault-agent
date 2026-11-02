import type { Config } from "../config.js";
import type { IndexStore } from "../index-store.js";
import { getNote as localNote } from "../retrieval.js";
import { getNote as sourceNote } from "../portable/retrieval.js";
import { SqliteMetadataStore } from "./sqlite.js";
import { configuredVaultIdentity, pcloudSource } from "./source.js";
export async function getConfiguredNote(
  store: IndexStore,
  id: string,
  config: Config,
  allowLarge?: boolean,
) {
  if (!config.vault.pcloud)
    return localNote(store, id, config.vault.root, allowLarge);
  return sourceNote(
    new SqliteMetadataStore(store, configuredVaultIdentity(config)),
    pcloudSource(config),
    id,
    { allowLarge },
  );
}

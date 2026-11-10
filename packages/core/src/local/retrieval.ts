import type { Config } from "../config.js";
import { getIndexPath, type IndexStore } from "../index-store.js";
import { getContentType, getNote as localNote } from "../retrieval.js";
import { SourceError } from "../portable/source-policy.js";
import { MutationReadState } from "./mutation-state.js";
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

export async function getPCloudAttachment(
  config: Config,
  path: string,
  download: boolean,
  allowLarge: boolean,
) {
  const journal = new MutationReadState(getIndexPath(config));
  try {
    const before = journal.get(path);
    if (before?.blocked) throw new SourceError("SOURCE_UNAVAILABLE");
    const result = await pcloudSource(config).getAttachment(
      path,
      download,
      allowLarge,
    );
    const after = journal.get(path);
    if (after?.blocked || before?.sequence !== after?.sequence)
      throw new SourceError("SOURCE_REVISION_MISMATCH");
    return (
      result && {
        ...result,
        metadata: { ...result.metadata, contentType: getContentType(path) },
      }
    );
  } finally {
    journal.close();
  }
}

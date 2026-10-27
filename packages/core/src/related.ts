import type { IndexStore } from "./index-store.js";
import type { Config } from "./config.js";
import type { EmbeddingProvider } from "./embedding.js";
import type { SearchMode } from "./schemas.js";
import { getRelated as portableRelated } from "./portable/related.js";
import { localRetrievalContext } from "./local/sqlite.js";
export async function getRelated(
  store: IndexStore,
  type: "note" | "chunk",
  id: string,
  mode: SearchMode | undefined,
  limit: number,
  config: Config,
  embeddingProvider?: EmbeddingProvider,
) {
  return portableRelated(
    localRetrievalContext(store, config, embeddingProvider),
    type,
    id,
    mode,
    limit,
  );
}

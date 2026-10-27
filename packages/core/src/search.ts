import type { IndexStore } from "./index-store.js";
import type { Config } from "./config.js";
import type { EmbeddingProvider } from "./embedding.js";
import type { SearchMode, SearchFiltersInput } from "./schemas.js";
import { search as portableSearch } from "./portable/search.js";
import { localRetrievalContext } from "./local/sqlite.js";
export async function search(
  store: IndexStore,
  query: string,
  mode: SearchMode | undefined,
  limit: number,
  config: Config,
  embeddingProvider?: EmbeddingProvider,
  filters?: SearchFiltersInput,
) {
  return portableSearch(
    localRetrievalContext(store, config, embeddingProvider),
    query,
    mode,
    limit,
    filters,
  );
}

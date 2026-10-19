// Browsers: the caching tessellator with stores in memory and in IndexedDB.

export {
  CachedTessellator, cacheKey, decodeEntry, encodeEntry, isFailure, keyPrefix,
  type CachedTessellatorOptions, type CacheEntry, type CacheStats, type CacheStore,
} from './cache.ts';
export { DEFAULT_MEMORY_BYTES, MemoryStore } from './memory.ts';
export { DEFAULT_INDEXEDDB_BYTES, IndexedDbStore, type IndexedDbStoreOptions } from './indexeddb.ts';

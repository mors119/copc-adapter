export type NodePointLoader<TValue> = (nodeKey: string) => Promise<TValue>;

export type NodePointCacheDiagnostics = {
  cacheByteBudget: number;
  currentCacheBytes: number;
  cachedNodeCount: number;
  hits: number;
  misses: number;
  evictionCount: number;
  bytesEvicted: number;
  largestCachedEntryBytes: number;
};

export type NodePointCache<TValue> = {
  load(nodeKey: string): Promise<TValue>;
  delete(nodeKey: string): void;
  has(nodeKey: string): boolean;
  getSize(): number;
  setRequiredNodeKeys(nodeKeys: Iterable<string>): void;
  getDiagnostics(): NodePointCacheDiagnostics;
  clear(): void;
};

export type NodePointCacheOptions<TValue = unknown> = {
  maxEntries: number;
  /** Maximum retained decoded CPU point-buffer bytes. Defaults to no byte cap. */
  maxBytes?: number;
  /** Estimates the bytes owned by a resolved cache value. */
  estimateBytes?: (value: TValue) => number;
};

const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER;

type CacheEntry<TValue> = {
  value: Promise<TValue>;
  bytes: number;
};

function validateMaxEntries(maxEntries: number): void {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError(
      'Node point cache maxEntries must be a positive integer',
    );
  }
}

function normalizeByteBudget(maxBytes: number | undefined): number {
  if (maxBytes === undefined) {
    return Number.POSITIVE_INFINITY;
  }

  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError(
      'Node point cache maxBytes must be a non-negative safe integer',
    );
  }

  return maxBytes;
}

function saturatingAdd(current: number, increment: number): number {
  if (!Number.isFinite(increment) || increment >= MAX_SAFE_COUNTER) {
    return MAX_SAFE_COUNTER;
  }

  return Math.min(MAX_SAFE_COUNTER, current + Math.max(0, increment));
}

function normalizeByteCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return value === Number.POSITIVE_INFINITY ? MAX_SAFE_COUNTER : 0;
  }

  return Math.min(MAX_SAFE_COUNTER, Math.floor(value));
}

function touchEntry<TValue>(
  cache: Map<string, CacheEntry<TValue>>,
  nodeKey: string,
  entry: CacheEntry<TValue>,
): void {
  cache.delete(nodeKey);
  cache.set(nodeKey, entry);
}

/**
 * Estimate recursively reachable typed-array storage without claiming to
 * measure Cesium, WebGL, browser, or other runtime allocations.
 */
export function estimateDecodedCpuPointBufferBytes(value: unknown): number {
  const visited = new Set<object>();

  const visit = (candidate: unknown): number => {
    if (candidate === null || typeof candidate !== 'object') {
      return 0;
    }

    if (ArrayBuffer.isView(candidate)) {
      const byteLength = (candidate as { byteLength?: unknown }).byteLength;
      return typeof byteLength === 'number'
        ? normalizeByteCount(byteLength)
        : 0;
    }

    if (visited.has(candidate)) {
      return 0;
    }
    visited.add(candidate);

    let total = 0;
    for (const child of Object.values(candidate)) {
      total = saturatingAdd(total, visit(child));
    }
    return total;
  };

  return visit(value);
}

export function createNodePointCache<TValue>(
  loader: NodePointLoader<TValue>,
  options: NodePointCacheOptions<TValue>,
): NodePointCache<TValue> {
  validateMaxEntries(options.maxEntries);
  const maxBytes = normalizeByteBudget(options.maxBytes);
  const estimateBytes = options.estimateBytes
    ?? estimateDecodedCpuPointBufferBytes;
  const cache = new Map<string, CacheEntry<TValue>>();
  const requiredNodeKeys = new Set<string>();
  let currentCacheBytes = 0;
  let hits = 0;
  let misses = 0;
  let evictionCount = 0;
  let bytesEvicted = 0;

  const removeEntry = (nodeKey: string, countAsEviction = false): boolean => {
    const entry = cache.get(nodeKey);
    if (!entry) {
      return false;
    }

    cache.delete(nodeKey);
    currentCacheBytes = Math.max(0, currentCacheBytes - entry.bytes);
    if (countAsEviction) {
      evictionCount = saturatingAdd(evictionCount, 1);
      bytesEvicted = saturatingAdd(bytesEvicted, entry.bytes);
    }
    return true;
  };

  const evictIfNeeded = (): void => {
    while (cache.size > options.maxEntries || currentCacheBytes > maxBytes) {
      const leastRecentlyUsedKey = [...cache.keys()]
        .find((nodeKey) => !requiredNodeKeys.has(nodeKey));

      // All retained entries may be required for the current render. Keep
      // them, including a single entry larger than the configured budget.
      if (leastRecentlyUsedKey === undefined) {
        break;
      }

      removeEntry(leastRecentlyUsedKey, true);
    }
  };

  return {
    load(nodeKey: string): Promise<TValue> {
      const cached = cache.get(nodeKey);

      if (cached) {
        hits = saturatingAdd(hits, 1);
        touchEntry(cache, nodeKey, cached);
        return cached.value;
      }

      misses = saturatingAdd(misses, 1);
      const entry = {} as CacheEntry<TValue>;
      const pending = Promise.resolve()
        .then(() => loader(nodeKey))
        .then((value) => {
          // A pending request can have been evicted before it resolves. In
          // that case its result remains usable by the caller but is not
          // reinserted into the cache or its byte counters.
          if (cache.get(nodeKey) === entry) {
            entry.bytes = normalizeByteCount(estimateBytes(value));
            currentCacheBytes = saturatingAdd(currentCacheBytes, entry.bytes);
            evictIfNeeded();
          }
          return value;
        })
        .catch((error: unknown) => {
          removeEntry(nodeKey);
          throw error;
        });
      entry.value = pending;
      entry.bytes = 0;
      cache.set(nodeKey, entry);
      evictIfNeeded();

      return pending;
    },
    delete(nodeKey: string): void {
      removeEntry(nodeKey);
    },
    has(nodeKey: string): boolean {
      return cache.has(nodeKey);
    },
    getSize(): number {
      return cache.size;
    },
    setRequiredNodeKeys(nodeKeys: Iterable<string>): void {
      requiredNodeKeys.clear();
      for (const nodeKey of nodeKeys) {
        requiredNodeKeys.add(nodeKey);
      }
      evictIfNeeded();
    },
    getDiagnostics(): NodePointCacheDiagnostics {
      let largestCachedEntryBytes = 0;
      for (const entry of cache.values()) {
        largestCachedEntryBytes = Math.max(largestCachedEntryBytes, entry.bytes);
      }

      return {
        cacheByteBudget: maxBytes,
        currentCacheBytes,
        cachedNodeCount: cache.size,
        hits,
        misses,
        evictionCount,
        bytesEvicted,
        largestCachedEntryBytes,
      };
    },
    clear(): void {
      cache.clear();
      requiredNodeKeys.clear();
      currentCacheBytes = 0;
      hits = 0;
      misses = 0;
      evictionCount = 0;
      bytesEvicted = 0;
    },
  };
}

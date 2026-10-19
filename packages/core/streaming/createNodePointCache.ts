/** Asynchronous loader for one hierarchy node's decoded point value. */
export type NodePointLoadPurpose = 'current' | 'prefetch';

export type NodePointLoader<TValue> = (
  nodeKey: string,
  signal: AbortSignal,
  purpose?: NodePointLoadPurpose,
) => Promise<TValue>;

/** CPU-side cache occupancy and access counters; GPU allocations are excluded. */
export type NodePointCacheDiagnostics = {
  /** Configured retained-value budget in bytes; `Infinity` means no byte cap. */
  cacheByteBudget: number;
  /** Estimated bytes currently retained by resolved values. */
  currentCacheBytes: number;
  /** Resolved node values currently retained. */
  cachedNodeCount: number;
  /** Reads served from the cache without invoking the loader. */
  hits: number;
  /** Reads that created a loader operation. */
  misses: number;
  /** Resolved entries evicted for entry-count or byte-budget pressure. */
  evictionCount: number;
  /** Estimated retained bytes removed by eviction. */
  bytesEvicted: number;
  /** Largest resolved entry retained since the cache was created, in bytes. */
  largestCachedEntryBytes: number;
  /** Resolved prefetched values later reused by the current view. */
  prefetchUsefulHitCount: number;
  /** Resolved prefetched values evicted before the current view used them. */
  prefetchEvictedUnusedCount: number;
};

/** Read and cancellation operations exposed by one node point cache. */
export type NodePointCache<TValue> = {
  /** Load a node once, sharing pending work for duplicate reads of its key. */
  load(nodeKey: string, purpose?: NodePointLoadPurpose): Promise<TValue>;
  /** Return a resolved value without changing cache recency. */
  get(nodeKey: string): TValue | undefined;
  /** Remove a resolved or pending entry. */
  delete(nodeKey: string): void;
  /** Return whether a resolved or pending entry exists. */
  has(nodeKey: string): boolean;
  /** Return the number of resolved and pending cache entries. */
  getSize(): number;
  /** Protect selected nodes from eviction while the current view uses them. */
  setRequiredNodeKeys(nodeKeys: Iterable<string>): void;
  /** Abort and evict in-flight entries so a later generation can retry them. */
  cancelPending(reason?: 'superseded' | 'lifecycle'): void;
  /** Keep in-flight entries that remain selected in the replacement view. */
  cancelPendingExcept(
    nodeKeys: Iterable<string>,
    reason?: 'superseded' | 'lifecycle',
  ): void;
  /** Abort pending current-view entries outside the next selection, retaining speculative work. */
  cancelPendingCurrentExcept(
    nodeKeys: Iterable<string>,
    reason?: 'superseded' | 'lifecycle',
  ): void;
  /** Return a detached counter snapshot. */
  getDiagnostics(): NodePointCacheDiagnostics;
  /** Cancel pending work and release all retained values. */
  clear(): void;
};

/** Entry-count, byte-budget, and value-size policy for a node point cache. */
export type NodePointCacheOptions<TValue = unknown> = {
  /** Maximum resolved and pending node entries; must be a positive integer. */
  maxEntries: number;
  /** Maximum retained decoded CPU point-buffer bytes. Defaults to no byte cap. */
  maxBytes?: number;
  /** Estimate retained bytes for a resolved value; defaults to reachable typed-array storage. */
  estimateBytes?: (value: TValue) => number;
};

const MAX_SAFE_COUNTER = Number.MAX_SAFE_INTEGER;

type CacheEntry<TValue> = {
  value: Promise<TValue>;
  bytes: number;
  resolved?: TValue;
  controller: AbortController;
  pending: boolean;
  purpose: NodePointLoadPurpose;
  wasPrefetched: boolean;
  prefetchedValueUsed: boolean;
  prefetchUsefulHitRecorded: boolean;
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

    if (visited.has(candidate)) {
      return 0;
    }
    visited.add(candidate);

    if (ArrayBuffer.isView(candidate)) {
      const byteLength = (candidate as { byteLength?: unknown }).byteLength;
      return typeof byteLength === 'number'
        ? normalizeByteCount(byteLength)
        : 0;
    }

    let total = 0;
    for (const child of Object.values(candidate)) {
      total = saturatingAdd(total, visit(child));
    }
    return total;
  };

  return visit(value);
}

/**
 * Create an LRU cache that shares in-flight node loads and bounds retained CPU data.
 *
 * Entries required by the active view are protected from eviction. If all
 * entries are required, the cache may temporarily exceed `maxEntries` or
 * `maxBytes` until the required-key set changes.
 *
 * @param loader Loads decoded/prepared data for a hierarchy node.
 * @param options Entry limit, optional byte budget, and optional size estimator.
 * @returns Cache operations and detached occupancy diagnostics.
 * @throws `RangeError` when configured entry or byte limits are invalid.
 */
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
  let prefetchUsefulHitCount = 0;
  let prefetchEvictedUnusedCount = 0;

  const removeEntry = (
    nodeKey: string,
    countAsEviction = false,
    expectedEntry?: CacheEntry<TValue>,
  ): boolean => {
    const entry = cache.get(nodeKey);
    if (!entry || expectedEntry && entry !== expectedEntry) {
      return false;
    }

    cache.delete(nodeKey);
    currentCacheBytes = Math.max(0, currentCacheBytes - entry.bytes);
    if (countAsEviction) {
      evictionCount = saturatingAdd(evictionCount, 1);
      bytesEvicted = saturatingAdd(bytesEvicted, entry.bytes);
      if (entry.wasPrefetched && !entry.prefetchedValueUsed && entry.resolved !== undefined) {
        prefetchEvictedUnusedCount = saturatingAdd(prefetchEvictedUnusedCount, 1);
      }
    }
    return true;
  };

  const evictIfNeeded = (): void => {
    while (cache.size > options.maxEntries || currentCacheBytes > maxBytes) {
      const leastRecentlyUsedKey = [...cache.entries()]
        .find(([nodeKey, entry]) => !requiredNodeKeys.has(nodeKey)
          && entry.purpose === 'prefetch')?.[0]
        ?? [...cache.keys()].find((nodeKey) => !requiredNodeKeys.has(nodeKey));

      // All retained entries may be required for the current render. Keep
      // them, including a single entry larger than the configured budget.
      if (leastRecentlyUsedKey === undefined) {
        break;
      }

      removeEntry(leastRecentlyUsedKey, true);
    }
  };

  const cancelPendingExcept = (
    nodeKeys: Iterable<string>,
    reason: 'superseded' | 'lifecycle' = 'superseded',
  ): void => {
    const retainedNodeKeys = new Set(nodeKeys);
    for (const [nodeKey, entry] of cache) {
      if (!entry.pending || retainedNodeKeys.has(nodeKey)) {
        continue;
      }
      removeEntry(nodeKey, false, entry);
      entry.controller.abort(reason);
    }
  };

  const cancelPendingCurrentExcept = (
    nodeKeys: Iterable<string>,
    reason: 'superseded' | 'lifecycle' = 'superseded',
  ): void => {
    const retainedNodeKeys = new Set(nodeKeys);
    for (const [nodeKey, entry] of cache) {
      if (!entry.pending
        || entry.purpose !== 'current'
        || retainedNodeKeys.has(nodeKey)) {
        continue;
      }
      removeEntry(nodeKey, false, entry);
      entry.controller.abort(reason);
    }
  };

  const load = (
    nodeKey: string,
    purpose: NodePointLoadPurpose = 'current',
  ): Promise<TValue> => {
    const cached = cache.get(nodeKey);

    if (cached) {
      hits = saturatingAdd(hits, 1);
      touchEntry(cache, nodeKey, cached);
      if (purpose === 'current' && cached.wasPrefetched) {
        cached.prefetchedValueUsed = true;
        if (!cached.pending && !cached.prefetchUsefulHitRecorded) {
          cached.prefetchUsefulHitRecorded = true;
          prefetchUsefulHitCount = saturatingAdd(prefetchUsefulHitCount, 1);
        }
        const wasPendingPrefetch = cached.pending && cached.wasPrefetched;
        cached.purpose = 'current';
        if (wasPendingPrefetch) {
          // Current-view correctness cannot depend on speculative success.
          // If the shared speculative operation fails or is cancelled, retry
          // it once through the ordinary current-view cache path.
          return cached.value.catch(() => load(nodeKey, 'current'));
        }
      }
      return cached.value;
    }

    misses = saturatingAdd(misses, 1);
    const entry: CacheEntry<TValue> = {
      value: Promise.resolve(undefined as TValue),
      bytes: 0,
      controller: new AbortController(),
      pending: true,
      purpose,
      wasPrefetched: purpose === 'prefetch',
      prefetchedValueUsed: false,
      prefetchUsefulHitRecorded: false,
    };
    const pending = Promise.resolve()
      .then(() => {
        if (entry.controller.signal.aborted) {
          throw new Error('Node point load was cancelled');
        }
        return loader(nodeKey, entry.controller.signal, purpose);
      })
      .then((value) => {
        entry.pending = false;
        if (entry.controller.signal.aborted) {
          throw new Error('Node point load was cancelled');
        }
        // A pending request can have been evicted before it resolves. In
        // that case its result remains usable by the caller but is not
        // reinserted into the cache or its byte counters.
        if (cache.get(nodeKey) === entry) {
          entry.resolved = value;
          entry.bytes = normalizeByteCount(estimateBytes(value));
          currentCacheBytes = saturatingAdd(currentCacheBytes, entry.bytes);
          if (entry.wasPrefetched
            && entry.prefetchedValueUsed
            && !entry.prefetchUsefulHitRecorded) {
            entry.prefetchUsefulHitRecorded = true;
            prefetchUsefulHitCount = saturatingAdd(prefetchUsefulHitCount, 1);
          }
          evictIfNeeded();
        }
        return value;
      })
      .catch((error: unknown) => {
        entry.pending = false;
        removeEntry(nodeKey, false, entry);
        throw error;
      });
    entry.value = pending;
    cache.set(nodeKey, entry);
    evictIfNeeded();

    return pending;
  };

  return {
    load,
    get(nodeKey: string): TValue | undefined {
      return cache.get(nodeKey)?.resolved;
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
    cancelPending(reason = 'superseded'): void {
      cancelPendingExcept([], reason);
    },
    cancelPendingExcept(nodeKeys, reason = 'superseded'): void {
      cancelPendingExcept(nodeKeys, reason);
    },
    cancelPendingCurrentExcept(nodeKeys, reason = 'superseded'): void {
      cancelPendingCurrentExcept(nodeKeys, reason);
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
        prefetchUsefulHitCount,
        prefetchEvictedUnusedCount,
      };
    },
    clear(): void {
      cancelPendingExcept([], 'lifecycle');
      cache.clear();
      requiredNodeKeys.clear();
      currentCacheBytes = 0;
      hits = 0;
      misses = 0;
      evictionCount = 0;
      bytesEvicted = 0;
      prefetchUsefulHitCount = 0;
      prefetchEvictedUnusedCount = 0;
    },
  };
}

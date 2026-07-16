export type NodePointLoader<TValue> = (nodeKey: string) => Promise<TValue>;

export type NodePointCache<TValue> = {
  load(nodeKey: string): Promise<TValue>;
  delete(nodeKey: string): void;
  has(nodeKey: string): boolean;
  getSize(): number;
  clear(): void;
};

export type NodePointCacheOptions = {
  maxEntries: number;
};

function validateMaxEntries(maxEntries: number): void {
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new RangeError(
      'Node point cache maxEntries must be a positive integer',
    );
  }
}

function touchEntry<TValue>(
  cache: Map<string, Promise<TValue>>,
  nodeKey: string,
  value: Promise<TValue>,
): void {
  cache.delete(nodeKey);
  cache.set(nodeKey, value);
}

export function createNodePointCache<TValue>(
  loader: NodePointLoader<TValue>,
  options: NodePointCacheOptions,
): NodePointCache<TValue> {
  validateMaxEntries(options.maxEntries);
  const cache = new Map<string, Promise<TValue>>();

  return {
    load(nodeKey: string): Promise<TValue> {
      const cached = cache.get(nodeKey);

      if (cached) {
        touchEntry(cache, nodeKey, cached);
        return cached;
      }

      const pending = loader(nodeKey).catch((error: unknown) => {
        cache.delete(nodeKey);
        throw error;
      });
      cache.set(nodeKey, pending);

      while (cache.size > options.maxEntries) {
        const leastRecentlyUsedKey = cache.keys().next().value;

        if (!leastRecentlyUsedKey) {
          break;
        }

        cache.delete(leastRecentlyUsedKey);
      }

      return pending;
    },
    delete(nodeKey: string): void {
      cache.delete(nodeKey);
    },
    has(nodeKey: string): boolean {
      return cache.has(nodeKey);
    },
    getSize(): number {
      return cache.size;
    },
    clear(): void {
      cache.clear();
    },
  };
}

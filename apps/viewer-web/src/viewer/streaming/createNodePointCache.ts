export type NodePointLoader<TValue> = (nodeKey: string) => Promise<TValue>;

export function createNodePointCache<TValue>(loader: NodePointLoader<TValue>): {
  load(nodeKey: string): Promise<TValue>;
  clear(): void;
} {
  const cache = new Map<string, Promise<TValue>>();

  return {
    load(nodeKey: string): Promise<TValue> {
      const cached = cache.get(nodeKey);

      if (cached) {
        return cached;
      }

      const pending = loader(nodeKey);
      cache.set(nodeKey, pending);

      return pending;
    },
    clear(): void {
      cache.clear();
    },
  };
}

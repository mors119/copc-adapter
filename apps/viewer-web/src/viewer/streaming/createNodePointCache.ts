import type { GeographicPoint } from '../../copc/types/copc';

export type NodePointLoader = (nodeKey: string) => Promise<GeographicPoint[]>;

export function createNodePointCache(loader: NodePointLoader): {
  load(nodeKey: string): Promise<GeographicPoint[]>;
  clear(): void;
} {
  const cache = new Map<string, Promise<GeographicPoint[]>>();

  return {
    load(nodeKey: string): Promise<GeographicPoint[]> {
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

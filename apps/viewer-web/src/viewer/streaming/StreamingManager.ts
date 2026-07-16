import type { GeographicPointBuffer } from '../../copc/types/copc';
import type { NodePointCache } from './createNodePointCache';
import { NodeSelector } from './NodeSelector';
import type {
  StreamingCameraState,
  StreamingHierarchy,
  StreamingSelectionOptions,
  StreamingUpdateResult,
} from './types';

export type StreamingNodePointLoader = (
  nodeKey: string,
) => Promise<GeographicPointBuffer>;

export class StreamingManager {
  private readonly hierarchy: StreamingHierarchy;
  private readonly selector: NodeSelector;
  private readonly cache: NodePointCache<GeographicPointBuffer>;
  private readonly selectedNodeKeys = new Set<string>();

  constructor(
    hierarchy: StreamingHierarchy,
    options: StreamingSelectionOptions,
    cache: NodePointCache<GeographicPointBuffer>,
  ) {
    this.hierarchy = hierarchy;
    this.selector = new NodeSelector(options);
    this.cache = cache;
  }

  async update(camera: StreamingCameraState): Promise<StreamingUpdateResult> {
    const selectedNodes = this.selector.selectVisibleNodes(camera, this.hierarchy);
    const nextSelectedNodeKeys = new Set(
      selectedNodes.map((entry) => entry.node.key),
    );
    const removedNodeKeys = [...this.selectedNodeKeys]
      .filter((nodeKey) => !nextSelectedNodeKeys.has(nodeKey))
      .sort();

    for (const nodeKey of removedNodeKeys) {
      this.selectedNodeKeys.delete(nodeKey);
      this.cache.delete(nodeKey);
    }

    for (const nodeKey of nextSelectedNodeKeys) {
      this.selectedNodeKeys.add(nodeKey);
    }

    const loadedNodePoints = new Map<string, GeographicPointBuffer>();

    await Promise.all(
      selectedNodes.map(async (node) => {
        const nodeKey = node.node.key;
        const points = await this.cache.load(nodeKey);

        if (this.selectedNodeKeys.has(nodeKey)) {
          loadedNodePoints.set(nodeKey, points);
        }
      }),
    );

    return {
      selectedNodeKeys: [...nextSelectedNodeKeys].sort(),
      removedNodeKeys,
      loadedNodePoints,
    };
  }

  clear(): void {
    this.selectedNodeKeys.clear();
    this.cache.clear();
  }
}

import * as Cesium from 'cesium';
import type { GeographicPoint, GeographicPointBuffer } from '../../copc/types/copc';
import { performanceNow } from '../../copc/performance';
import {
  renderCopcPoints,
  type CopcPointRenderOptions,
} from './renderPoints';

export type CopcPointRendererPerformanceStage =
  | 'geographicToCartesian'
  | 'pointStylePreparation'
  | 'pointCollectionCreation'
  | 'pointAdd'
  | 'rendererPreparation'
  | 'nodeRemoval';

export type CopcPointRendererOptions = Omit<CopcPointRenderOptions, 'onPerformance'> & {
  onPerformance?: (
    stage: CopcPointRendererPerformanceStage,
    durationMs: number,
    pointCount: number,
  ) => void;
};

/**
 * The project-owned renderer boundary. It receives already decoded and
 * geographically transformed point buffers; loading and selection stay with
 * the streaming controller.
 */
export interface CopcPointRenderer {
  attachTo(viewer: Cesium.Viewer): void;
  detachFrom(): void;
  addOrUpdateNode(
    nodeKey: string,
    points: GeographicPointBuffer,
    options: CopcPointRendererOptions,
  ): void;
  removeNode(nodeKey: string): void;
  clear(): void;
  destroy(): void;
  hasNode(nodeKey: string): boolean;
  /** Optional per-node count used by the controller's workload guard. */
  getRenderedNodePointCount?(nodeKey: string): number | undefined;
  getRenderedNodeKeys(): string[];
  getRenderedPointCount(): number;
  getSelectionBoundingSphere(): Cesium.BoundingSphere | undefined;
}

/** Compatibility renderer backed by Cesium.PointPrimitiveCollection. */
export class PointPrimitiveRenderer implements CopcPointRenderer {
  private viewer?: Cesium.Viewer;
  private readonly pointCollections = new Map<string, Cesium.PointPrimitiveCollection>();

  attachTo(viewer: Cesium.Viewer): void {
    if (this.viewer === viewer) {
      return;
    }

    this.clear();
    this.viewer = viewer;
  }

  detachFrom(): void {
    this.clear();
    this.viewer = undefined;
  }

  addOrUpdateNode(
    nodeKey: string,
    points: GeographicPointBuffer,
    options: CopcPointRendererOptions,
  ): void {
    if (!this.viewer) {
      throw new Error('PointPrimitiveRenderer is not attached to a Cesium viewer');
    }

    if (this.pointCollections.has(nodeKey)) {
      this.removeNode(nodeKey);
    }

    const startedAt = performanceNow();
    const collection = renderCopcPoints(this.viewer, points, {
      ...options,
      onPerformance: (stage, durationMs) => {
        options.onPerformance?.(stage, durationMs, points.pointCount);
      },
    });
    this.pointCollections.set(nodeKey, collection);
    this.rememberPerformanceObserver(nodeKey, options.onPerformance);
    options.onPerformance?.(
      'rendererPreparation',
      performanceNow() - startedAt,
      points.pointCount,
    );
  }

  removeNode(nodeKey: string): void {
    const collection = this.pointCollections.get(nodeKey);
    if (!collection) {
      return;
    }

    const startedAt = performanceNow();
    this.viewer?.scene.primitives.remove(collection);
    this.pointCollections.delete(nodeKey);
    // Removal is intentionally measured at the boundary where a future
    // renderer can replace a whole node without exposing Cesium internals.
    // The compatibility path has no per-call observer, so this metric is
    // emitted through the optional node callback stored for the collection.
    const observer = this.nodePerformanceObservers.get(nodeKey);
    observer?.('nodeRemoval', performanceNow() - startedAt, collection.length);
    this.nodePerformanceObservers.delete(nodeKey);
  }

  clear(): void {
    for (const nodeKey of [...this.pointCollections.keys()]) {
      this.removeNode(nodeKey);
    }
  }

  destroy(): void {
    this.clear();
    this.viewer = undefined;
    this.nodePerformanceObservers.clear();
  }

  hasNode(nodeKey: string): boolean {
    return this.pointCollections.has(nodeKey);
  }

  getRenderedNodePointCount(nodeKey: string): number | undefined {
    return this.pointCollections.get(nodeKey)?.length;
  }

  getRenderedNodeKeys(): string[] {
    return [...this.pointCollections.keys()].sort();
  }

  getRenderedPointCount(): number {
    let total = 0;

    for (const collection of this.pointCollections.values()) {
      total += collection.length;
    }

    return total;
  }

  getSelectionBoundingSphere(): Cesium.BoundingSphere | undefined {
    if (this.pointCollections.size === 0) {
      return undefined;
    }

    const positions = [...this.pointCollections.values()].flatMap((collection) => {
      const points: GeographicPoint[] = [];

      for (let index = 0; index < collection.length; index += 1) {
        const primitive = collection.get(index);
        const cartographic = Cesium.Cartographic.fromCartesian(primitive.position);

        points.push({
          longitude: Cesium.Math.toDegrees(cartographic.longitude),
          latitude: Cesium.Math.toDegrees(cartographic.latitude),
          height: cartographic.height,
        });
      }

      return points.map((point) => Cesium.Cartesian3.fromDegrees(
        point.longitude,
        point.latitude,
        point.height,
      ));
    });

    return Cesium.BoundingSphere.fromPoints(positions);
  }

  private readonly nodePerformanceObservers = new Map<
    string,
    NonNullable<CopcPointRendererOptions['onPerformance']>
  >();

  // Keep observer registration beside the node lifecycle without making the
  // renderer API expose collection objects or Cesium implementation details.
  private rememberPerformanceObserver(
    nodeKey: string,
    observer: CopcPointRendererOptions['onPerformance'],
  ): void {
    if (observer) {
      this.nodePerformanceObservers.set(nodeKey, observer);
    }
  }
}

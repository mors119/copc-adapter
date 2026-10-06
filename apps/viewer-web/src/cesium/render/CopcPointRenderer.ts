import * as Cesium from 'cesium';
import type {
  GeographicPointBuffer,
  PreparedPointData,
} from '../../copc/types/copc';
import { performanceNow } from '../../copc/performance';
import type {
  CopcPointRenderer,
  CopcPointRendererOptions as NeutralCopcPointRendererOptions,
} from '../../viewer/streaming/renderer';
import { renderCopcPoints } from './renderPoints';
import { getPointColor } from '../style/pointStyle';
import { resolveCopcPointStyleOptions } from '../../point/style/pointStyle';

export type CopcCesiumPointRendererPerformanceStage =
  | 'geographicToCartesian'
  | 'worldToCartesian'
  | 'pointStylePreparation'
  | 'pointCollectionCreation'
  | 'pointAdd'
  | 'rendererPreparation'
  | 'nodeRemoval';

export type CopcCesiumPointRendererOptions = NeutralCopcPointRendererOptions & {
  onPerformance?: (
    stage: CopcCesiumPointRendererPerformanceStage,
    durationMs: number,
    pointCount: number,
  ) => void;
};

/** @deprecated Use `CopcCesiumPointRendererPerformanceStage`. */
export type CopcPointRendererPerformanceStage = CopcCesiumPointRendererPerformanceStage;

type CesiumPointData = GeographicPointBuffer | PreparedPointData;

/** @deprecated Use the renderer-neutral options from `viewer/streaming/renderer`. */
export type { CopcPointRendererOptions } from '../../viewer/streaming/renderer';
export type { CopcPointRenderer } from '../../viewer/streaming/renderer';

/** Cesium-only part of the renderer boundary. */
export interface CesiumPointRenderer extends CopcPointRenderer {
  attachTo(viewer: Cesium.Viewer): void;
  detachFrom(): void;
  addOrUpdateNode(
    nodeKey: string,
    points: CesiumPointData,
    options: CopcCesiumPointRendererOptions,
  ): void;
  /** Restyle an existing node without replacing its point identities. */
  updateNodeStyle?(
    nodeKey: string,
    points: CesiumPointData,
    options: CopcCesiumPointRendererOptions,
  ): void;
  getSelectionBoundingSphere(): Cesium.BoundingSphere | undefined;
}

/** Explicit name for the Cesium adapter-side renderer contract. */
export type CopcCesiumPointRenderer = CesiumPointRenderer;

/** Compatibility renderer backed by Cesium.PointPrimitiveCollection. */
export class PointPrimitiveRenderer implements CesiumPointRenderer {
  private viewer?: Cesium.Viewer;
  private readonly pointCollections = new Map<string, Cesium.PointPrimitiveCollection>();
  private readonly visiblePointCounts = new Map<string, number>();

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
    points: CesiumPointData,
    options: CopcCesiumPointRendererOptions,
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
    let visiblePointCount = 0;
    for (let index = 0; index < collection.length; index += 1) {
      if (collection.get(index).show) {
        visiblePointCount += 1;
      }
    }
    this.visiblePointCounts.set(nodeKey, visiblePointCount);
    this.rememberPerformanceObserver(nodeKey, options.onPerformance);
    options.onPerformance?.(
      'rendererPreparation',
      performanceNow() - startedAt,
      points.pointCount,
    );
  }

  updateNodeStyle(
    nodeKey: string,
    points: CesiumPointData,
    options: CopcCesiumPointRendererOptions,
  ): void {
    const collection = this.pointCollections.get(nodeKey);
    if (!collection || collection.length !== points.pointCount) {
      this.addOrUpdateNode(nodeKey, points, options);
      return;
    }

    const startedAt = performanceNow();
    const styleOptions = resolveCopcPointStyleOptions(points, {
      colorMode: options.colorMode,
      elevationRange: options.elevationRange,
      rgbMax: options.rgbMax,
    });
    let visiblePointCount = 0;
    for (let index = 0; index < points.pointCount; index += 1) {
      const primitive = collection.get(index);
      const visible = options.pointFilter?.(index) ?? true;
      primitive.show = visible;
      primitive.color = getPointColor(
        points.coordinates[index * 3 + 2],
        styleOptions,
        points.attributes,
        index,
      );
      if (visible) {
        visiblePointCount += 1;
      }
    }
    this.visiblePointCounts.set(nodeKey, visiblePointCount);
    options.onPerformance?.(
      'pointStylePreparation',
      performanceNow() - startedAt,
      points.pointCount,
    );
    this.rememberPerformanceObserver(nodeKey, options.onPerformance);
  }

  removeNode(nodeKey: string): void {
    const collection = this.pointCollections.get(nodeKey);
    if (!collection) {
      return;
    }

    const startedAt = performanceNow();
    this.viewer?.scene.primitives.remove(collection);
    this.pointCollections.delete(nodeKey);
    this.visiblePointCounts.delete(nodeKey);
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
    return this.visiblePointCounts.get(nodeKey);
  }

  getRenderedNodeKeys(): string[] {
    return [...this.pointCollections.keys()].sort();
  }

  getRenderedPointCount(): number {
    let total = 0;

    for (const count of this.visiblePointCounts.values()) {
      total += count;
    }

    return total;
  }

  getSelectionBoundingSphere(): Cesium.BoundingSphere | undefined {
    if (this.pointCollections.size === 0) {
      return undefined;
    }

    const positions = [...this.pointCollections.values()].flatMap((collection) => {
      const values: Cesium.Cartesian3[] = [];
      for (let index = 0; index < collection.length; index += 1) {
        const primitive = collection.get(index);
        if (primitive.show) {
          values.push(primitive.position);
        }
      }
      return values;
    });

    return positions.length > 0 ? Cesium.BoundingSphere.fromPoints(positions) : undefined;
  }

  private readonly nodePerformanceObservers = new Map<
    string,
    NonNullable<CopcCesiumPointRendererOptions['onPerformance']>
  >();

  // Keep observer registration beside the node lifecycle without making the
  // renderer API expose collection objects or Cesium implementation details.
  private rememberPerformanceObserver(
    nodeKey: string,
    observer: CopcCesiumPointRendererOptions['onPerformance'],
  ): void {
    if (observer) {
      this.nodePerformanceObservers.set(nodeKey, observer);
    }
  }
}

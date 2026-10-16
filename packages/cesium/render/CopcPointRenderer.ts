import * as Cesium from 'cesium';
import type {
  GeographicPointBuffer,
  PreparedPointData,
} from '../../core/copc/types/copc';
import { performanceNow } from '../../core/copc/performance';
import type {
  CopcPointRenderer,
  CopcPointRendererOptions as NeutralCopcPointRendererOptions,
} from '../../core/streaming/renderer';
import { renderCopcPoints } from './renderPoints';
import { getPointColor } from '../style/pointStyle';
import { resolveCopcPointStyleOptions } from '../../core/point/style/pointStyle';

/** Cesium renderer preparation stage reported with a duration in milliseconds. */
export type CopcCesiumPointRendererPerformanceStage =
  /** Convert WGS84 geographic values to Cesium cartographic/cartesian coordinates. */
  | 'geographicToCartesian'
  /** Convert shared ECEF buffers to Cesium Cartesian values. */
  | 'worldToCartesian'
  /** Resolve normalized per-point colors. */
  | 'pointStylePreparation'
  /** Create the Cesium point primitive collection for a node. */
  | 'pointCollectionCreation'
  /** Add point primitives to the collection. */
  | 'pointAdd'
  /** Total node renderer preparation. */
  | 'rendererPreparation'
  /** Remove and release one node's primitives. */
  | 'nodeRemoval';

/** Cesium-specific point styling and performance callback options. */
export type CopcCesiumPointRendererOptions = NeutralCopcPointRendererOptions & {
  /** Receives the measured stage, elapsed milliseconds, and affected point count. */
  onPerformance?: (
    stage: CopcCesiumPointRendererPerformanceStage,
    durationMs: number,
    pointCount: number,
  ) => void;
};

/** @deprecated Planned for removal in v0.9, after v0.8; use `CopcCesiumPointRendererPerformanceStage`. */
export type CopcPointRendererPerformanceStage = CopcCesiumPointRendererPerformanceStage;

type CesiumPointData = GeographicPointBuffer | PreparedPointData;

/** @deprecated Planned for removal in v0.9, after v0.8; use `CopcCesiumPointRendererOptions`. */
export type { CopcPointRendererOptions } from '../../core/streaming/renderer';
export type { CopcPointRenderer } from '../../core/streaming/renderer';

/** Cesium-only part of the renderer boundary. */
export interface CesiumPointRenderer extends CopcPointRenderer {
  /** Attach renderer-owned primitives to a caller-owned Viewer. */
  attachTo(viewer: Cesium.Viewer): void;
  /** Detach and release renderer-owned primitive resources. */
  detachFrom(): void;
  /** Apply layer-level visibility when the renderer supports it. */
  setShow?(show: boolean): void;
  /** Create or replace one node's point primitives. */
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
  /** Return a clone of the visible node bounds in WGS84 ECEF, when available. */
  getSelectionBoundingSphere(): Cesium.BoundingSphere | undefined;
}

/** Explicit name for the Cesium adapter-side renderer contract. */
export type CopcCesiumPointRenderer = CesiumPointRenderer;

/** Compatibility renderer backed by Cesium.PointPrimitiveCollection. */
export class PointPrimitiveRenderer implements CesiumPointRenderer {
  private viewer?: Cesium.Viewer;
  private primitiveCollection?: Cesium.PrimitiveCollection;
  private showState = true;
  private readonly pointCollections = new Map<string, Cesium.PointPrimitiveCollection>();
  private readonly visiblePointCounts = new Map<string, number>();

  /** Attach a new primitive collection to a Viewer owned by the application. */
  attachTo(viewer: Cesium.Viewer): void {
    if (this.viewer === viewer) {
      return;
    }

    this.detachFrom();
    this.viewer = viewer;
    this.primitiveCollection = viewer.scene.primitives.add(
      new Cesium.PrimitiveCollection({ show: this.showState }),
    );
  }

  /** Remove and release renderer-owned point collections from the current Viewer. */
  detachFrom(): void {
    this.clear();
    if (this.primitiveCollection) {
      this.viewer?.scene.primitives.remove(this.primitiveCollection);
      this.primitiveCollection = undefined;
    }
    this.viewer = undefined;
  }

  /** Set visibility for the primitive collection and all its nodes. */
  setShow(show: boolean): void {
    this.showState = show;
    if (this.primitiveCollection) {
      this.primitiveCollection.show = show;
    }
  }

  /** Add a node's points or replace the existing node collection. */
  addOrUpdateNode(
    nodeKey: string,
    points: CesiumPointData,
    options: CopcCesiumPointRendererOptions,
  ): void {
    if (!this.viewer || !this.primitiveCollection) {
      throw new Error('PointPrimitiveRenderer is not attached to a Cesium viewer');
    }

    if (this.pointCollections.has(nodeKey)) {
      this.removeNode(nodeKey);
    }

    const startedAt = performanceNow();
    const collection = renderCopcPoints(
      this.viewer,
      points,
      {
        ...options,
        onPerformance: (stage, durationMs) => {
          options.onPerformance?.(stage, durationMs, points.pointCount);
        },
      },
      this.primitiveCollection,
    );
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

  /** Update existing colors and point visibility without changing point identities. */
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

  /** Remove one node's primitive collection. */
  removeNode(nodeKey: string): void {
    const collection = this.pointCollections.get(nodeKey);
    if (!collection) {
      return;
    }

    const startedAt = performanceNow();
    const pointCount = collection.length;
    this.primitiveCollection?.remove(collection);
    this.pointCollections.delete(nodeKey);
    this.visiblePointCounts.delete(nodeKey);
    // Removal is intentionally measured at the boundary where a future
    // renderer can replace a whole node without exposing Cesium internals.
    // The compatibility path has no per-call observer, so this metric is
    // emitted through the optional node callback stored for the collection.
    const observer = this.nodePerformanceObservers.get(nodeKey);
    observer?.('nodeRemoval', performanceNow() - startedAt, pointCount);
    this.nodePerformanceObservers.delete(nodeKey);
  }

  /** Remove all nodes while leaving the Viewer attachment reusable. */
  clear(): void {
    for (const nodeKey of [...this.pointCollections.keys()]) {
      this.removeNode(nodeKey);
    }
  }

  /** Detach and release all renderer-owned Cesium primitives. */
  destroy(): void {
    this.detachFrom();
    this.nodePerformanceObservers.clear();
  }

  /** Return whether this renderer currently owns a collection for the node. */
  hasNode(nodeKey: string): boolean {
    return this.pointCollections.has(nodeKey);
  }

  /** Return the number of points held by one rendered node, if present. */
  getRenderedNodePointCount(nodeKey: string): number | undefined {
    return this.visiblePointCounts.get(nodeKey);
  }

  /** Return sorted keys for nodes currently committed to Cesium. */
  getRenderedNodeKeys(): string[] {
    return [...this.pointCollections.keys()].sort();
  }

  /** Return the total point count currently committed to Cesium. */
  getRenderedPointCount(): number {
    let total = 0;

    for (const count of this.visiblePointCounts.values()) {
      total += count;
    }

    return total;
  }

  /** Return a clone of the visible node bounds in WGS84 ECEF. */
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

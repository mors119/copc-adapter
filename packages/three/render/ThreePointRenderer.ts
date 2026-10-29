import * as THREE from "three";
import type {
  CopcMetadata,
  GeographicPointBuffer,
  PreparedPointData,
} from "../../core/copc/types/copc";
import {
  isCompactEPointCacheNode,
  type RenderablePointData,
} from "../../core/point/compactEPointCache";
import { performanceNow } from "../../core/copc/performance";
import { createPointTransformer } from "../../core/coordinates/transform/createPointTransformer";
import type { GtxGeoidGrid } from "../../core/coordinates/transform/verticalGrid";
import {
  geographicToEcef,
  worldBufferToLocal,
} from "../../core/coordinates/transform/worldCoordinates";
import { worldBufferToDatasetLocal } from "../../core/coordinates/transform/datasetLocalFrame";
import type {
  DatasetLocalFrame,
  Wgs84EcefPoint,
} from "../../core/coordinates/types";
import {
  getThreePointsMaterialOptions,
  prepareThreePointColorBuffer,
} from "../style/pointStyle";
import type {
  CopcPointRenderer,
  CopcPointRendererOptions,
} from "../../core/streaming/renderer";
import { assertCopcLayerOpacity } from "../../core/streaming/renderer";

/** Three renderer preparation stage reported with a duration in milliseconds. */
export type ThreePointRendererPerformanceStage =
  /** Convert shared ECEF positions to the dataset's renderer-local frame. */
  | "worldToLocal"
  /** Allocate point geometry and attributes. */
  | "geometryCreation"
  /** Allocate the points material. */
  | "materialCreation"
  /** Total preparation time for the node. */
  | "rendererPreparation"
  /** Remove and release one node's geometry and material. */
  | "nodeRemoval";

/** Options passed to the Three point renderer for one node. */
export type ThreePointRendererOptions = CopcPointRendererOptions & {
  /** Optional renderer preparation observer used by adapter diagnostics. */
  onPerformance?: (
    stage: ThreePointRendererPerformanceStage,
    durationMs: number,
    pointCount: number,
  ) => void;
};

/** Initial origin or stable dataset-local frame for point geometry. */
export type ThreePointRendererConstructorOptions = {
  /**
   * Fixed ECEF origin for the lifetime of the renderer. Passing the origin
   * derived from dataset metadata is recommended for a stable application
   * frame; without one, the first non-empty node chooses the origin.
   */
  localOrigin?: Wgs84EcefPoint;
  /** Stable dataset-local ENU frame shared with the camera adapter. */
  localFrame?: DatasetLocalFrame;
};

/** Metadata-derived origin for the renderer-local ECEF frame. */
export function createThreeLocalOrigin(
  metadata: CopcMetadata,
  verticalGrid?: GtxGeoidGrid,
): Wgs84EcefPoint {
  const transformPoint = createPointTransformer(metadata, 0, verticalGrid, {
    sampleVerticalGrid: false,
  });
  const { minX, minY, minZ, maxX, maxY, maxZ } = metadata.cube;
  const center = transformPoint({
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: (minZ + maxZ) / 2,
  });
  if (verticalGrid) {
    // This metadata-derived center can lie in empty padding outside a
    // regional grid; use the grid-extrema midpoint for a stable origin.
    center.height +=
      (verticalGrid.minimumUndulationMeters +
        verticalGrid.maximumUndulationMeters) /
      2;
  }
  return geographicToEcef(center);
}

function assertPointCount(
  points: GeographicPointBuffer | RenderablePointData,
): void {
  if (!Number.isSafeInteger(points.pointCount) || points.pointCount < 0) {
    throw new Error(
      "Three.js point buffers must have a non-negative safe point count",
    );
  }

  if (isCompactEPointCacheNode(points)) {
    if (
      !(points.ecef instanceof Float64Array) ||
      points.ecef.length !== points.pointCount * 3 ||
      !(points.height instanceof Float64Array) ||
      points.height.length !== points.pointCount
    ) {
      throw new Error("Three.js compact E buffers must match point count");
    }
    return;
  }

  if (points.coordinates.length !== points.pointCount * 3) {
    throw new Error(
      "Three.js point buffers must contain three geographic values per point",
    );
  }

  if (
    points.worldCoordinates &&
    points.worldCoordinates.length !== points.pointCount * 3
  ) {
    throw new Error(
      "Three.js world point buffers must contain three values per point",
    );
  }

  if (
    points.worldCoordinateSystem &&
    points.worldCoordinateSystem !== "wgs84-ecef-meters"
  ) {
    throw new Error(
      "Three.js point buffers must use wgs84-ecef-meters world coordinates",
    );
  }
}

function assertFiniteCoordinates(
  coordinates: Float64Array,
  label: string,
): void {
  for (const value of coordinates) {
    if (!Number.isFinite(value)) {
      throw new Error(`Three.js ${label} coordinates must be finite`);
    }
  }
}

function toWorldCoordinates(
  points: GeographicPointBuffer | RenderablePointData,
): Float64Array {
  if (isCompactEPointCacheNode(points)) {
    assertFiniteCoordinates(points.ecef, "world");
    return points.ecef;
  }
  if (points.worldCoordinates) {
    assertFiniteCoordinates(points.worldCoordinates, "world");
    return points.worldCoordinates;
  }

  const worldCoordinates = new Float64Array(points.pointCount * 3);
  for (let index = 0; index < points.pointCount; index += 1) {
    const offset = index * 3;
    const world = geographicToEcef({
      longitude: points.coordinates[offset],
      latitude: points.coordinates[offset + 1],
      height: points.coordinates[offset + 2],
    });
    worldCoordinates[offset] = world.x;
    worldCoordinates[offset + 1] = world.y;
    worldCoordinates[offset + 2] = world.z;
  }
  return worldCoordinates;
}

function copyEcefPoint(point: Wgs84EcefPoint): Wgs84EcefPoint {
  if (![point.x, point.y, point.z].every(Number.isFinite)) {
    throw new Error("Three.js local origin must have finite coordinates");
  }
  if (point.coordinateSystem !== "wgs84-ecef-meters") {
    throw new Error("Three.js local origin must use wgs84-ecef-meters");
  }
  return {
    coordinateSystem: "wgs84-ecef-meters",
    x: point.x,
    y: point.y,
    z: point.z,
  };
}

function deriveOrigin(
  worldCoordinates: Float64Array,
): Wgs84EcefPoint | undefined {
  if (worldCoordinates.length === 0) {
    return undefined;
  }

  return {
    coordinateSystem: "wgs84-ecef-meters",
    x: worldCoordinates[0],
    y: worldCoordinates[1],
    z: worldCoordinates[2],
  };
}

function createMaterial(pointSize: number, opacity: number): THREE.PointsMaterial {
  if (!Number.isFinite(pointSize) || pointSize <= 0) {
    throw new Error("Three.js pointSize must be a positive finite number");
  }

  return new THREE.PointsMaterial({
    color: 0xffffff,
    ...getThreePointsMaterialOptions(pointSize, opacity),
  });
}

/**
 * Three.js node renderer for the shared COPC streaming contract.
 *
 * The renderer owns one `THREE.Points` object, geometry, and material per
 * active node. The caller owns the scene, camera, WebGLRenderer, and render
 * loop. Coordinates are subtracted from a stable ECEF origin before they are
 * narrowed to Float32 for the GPU attribute.
 */
export class ThreePointRenderer implements CopcPointRenderer {
  private readonly root = new THREE.Group();
  private readonly pointsByNode = new Map<string, THREE.Points>();
  private scene?: THREE.Scene;
  private localOrigin?: Wgs84EcefPoint;
  private localFrame?: DatasetLocalFrame;
  private opacity = 0.9;
  private destroyed = false;

  constructor(options: ThreePointRendererConstructorOptions = {}) {
    this.localOrigin = options.localOrigin
      ? copyEcefPoint(options.localOrigin)
      : undefined;
    if (options.localFrame) {
      this.setLocalFrame(options.localFrame);
    }
    this.root.name = "copc-three-root";
  }

  /** Attach the adapter-owned root group to the caller-owned scene. */
  attachTo(scene: THREE.Scene): void {
    if (this.destroyed) {
      throw new Error("ThreePointRenderer has been destroyed");
    }
    if (!scene || typeof scene.add !== "function") {
      throw new Error("ThreePointRenderer requires a Three.js scene");
    }
    if (this.scene === scene) {
      return;
    }

    this.detachFrom();
    this.scene = scene;
    scene.add(this.root);
  }

  /** Remove adapter-owned objects from the scene and release their resources. */
  detachFrom(): void {
    this.clear();
    this.root.removeFromParent();
    this.scene = undefined;
  }

  /** Return the adapter-owned root for read-only application composition. */
  getRoot(): THREE.Group {
    return this.root;
  }

  /** Update current and future owned point materials without replacing geometry. */
  setOpacity(opacity: number): void {
    assertCopcLayerOpacity(opacity);
    this.opacity = opacity;
    for (const points of this.pointsByNode.values()) {
      points.visible = opacity !== 0;
      (points.material as THREE.PointsMaterial).opacity = opacity;
    }
  }

  /** Return the stable ECEF origin used for local vertex positions. */
  getLocalOrigin(): Wgs84EcefPoint | undefined {
    const origin = this.localFrame?.origin ?? this.localOrigin;
    return origin ? { ...origin } : undefined;
  }

  /**
   * Set the fixed ENU metre frame used to convert ECEF points before GPU upload.
   *
   * @throws If the renderer is destroyed, already has rendered nodes, or the frame is not ENU metres.
   */
  setLocalFrame(frame: DatasetLocalFrame): void {
    if (this.destroyed) {
      throw new Error("ThreePointRenderer has been destroyed");
    }
    if (this.pointsByNode.size > 0) {
      throw new Error(
        "ThreePointRenderer cannot change its frame while nodes are rendered",
      );
    }
    if (
      frame.coordinateSystem !== "renderer-local" ||
      frame.axisConvention !== "enu" ||
      frame.units !== "metres"
    ) {
      throw new Error(
        "ThreePointRenderer requires a dataset-local ENU metre frame",
      );
    }
    this.localFrame = frame;
    this.localOrigin = undefined;
  }

  /** Return the fixed dataset-local frame, when one has been configured. */
  getLocalFrame(): DatasetLocalFrame | undefined {
    return this.localFrame;
  }

  /**
   * Create or replace one node's geometry and material in the attached scene.
   *
   * Source buffers are transformed into the fixed local frame in Float64 and
   * only then narrowed to Float32 for the GPU. The renderer owns the resulting
   * geometry and material and disposes them when the node is removed.
   *
   * @throws If the renderer is destroyed or unattached, the node key or point buffer is invalid, or point size is not positive and finite.
   */
  addOrUpdateNode(
    nodeKey: string,
    points: GeographicPointBuffer | PreparedPointData | RenderablePointData,
    options: ThreePointRendererOptions,
  ): void {
    if (this.destroyed) {
      throw new Error("ThreePointRenderer has been destroyed");
    }
    if (!this.scene) {
      throw new Error("ThreePointRenderer is not attached to a Three.js scene");
    }
    if (!nodeKey) {
      throw new Error("Three.js rendered nodes require a non-empty node key");
    }

    assertPointCount(points);
    const rendererStartedAt = performanceNow();
    const worldCoordinates = toWorldCoordinates(points);
    if (!this.localOrigin) {
      const derivedOrigin = deriveOrigin(worldCoordinates);
      if (derivedOrigin) {
        this.localOrigin = derivedOrigin;
      }
    }
    const origin = this.localOrigin ?? {
      coordinateSystem: "wgs84-ecef-meters" as const,
      x: 0,
      y: 0,
      z: 0,
    };

    const localStartedAt = performanceNow();
    const localCoordinates = this.localFrame
      ? worldBufferToDatasetLocal(worldCoordinates, this.localFrame)
      : worldBufferToLocal(worldCoordinates, origin);
    const positions = new Float32Array(localCoordinates);
    options.onPerformance?.(
      "worldToLocal",
      performanceNow() - localStartedAt,
      points.pointCount,
    );

    const geometryStartedAt = performanceNow();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute(
      "color",
      new THREE.BufferAttribute(
        prepareThreePointColorBuffer(points, {
          colorMode: options.colorMode,
          elevationRange: options.elevationRange,
          rgbMax: options.rgbMax,
          dimension: options.dimension,
        }),
        3,
      ),
    );
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    options.onPerformance?.(
      "geometryCreation",
      performanceNow() - geometryStartedAt,
      points.pointCount,
    );

    const materialStartedAt = performanceNow();
    let material: THREE.PointsMaterial;
    try {
      material = createMaterial(options.pointSize, this.opacity);
    } catch (error) {
      geometry.dispose();
      throw error;
    }
    options.onPerformance?.(
      "materialCreation",
      performanceNow() - materialStartedAt,
      points.pointCount,
    );

    const renderedPoints = new THREE.Points(geometry, material);
    renderedPoints.visible = this.opacity !== 0;
    renderedPoints.name = nodeKey;
    renderedPoints.userData.copcNodeKey = nodeKey;
    renderedPoints.userData.nodeKey = nodeKey;
    renderedPoints.userData.copcPointId = options.pointId;
    renderedPoints.userData.copcPointCount = points.pointCount;
    renderedPoints.userData.copcPerformanceObserver = options.onPerformance;

    const previous = this.pointsByNode.get(nodeKey);
    if (previous) {
      this.removeNode(nodeKey);
    }

    this.root.add(renderedPoints);
    this.pointsByNode.set(nodeKey, renderedPoints);
    options.onPerformance?.(
      "rendererPreparation",
      performanceNow() - rendererStartedAt,
      points.pointCount,
    );
  }

  /** Remove one node and dispose its geometry and material. */
  removeNode(nodeKey: string): void {
    const points = this.pointsByNode.get(nodeKey);
    if (!points) {
      return;
    }

    const startedAt = performanceNow();
    this.disposeNode(nodeKey, points);
    const observer = points.userData.copcPerformanceObserver as
      | ThreePointRendererOptions["onPerformance"]
      | undefined;
    observer?.(
      "nodeRemoval",
      performanceNow() - startedAt,
      points.userData.copcPointCount ?? 0,
    );
  }

  /** Remove and dispose all node objects while keeping the renderer reusable. */
  clear(): void {
    for (const nodeKey of [...this.pointsByNode.keys()]) {
      this.removeNode(nodeKey);
    }
  }

  /** Detach the root group and permanently release renderer-owned resources. */
  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.detachFrom();
    this.destroyed = true;
  }

  /** Return whether a node has a committed `THREE.Points` object. */
  hasNode(nodeKey: string): boolean {
    return this.pointsByNode.has(nodeKey);
  }

  /** Return the point count for one committed node, or `undefined` when absent. */
  getRenderedNodePointCount(nodeKey: string): number | undefined {
    return this.pointsByNode.get(nodeKey)?.geometry.getAttribute("position")
      ?.count;
  }

  /** Return sorted keys for nodes currently committed to the scene. */
  getRenderedNodeKeys(): string[] {
    return [...this.pointsByNode.keys()].sort();
  }

  /** Return the number of points currently committed to the scene. */
  getRenderedPointCount(): number {
    let total = 0;
    for (const points of this.pointsByNode.values()) {
      total += points.geometry.getAttribute("position")?.count ?? 0;
    }
    return total;
  }

  private disposeNode(nodeKey: string, points: THREE.Points): void {
    this.root.remove(points);
    points.geometry.dispose();
    const material = points.material;
    if (Array.isArray(material)) {
      for (const item of material) {
        item.dispose();
      }
    } else {
      material.dispose();
    }
    if (this.pointsByNode.get(nodeKey) === points) {
      this.pointsByNode.delete(nodeKey);
    }
  }
}

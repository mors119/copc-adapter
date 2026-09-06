import * as THREE from 'three';
import type { CopcMetadata, GeographicPointBuffer } from '../../copc/types/copc';
import { performanceNow } from '../../copc/performance';
import { createPointTransformer } from '../../coordinates/transform/createPointTransformer';
import {
  geographicToEcef,
  worldBufferToLocal,
} from '../../coordinates/transform/worldCoordinates';
import type { Wgs84EcefPoint } from '../../coordinates/types';
import type {
  CopcPointRenderer,
  CopcPointRendererOptions,
} from '../../viewer/streaming/renderer';

const FIXED_POINT_COLOR = 0x00ffff;

export type ThreePointRendererPerformanceStage =
  | 'worldToLocal'
  | 'geometryCreation'
  | 'materialCreation'
  | 'rendererPreparation'
  | 'nodeRemoval';

export type ThreePointRendererOptions = CopcPointRendererOptions & {
  /** Optional renderer preparation observer used by adapter diagnostics. */
  onPerformance?: (
    stage: ThreePointRendererPerformanceStage,
    durationMs: number,
    pointCount: number,
  ) => void;
};

export type ThreePointRendererConstructorOptions = {
  /**
   * Fixed ECEF origin for the lifetime of the renderer. Passing the origin
   * derived from dataset metadata is recommended for a stable application
   * frame; without one, the first non-empty node chooses the origin.
   */
  localOrigin?: Wgs84EcefPoint;
};

/** Metadata-derived origin for the renderer-local ECEF frame. */
export function createThreeLocalOrigin(metadata: CopcMetadata): Wgs84EcefPoint {
  const transformPoint = createPointTransformer(metadata);
  const { minX, minY, minZ, maxX, maxY, maxZ } = metadata.cube;
  const center = transformPoint({
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
    z: (minZ + maxZ) / 2,
  });
  return geographicToEcef(center);
}

function assertPointCount(points: GeographicPointBuffer): void {
  if (!Number.isSafeInteger(points.pointCount) || points.pointCount < 0) {
    throw new Error('Three.js point buffers must have a non-negative safe point count');
  }

  if (points.coordinates.length !== points.pointCount * 3) {
    throw new Error('Three.js point buffers must contain three geographic values per point');
  }

  if (points.worldCoordinates
    && points.worldCoordinates.length !== points.pointCount * 3) {
    throw new Error('Three.js world point buffers must contain three values per point');
  }

  if (points.worldCoordinateSystem
    && points.worldCoordinateSystem !== 'wgs84-ecef-meters') {
    throw new Error('Three.js point buffers must use wgs84-ecef-meters world coordinates');
  }
}

function assertFiniteCoordinates(coordinates: Float64Array, label: string): void {
  for (const value of coordinates) {
    if (!Number.isFinite(value)) {
      throw new Error(`Three.js ${label} coordinates must be finite`);
    }
  }
}

function toWorldCoordinates(points: GeographicPointBuffer): Float64Array {
  if (points.worldCoordinates) {
    assertFiniteCoordinates(points.worldCoordinates, 'world');
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
    throw new Error('Three.js local origin must have finite coordinates');
  }
  if (point.coordinateSystem !== 'wgs84-ecef-meters') {
    throw new Error('Three.js local origin must use wgs84-ecef-meters');
  }
  return {
    coordinateSystem: 'wgs84-ecef-meters',
    x: point.x,
    y: point.y,
    z: point.z,
  };
}

function deriveOrigin(worldCoordinates: Float64Array): Wgs84EcefPoint | undefined {
  if (worldCoordinates.length === 0) {
    return undefined;
  }

  return {
    coordinateSystem: 'wgs84-ecef-meters',
    x: worldCoordinates[0],
    y: worldCoordinates[1],
    z: worldCoordinates[2],
  };
}

function createMaterial(pointSize: number): THREE.PointsMaterial {
  if (!Number.isFinite(pointSize) || pointSize <= 0) {
    throw new Error('Three.js pointSize must be a positive finite number');
  }

  return new THREE.PointsMaterial({
    color: FIXED_POINT_COLOR,
    opacity: 0.9,
    size: pointSize,
    sizeAttenuation: false,
    transparent: true,
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
  private destroyed = false;

  constructor(options: ThreePointRendererConstructorOptions = {}) {
    this.localOrigin = options.localOrigin
      ? copyEcefPoint(options.localOrigin)
      : undefined;
    this.root.name = 'copc-three-root';
  }

  /** Attach the adapter-owned root group to the caller-owned scene. */
  attachTo(scene: THREE.Scene): void {
    if (this.destroyed) {
      throw new Error('ThreePointRenderer has been destroyed');
    }
    if (!scene || typeof scene.add !== 'function') {
      throw new Error('ThreePointRenderer requires a Three.js scene');
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

  /** Return the stable ECEF origin used for local vertex positions. */
  getLocalOrigin(): Wgs84EcefPoint | undefined {
    return this.localOrigin ? { ...this.localOrigin } : undefined;
  }

  addOrUpdateNode(
    nodeKey: string,
    points: GeographicPointBuffer,
    options: ThreePointRendererOptions,
  ): void {
    if (this.destroyed) {
      throw new Error('ThreePointRenderer has been destroyed');
    }
    if (!this.scene) {
      throw new Error('ThreePointRenderer is not attached to a Three.js scene');
    }
    if (!nodeKey) {
      throw new Error('Three.js rendered nodes require a non-empty node key');
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
      coordinateSystem: 'wgs84-ecef-meters' as const,
      x: 0,
      y: 0,
      z: 0,
    };

    const localStartedAt = performanceNow();
    const localCoordinates = worldBufferToLocal(worldCoordinates, origin);
    const positions = new Float32Array(localCoordinates);
    options.onPerformance?.(
      'worldToLocal',
      performanceNow() - localStartedAt,
      points.pointCount,
    );

    const geometryStartedAt = performanceNow();
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    options.onPerformance?.(
      'geometryCreation',
      performanceNow() - geometryStartedAt,
      points.pointCount,
    );

    const materialStartedAt = performanceNow();
    let material: THREE.PointsMaterial;
    try {
      material = createMaterial(options.pointSize);
    } catch (error) {
      geometry.dispose();
      throw error;
    }
    options.onPerformance?.(
      'materialCreation',
      performanceNow() - materialStartedAt,
      points.pointCount,
    );

    const renderedPoints = new THREE.Points(geometry, material);
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
      'rendererPreparation',
      performanceNow() - rendererStartedAt,
      points.pointCount,
    );
  }

  removeNode(nodeKey: string): void {
    const points = this.pointsByNode.get(nodeKey);
    if (!points) {
      return;
    }

    const startedAt = performanceNow();
    this.disposeNode(nodeKey, points);
    const observer = points.userData.copcPerformanceObserver as
      | ThreePointRendererOptions['onPerformance']
      | undefined;
    observer?.('nodeRemoval', performanceNow() - startedAt, points.userData.copcPointCount ?? 0);
  }

  clear(): void {
    for (const nodeKey of [...this.pointsByNode.keys()]) {
      this.removeNode(nodeKey);
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.detachFrom();
    this.destroyed = true;
  }

  hasNode(nodeKey: string): boolean {
    return this.pointsByNode.has(nodeKey);
  }

  getRenderedNodePointCount(nodeKey: string): number | undefined {
    return this.pointsByNode.get(nodeKey)?.geometry.getAttribute('position')?.count;
  }

  getRenderedNodeKeys(): string[] {
    return [...this.pointsByNode.keys()].sort();
  }

  getRenderedPointCount(): number {
    let total = 0;
    for (const points of this.pointsByNode.values()) {
      total += points.geometry.getAttribute('position')?.count ?? 0;
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

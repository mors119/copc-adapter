import * as Cesium from 'cesium';
import type { GeographicPointBuffer, PreparedPointData } from '../../core/copc/types/copc';
import { performanceNow } from '../../core/copc/performance';
import { prepareCopcPointColorBuffer } from '../../core/point/style/pointStyle';
import type { CopcPointPickId } from '../../core/copc/points/pointInspection';
import type { CopcCesiumPointRendererOptions, CesiumPointRenderer } from './CopcPointRenderer';
import { packRelativeEcef } from './relativeEcef';

type PointData = GeographicPointBuffer | PreparedPointData;

const VERTEX_SHADER = `
in vec3 position3DHigh;
in vec3 position3DLow;
in vec3 a_color;
in float a_pointSize;
in float batchId;
out vec3 v_color;
out float v_show;
void main() {
  gl_Position = czm_modelViewProjectionRelativeToEye * czm_computePosition();
  gl_PointSize = abs(a_pointSize) * czm_pixelRatio;
  v_color = a_color;
  v_show = a_pointSize < 0.0 ? 0.0 : 1.0;
}`;

const FRAGMENT_SHADER = `
in vec3 v_color;
in float v_show;
void main() {
  if (v_show < 0.5) discard;
  vec2 point = gl_PointCoord - vec2(0.5);
  if (dot(point, point) > 0.25) discard;
  out_FragColor = vec4(v_color, 1.0);
}`;

type NodeRecord = {
  primitive: Cesium.Primitive;
  sphere?: Cesium.BoundingSphere;
  origin: Cesium.Cartesian3;
  positions: Float32Array;
  /** Shared prepared ECEF buffer also held by the Cesium Geometry attribute. */
  worldCoordinates: Float64Array;
  pointSizes: Float32Array;
  sourcePointCount: number;
  pointCount: number;
  pointSizePx: number;
  ownerId?: string;
  generation: number;
  observer?: CopcCesiumPointRendererOptions['onPerformance'];
};

const scratchViewProjectionMatrix = new Cesium.Matrix4();

function getPickWidth(clickTolerancePx: number): number {
  const tolerance = Number.isFinite(clickTolerancePx) ? Math.max(0, clickTolerancePx) : 1.5;
  return Math.max(1, 2 * Math.floor(tolerance) + 1);
}

// The WebGL minimum depth-buffer precision is 16 bits. Cesium's public pick
// API does not expose the precision of its offscreen pick framebuffer, so use
// that floor rather than assuming the Viewer framebuffer's format is shared.
const PICK_DEPTH_QUANTUM = 1 / (2 ** 16 - 1);
const GPU_POSITION_ROUNDING_ULPS = 16;

/** Match the ideal depth value produced by Cesium's current public scene mode. */
function projectPickDepth(scene: Cesium.Scene, viewDepth: number): number {
  const frustum = scene.camera.frustum;
  const projection = frustum.projectionMatrix;
  const perspective = Math.abs(projection[11]) > Number.EPSILON;
  if (scene.logarithmicDepthBuffer && perspective) {
    // Cesium's log-depth shader writes log2(eyeDepth - near + 1), normalized
    // by the current frustum's far-to-near span. The camera frustum is a
    // conservative superset when Cesium splits rendering into sub-frustums.
    const near = frustum.near;
    const far = frustum.far;
    const denominator = Math.log2(Math.max(1 + Number.EPSILON, far - near + 1));
    const depth = Math.log2(Math.max(1, viewDepth - near + 1)) / denominator;
    return Math.max(0, Math.min(1, depth));
  }

  // Cesium's ordinary perspective/orthographic projection maps NDC z into
  // the [0, 1] depth range. Use the projection matrix so oblique and
  // orthographic frustums retain their own mapping.
  const clipZ = projection[10] * -viewDepth + projection[14];
  const clipW = projection[11] * -viewDepth + projection[15];
  if (!Number.isFinite(clipZ) || !Number.isFinite(clipW) || clipW === 0) {
    return Number.NaN;
  }
  return Math.max(0, Math.min(1, (clipZ / clipW + 1) * 0.5));
}

/** Bound point-position uncertainty after Float32 staging and GPU arithmetic. */
function getPickDepthPositionUncertainty(
  scene: Cesium.Scene,
  viewDepth: number,
): number {
  const gpuArithmeticError = GPU_POSITION_ROUNDING_ULPS
    * 2 ** -23 * Math.max(1, viewDepth);
  const errorMeters = gpuArithmeticError;
  const centerDepth = projectPickDepth(scene, viewDepth);
  const beforeDepth = projectPickDepth(
    scene,
    Math.max(scene.camera.frustum.near, viewDepth - errorMeters),
  );
  const afterDepth = projectPickDepth(
    scene,
    Math.min(scene.camera.frustum.far, viewDepth + errorMeters),
  );
  return Math.max(Math.abs(centerDepth - beforeDepth), Math.abs(afterDepth - centerDepth));
}

/** Result from the research-only CPU second-stage picking probe. */
export type CpuPointPickProbe = {
  picked: boolean;
  nodeKey?: string;
  ownerId?: string;
  pointIndex?: number;
  pickWidth?: number;
  screenDistancePx?: number;
  viewDepthMeters?: number;
  worldPosition?: [number, number, number];
  candidateCount: number;
  scannedPointCount: number;
  scenePickDurationMs: number;
  cpuResolveDurationMs: number;
  totalDurationMs: number;
  reason?: 'no-scene-pick' | 'not-research-node' | 'hidden-node' | 'no-visible-candidate'
    | 'ambiguous-depth' | 'ambiguous-pick-window' | 'unsupported-scene-mode';
};

/**
 * Opt-in batched Cesium Geometry(POINTS) renderer. One GeometryInstance id is
 * shared by each node, so source point identities are resolved on demand from
 * the renderer's current CPU staging buffers after Cesium's scene pick.
 *
 * CPU picking is conservative: if a pick window contains multiple possible
 * winners or depth intervals that overlap, it returns no identity. Tested
 * with Cesium 1.142.0 and 1.146.0; the package peer range remains broader.
 * @experimental
 */
export class BatchedGeometryPointRenderer implements CesiumPointRenderer {
  private viewer?: Cesium.Viewer;
  private parent?: Cesium.PrimitiveCollection;
  private showState = true;
  private readonly nodes = new Map<string, NodeRecord>();
  private nextGeneration = 0;

  /** Attach a renderer-owned primitive container to a caller-owned Viewer. */
  attachTo(viewer: Cesium.Viewer): void {
    if (this.viewer === viewer) return;
    this.detachFrom();
    this.viewer = viewer;
    this.parent = viewer.scene.primitives.add(
      new Cesium.PrimitiveCollection({ show: this.showState }),
    );
  }

  /** Remove all node primitives and the renderer-owned container. */
  detachFrom(): void {
    this.clear();
    if (this.parent) this.viewer?.scene.primitives.remove(this.parent);
    this.parent = undefined;
    this.viewer = undefined;
  }

  /** Set visibility for all node primitives. */
  setShow(show: boolean): void {
    this.showState = show;
    if (this.parent) this.parent.show = show;
  }

  /** Build or atomically replace the single point Geometry for one prepared node. */
  addOrUpdateNode(nodeKey: string, points: PointData, options: CopcCesiumPointRendererOptions): void {
    if (!this.viewer || !this.parent) {
      throw new Error('BatchedGeometryPointRenderer is not attached to a Cesium viewer');
    }
    const previous = this.nodes.get(nodeKey);
    const startedAt = performanceNow();
    const ecef = points.worldCoordinates;
    if (!Number.isSafeInteger(points.pointCount) || points.pointCount <= 0) {
      throw new Error('Batched Geometry renderer requires a nonempty point buffer');
    }
    if (!Number.isFinite(options.pointSize) || options.pointSize <= 0) {
      throw new Error('Batched Geometry renderer requires a positive finite point size');
    }
    if (points.coordinates.length !== points.pointCount * 3) {
      throw new Error('Batched Geometry renderer requires XYZ coordinates for every point');
    }
    if (!ecef || points.worldCoordinateSystem !== 'wgs84-ecef-meters'
      || ecef.length !== points.pointCount * 3) {
      throw new Error('Batched Geometry renderer requires prepared WGS84 ECEF coordinates');
    }

    const relative = packRelativeEcef(ecef);
    const origin = new Cesium.Cartesian3(...relative.origin);
    const positions = relative.positions;
    // A zero-radius primitive is culled by some supported Cesium versions
    // before point-sprite expansion, so retain a centimetre of world-space
    // extent even when every source point has identical coordinates.
    const conservativeRadius = Math.max(
      relative.radius + relative.maxAbsoluteError * Math.sqrt(3),
      0.01,
    );
    options.onPerformance?.('worldToCartesian', performanceNow() - startedAt, points.pointCount);

    const styleStartedAt = performanceNow();
    const colors = prepareCopcPointColorBuffer(points, {
      colorMode: options.colorMode,
      elevationRange: options.elevationRange,
      rgbMax: options.rgbMax,
    });
    const pointSizes = new Float32Array(points.pointCount);
    const batchIds = new Float32Array(points.pointCount);
    const visibleMinimum = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const visibleMaximum = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    let visibleCount = 0;
    for (let index = 0; index < points.pointCount; index += 1) {
      const visible = options.pointFilter?.(index) ?? true;
      pointSizes[index] = visible ? options.pointSize : -options.pointSize;
      if (visible) {
        visibleCount += 1;
        const offset = index * 3;
        for (let axis = 0; axis < 3; axis += 1) {
          visibleMinimum[axis] = Math.min(visibleMinimum[axis], positions[offset + axis]);
          visibleMaximum[axis] = Math.max(visibleMaximum[axis], positions[offset + axis]);
        }
      }
    }
    options.onPerformance?.('pointStylePreparation', performanceNow() - styleStartedAt, points.pointCount);

    const pointIdentity = options.pointId?.(0) as { ownerId?: unknown } | undefined;
    const ownerId = typeof pointIdentity?.ownerId === 'string'
      ? pointIdentity.ownerId
      : undefined;
    this.nextGeneration += 1;
    const generation = this.nextGeneration;

    const creationStartedAt = performanceNow();
    const attributes = new Cesium.GeometryAttributes() as Cesium.GeometryAttributes & {
      a_color: Cesium.GeometryAttribute;
      a_pointSize: Cesium.GeometryAttribute;
      batchId: Cesium.GeometryAttribute;
    };
    attributes.position = new Cesium.GeometryAttribute({
      // Keep the prepared absolute ECEF doubles here. Cesium's public
      // Primitive pipeline splits them into high/low GPU coordinates and
      // projects them for 2D/Columbus View. A local Float32 position plus a
      // Primitive modelMatrix works in scene3DOnly mode, but the standard
      // Viewer pipeline also needs position2D and boundingSphereCV.
      componentDatatype: Cesium.ComponentDatatype.DOUBLE,
      componentsPerAttribute: 3,
      values: ecef,
    });
    attributes.a_color = new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          values: colors,
        });
    attributes.a_pointSize = new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 1,
          values: pointSizes,
        });
    attributes.batchId = new Cesium.GeometryAttribute({
      componentDatatype: Cesium.ComponentDatatype.FLOAT,
      componentsPerAttribute: 1,
      values: batchIds,
    });
    const geometry = new Cesium.Geometry({
      attributes,
      primitiveType: Cesium.PrimitiveType.POINTS,
      boundingSphere: new Cesium.BoundingSphere(origin, conservativeRadius),
    });
    const primitive = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry,
        // Public Primitive picking identifies a GeometryInstance, not a vertex.
        id: {
          nodeKey,
          ...(ownerId === undefined ? {} : { ownerId }),
          batchedGeneration: generation,
        },
      }),
      appearance: new Cesium.Appearance({
        vertexShaderSource: VERTEX_SHADER,
        fragmentShaderSource: FRAGMENT_SHADER,
        renderState: {
          depthTest: { enabled: true },
          // Keep GPU visibility ordered by the same nearest-depth rule used
          // by the CPU identity resolver for overlapping points in this node.
          depthMask: true,
          blending: Cesium.BlendingState.ALPHA_BLEND,
        },
      }),
      asynchronous: false,
      allowPicking: true,
      releaseGeometryInstances: false,
    });
    let visibleSphere: Cesium.BoundingSphere | undefined;
    if (visibleCount > 0) {
      const centerRelative: [number, number, number] = [
        (visibleMinimum[0] + visibleMaximum[0]) / 2,
        (visibleMinimum[1] + visibleMaximum[1]) / 2,
        (visibleMinimum[2] + visibleMaximum[2]) / 2,
      ];
      let visibleRadiusSquared = 0;
      for (let index = 0; index < points.pointCount; index += 1) {
        if ((pointSizes[index] ?? 0) < 0) continue;
        const offset = index * 3;
        const dx = positions[offset] - centerRelative[0];
        const dy = positions[offset + 1] - centerRelative[1];
        const dz = positions[offset + 2] - centerRelative[2];
        visibleRadiusSquared = Math.max(visibleRadiusSquared, dx * dx + dy * dy + dz * dz);
      }
      visibleSphere = new Cesium.BoundingSphere(
        new Cesium.Cartesian3(
          origin.x + centerRelative[0],
          origin.y + centerRelative[1],
          origin.z + centerRelative[2],
        ),
        Math.sqrt(visibleRadiusSquared) + relative.maxAbsoluteError * Math.sqrt(3),
      );
    }
    options.onPerformance?.('pointCollectionCreation', performanceNow() - creationStartedAt, points.pointCount);
    const addStartedAt = performanceNow();
    try {
      this.parent.add(primitive);
    } catch (error) {
      if (this.parent.contains(primitive)) {
        this.parent.remove(primitive);
      } else if (!primitive.isDestroyed()) {
        primitive.destroy();
      }
      throw error;
    }
    const committedNode: NodeRecord = {
      primitive,
      sphere: visibleSphere,
      origin,
      positions,
      worldCoordinates: ecef,
      pointSizes,
      sourcePointCount: points.pointCount,
      pointCount: visibleCount,
      pointSizePx: Math.abs(options.pointSize),
      ownerId,
      generation,
      observer: options.onPerformance,
    };
    this.nodes.set(nodeKey, committedNode);
    if (previous) {
      const removalStartedAt = performanceNow();
      this.parent.remove(previous.primitive);
      previous.observer?.('nodeRemoval', performanceNow() - removalStartedAt, previous.pointCount);
    }
    options.onPerformance?.('pointAdd', performanceNow() - addStartedAt, points.pointCount);
    options.onPerformance?.('rendererPreparation', performanceNow() - startedAt, points.pointCount);
  }

  /** Replace one node's geometry to apply style or filter updates. */
  updateNodeStyle(nodeKey: string, points: PointData, options: CopcCesiumPointRendererOptions): void {
    this.addOrUpdateNode(nodeKey, points, options);
  }

  /** Remove and release one node's Cesium primitive. */
  removeNode(nodeKey: string): void {
    const node = this.nodes.get(nodeKey);
    if (!node) return;
    const startedAt = performanceNow();
    this.parent?.remove(node.primitive);
    this.nodes.delete(nodeKey);
    node.observer?.('nodeRemoval', performanceNow() - startedAt, node.pointCount);
  }

  /** Remove every node while keeping the attached container reusable. */
  clear(): void {
    for (const key of [...this.nodes.keys()]) this.removeNode(key);
  }

  /** Detach and release all renderer-owned Cesium resources. */
  destroy(): void {
    this.detachFrom();
  }

  /** Return whether a node currently has a committed geometry. */
  hasNode(nodeKey: string): boolean { return this.nodes.has(nodeKey); }
  /** Return the visible point count for a committed node. */
  getRenderedNodePointCount(nodeKey: string): number | undefined { return this.nodes.get(nodeKey)?.pointCount; }
  /** Return sorted node keys currently committed to Cesium. */
  getRenderedNodeKeys(): string[] { return [...this.nodes.keys()].sort(); }
  /** Return the total visible point count across committed nodes. */
  getRenderedPointCount(): number {
    return [...this.nodes.values()].reduce((count, node) => count + node.pointCount, 0);
  }
  /** Return a cloned WGS84 ECEF sphere enclosing visible node bounds. */
  getSelectionBoundingSphere(): Cesium.BoundingSphere | undefined {
    const spheres = [...this.nodes.values()]
      .flatMap((node) => node.sphere ? [node.sphere] : []);
    return spheres.length ? Cesium.BoundingSphere.fromBoundingSpheres(spheres) : undefined;
  }

  /** Resolve a node-level Cesium pick to a conservative source point identity. */
  resolvePointPick(
    scene: Cesium.Scene,
    windowPosition: Cesium.Cartesian2,
    pickedObject: unknown,
  ): CopcPointPickId | undefined {
    // CesiumPointPicker requests one pixel for this optional capability, so
    // the GPU hit and CPU refinement use the same deterministic sample.
    const result = this.resolveCpuPointPick(scene, windowPosition, pickedObject, 0.5);
    if (!result.picked || result.pointIndex === undefined || result.nodeKey === undefined) {
      return undefined;
    }
    return {
      nodeKey: result.nodeKey,
      pointIndex: result.pointIndex,
      ...(result.ownerId === undefined ? {} : { ownerId: result.ownerId }),
    };
  }

  /** Probe public scene picking; returned ids are node-level, not point-level. */
  probePick(scene: Cesium.Scene, nodeKey: string): {
    picked: boolean;
    pickedNodeKey?: string;
    pointIndex?: number;
    targetSourcePointIndex?: number;
    screenPosition?: { x: number; y: number };
    worldPosition?: [number, number, number];
  } {
    const node = this.nodes.get(nodeKey);
    if (!node) return { picked: false };
    const stride = Math.max(1, Math.floor(node.sourcePointCount / 500));
    const world = new Cesium.Cartesian3();
    const windowPosition = new Cesium.Cartesian2();
    for (let index = 0; index < node.sourcePointCount; index += stride) {
      if ((node.pointSizes[index] ?? 0) <= 0) continue;
      const offset = index * 3;
      world.x = node.worldCoordinates[offset];
      world.y = node.worldCoordinates[offset + 1];
      world.z = node.worldCoordinates[offset + 2];
      const screen = Cesium.SceneTransforms.worldToWindowCoordinates(scene, world, windowPosition);
      if (!screen || screen.x < 0 || screen.y < 0
        || screen.x >= scene.canvas.clientWidth || screen.y >= scene.canvas.clientHeight) {
        continue;
      }
      const picked = scene.pick(screen) as { id?: unknown } | undefined;
      if (!picked) continue;
      const id = picked.id as { nodeKey?: unknown; pointIndex?: unknown } | undefined;
      if (id?.nodeKey === nodeKey) {
        return {
          picked: true,
          pickedNodeKey: nodeKey,
          ...(typeof id.pointIndex === 'number' ? { pointIndex: id.pointIndex } : {}),
          targetSourcePointIndex: index,
          screenPosition: { x: screen.x, y: screen.y },
          worldPosition: [world.x, world.y, world.z],
        };
      }
    }
    return { picked: false };
  }

  /**
   * Research-only second stage: use Cesium's node-level scene pick, then scan
   * just that node's current prepared ECEF buffer on demand. This is the same
   * Float64Array used by the Geometry position attribute, so no point buffer
   * is copied and CPU point centers match Cesium's source coordinates.
   * It accepts a point only when every occupied sample pixel in Cesium's pick
   * rectangle has the same unique point winner. This intentionally avoids
   * depending on Cesium's undocumented pixel traversal order. No per-frame
   * projection or cache is maintained.
   */
  probeCpuPointPick(
    scene: Cesium.Scene,
    windowPosition: Cesium.Cartesian2,
    clickTolerancePx = 1.5,
  ): CpuPointPickProbe {
    const totalStartedAt = performanceNow();
    const scenePickStartedAt = performanceNow();
    const pickWidth = getPickWidth(clickTolerancePx);
    const picked = scene.pick(windowPosition, pickWidth, pickWidth) as { id?: unknown } | undefined;
    const scenePickDurationMs = performanceNow() - scenePickStartedAt;
    const probe = this.resolveCpuPointPick(scene, windowPosition, picked, clickTolerancePx);
    return {
      ...probe,
      scenePickDurationMs,
      totalDurationMs: performanceNow() - totalStartedAt,
    };
  }

  /** Refine a node-level object returned by `scene.pick` without another GPU pick. */
  resolveCpuPointPick(
    scene: Cesium.Scene,
    windowPosition: Cesium.Cartesian2,
    pickedObject: unknown,
    clickTolerancePx = 1.5,
  ): CpuPointPickProbe {
    const totalStartedAt = performanceNow();
    const pickWidth = getPickWidth(clickTolerancePx);
    const picked = pickedObject as { id?: unknown } | undefined;
    const scenePickDurationMs = 0;
    if (!picked) {
      return {
        picked: false,
        candidateCount: 0,
        scannedPointCount: 0,
        scenePickDurationMs,
        cpuResolveDurationMs: 0,
        totalDurationMs: performanceNow() - totalStartedAt,
        reason: 'no-scene-pick',
      };
    }

    const id = picked.id as {
      nodeKey?: unknown;
      ownerId?: unknown;
      batchedGeneration?: unknown;
    } | undefined;
    if (typeof id?.nodeKey !== 'string') {
      return {
        picked: false,
        candidateCount: 0,
        scannedPointCount: 0,
        scenePickDurationMs,
        cpuResolveDurationMs: 0,
        totalDurationMs: performanceNow() - totalStartedAt,
        reason: 'not-research-node',
      };
    }
    const nodeKey = id.nodeKey;
    const node = this.nodes.get(nodeKey);
    if (!node || id.batchedGeneration !== node.generation
      || id.ownerId !== node.ownerId) {
      return {
        picked: false,
        nodeKey,
        ...(typeof id.ownerId === 'string' ? { ownerId: id.ownerId } : {}),
        candidateCount: 0,
        scannedPointCount: 0,
        scenePickDurationMs,
        cpuResolveDurationMs: 0,
        totalDurationMs: performanceNow() - totalStartedAt,
        reason: 'not-research-node',
      };
    }
    if (!this.showState || !this.parent?.show) {
      return {
        picked: false,
        nodeKey,
        ...(node.ownerId === undefined ? {} : { ownerId: node.ownerId }),
        candidateCount: 0,
        scannedPointCount: 0,
        scenePickDurationMs,
        cpuResolveDurationMs: 0,
        totalDurationMs: performanceNow() - totalStartedAt,
        reason: 'hidden-node',
      };
    }
    if (scene.mode !== Cesium.SceneMode.SCENE3D) {
      return {
        picked: false,
        nodeKey,
        ...(node.ownerId === undefined ? {} : { ownerId: node.ownerId }),
        candidateCount: 0,
        scannedPointCount: 0,
        scenePickDurationMs,
        cpuResolveDurationMs: 0,
        totalDurationMs: performanceNow() - totalStartedAt,
        reason: 'unsupported-scene-mode',
      };
    }

    const cpuStartedAt = performanceNow();
    const camera = scene.camera;
    const viewMatrix = camera.viewMatrix;
    const viewProjection = Cesium.Matrix4.multiply(
      camera.frustum.projectionMatrix,
      viewMatrix,
      scratchViewProjectionMatrix,
    );
    const drawingBufferWidth = scene.drawingBufferWidth;
    const drawingBufferHeight = scene.drawingBufferHeight;
    const scaleX = drawingBufferWidth / scene.canvas.clientWidth;
    const scaleY = drawingBufferHeight / scene.canvas.clientHeight;
    const positionBufferX = windowPosition.x * scaleX;
    const positionBufferY = windowPosition.y * scaleY;
    // In Cesium 1.146.0, Picking.js computes a centered rectangle and WebGL
    // converts its origin to integer framebuffer coordinates. The pick
    // framebuffer currently visits readback pixels in a center-first square
    // spiral; this is an implementation detail verified by the probe.
    const left = Math.trunc(positionBufferX - (pickWidth - 1) * 0.5);
    const bottom = Math.trunc(drawingBufferHeight - positionBufferY - (pickWidth - 1) * 0.5);
    const sampleCount = pickWidth * pickWidth;
    const sampleX = new Float64Array(sampleCount);
    const sampleY = new Float64Array(sampleCount);
    const sampleWinnerDepthLower = new Float64Array(sampleCount);
    const sampleWinnerDepthUpper = new Float64Array(sampleCount);
    const sampleOtherMinimumDepthLower = new Float64Array(sampleCount);
    const sampleViewDepth = new Float64Array(sampleCount);
    const samplePointIndex = new Int32Array(sampleCount);
    sampleWinnerDepthLower.fill(Number.POSITIVE_INFINITY);
    sampleWinnerDepthUpper.fill(Number.POSITIVE_INFINITY);
    sampleOtherMinimumDepthLower.fill(Number.POSITIVE_INFINITY);
    samplePointIndex.fill(-1);
    const sampleValid = new Uint8Array(sampleCount);
    for (let row = 0; row < pickWidth; row += 1) {
      for (let column = 0; column < pickWidth; column += 1) {
        const sampleIndex = row * pickWidth + column;
        const bufferX = left + column + 0.5;
        const bufferY = bottom + row + 0.5;
        sampleX[sampleIndex] = bufferX;
        sampleY[sampleIndex] = bufferY;
        sampleValid[sampleIndex] = bufferX >= 0 && bufferX < drawingBufferWidth
          && bufferY >= 0 && bufferY < drawingBufferHeight ? 1 : 0;
      }
    }

    // Point sizes use CSS pixels, matching Cesium PointPrimitive. Projected
    // coordinates are in drawing-buffer pixels, so convert with the current
    // public canvas scale, including high-DPI and resolution scaling.
    const pointRadius = node.pointSizePx * 0.5 * scaleX;
    const pointRadiusSquared = pointRadius * pointRadius;
    const world = new Cesium.Cartesian3();
    let candidateCount = 0;
    for (let pointIndex = 0; pointIndex < node.sourcePointCount; pointIndex += 1) {
      if ((node.pointSizes[pointIndex] ?? 0) <= 0) continue;
      const offset = pointIndex * 3;
      world.x = node.worldCoordinates[offset];
      world.y = node.worldCoordinates[offset + 1];
      world.z = node.worldCoordinates[offset + 2];

      const viewDepth = -(viewMatrix[2] * world.x
        + viewMatrix[6] * world.y
        + viewMatrix[10] * world.z
        + viewMatrix[14]);
      if (viewDepth <= camera.frustum.near || viewDepth >= camera.frustum.far) continue;
      const gpuDepth = projectPickDepth(scene, viewDepth);
      if (!Number.isFinite(gpuDepth)) continue;
      const depthPositionUncertainty = getPickDepthPositionUncertainty(
        scene,
        viewDepth,
      );

      const clipX = viewProjection[0] * world.x
        + viewProjection[4] * world.y
        + viewProjection[8] * world.z
        + viewProjection[12];
      const clipY = viewProjection[1] * world.x
        + viewProjection[5] * world.y
        + viewProjection[9] * world.z
        + viewProjection[13];
      const clipZ = viewProjection[2] * world.x
        + viewProjection[6] * world.y
        + viewProjection[10] * world.z
        + viewProjection[14];
      const clipW = viewProjection[3] * world.x
        + viewProjection[7] * world.y
        + viewProjection[11] * world.z
        + viewProjection[15];
      if (clipW <= 0 || clipZ < -clipW || clipZ > clipW) continue;
      const screenX = (clipX / clipW + 1) * drawingBufferWidth * 0.5;
      const screenY = (1 - clipY / clipW) * drawingBufferHeight * 0.5;
      // Most points are immediately rejected by the small pick rectangle.
      if (screenX < left - pointRadius - 0.5 || screenX > left + pickWidth - 0.5 + pointRadius
        || drawingBufferHeight - screenY < bottom - pointRadius - 0.5
        || drawingBufferHeight - screenY > bottom + pickWidth - 0.5 + pointRadius) continue;

      let intersectsPickPixels = false;
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        if (!sampleValid[sampleIndex]) continue;
        const dx = screenX - sampleX[sampleIndex];
        const dy = drawingBufferHeight - screenY - sampleY[sampleIndex];
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared > pointRadiusSquared) continue;
        intersectsPickPixels = true;
        const currentPointIndex = samplePointIndex[sampleIndex];
        const depthQuantizationRadius = PICK_DEPTH_QUANTUM * 0.5;
        const candidateDepthLower = gpuDepth - depthPositionUncertainty - depthQuantizationRadius;
        const candidateDepthUpper = gpuDepth + depthPositionUncertainty + depthQuantizationRadius;
        if (currentPointIndex < 0) {
          sampleWinnerDepthLower[sampleIndex] = candidateDepthLower;
          sampleWinnerDepthUpper[sampleIndex] = candidateDepthUpper;
          sampleViewDepth[sampleIndex] = viewDepth;
          samplePointIndex[sampleIndex] = pointIndex;
        } else if (currentPointIndex !== pointIndex) {
          if (candidateDepthUpper < sampleWinnerDepthUpper[sampleIndex]) {
            sampleOtherMinimumDepthLower[sampleIndex] = Math.min(
              sampleOtherMinimumDepthLower[sampleIndex],
              sampleWinnerDepthLower[sampleIndex],
            );
            sampleWinnerDepthLower[sampleIndex] = candidateDepthLower;
            sampleWinnerDepthUpper[sampleIndex] = candidateDepthUpper;
            sampleViewDepth[sampleIndex] = viewDepth;
            samplePointIndex[sampleIndex] = pointIndex;
          } else {
            sampleOtherMinimumDepthLower[sampleIndex] = Math.min(
              sampleOtherMinimumDepthLower[sampleIndex],
              candidateDepthLower,
            );
          }
        }
      }
      if (intersectsPickPixels) candidateCount += 1;
    }

    let bestPointIndex = -1;
    let bestViewDepth = Number.POSITIVE_INFINITY;
    let ambiguousReason: CpuPointPickProbe['reason'];
    for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
      if (samplePointIndex[sampleIndex] >= 0
        && sampleOtherMinimumDepthLower[sampleIndex] <= sampleWinnerDepthUpper[sampleIndex]) {
        // At least one candidate's GPU-equivalent depth interval overlaps the
        // possible winner. The public node-level pick cannot reveal which
        // fragment won after depth-buffer quantization, so fail closed.
        ambiguousReason = 'ambiguous-depth';
        break;
      }
      const pointAtSample = samplePointIndex[sampleIndex];
      if (pointAtSample < 0) continue;
      if (bestPointIndex < 0) {
        bestPointIndex = pointAtSample;
        bestViewDepth = sampleViewDepth[sampleIndex];
      } else if (bestPointIndex !== pointAtSample) {
        ambiguousReason = 'ambiguous-pick-window';
        break;
      }
    }
    if (ambiguousReason) {
      return {
        picked: false,
        nodeKey,
        ...(node.ownerId === undefined ? {} : { ownerId: node.ownerId }),
        candidateCount,
        scannedPointCount: node.sourcePointCount,
        pickWidth,
        scenePickDurationMs,
        cpuResolveDurationMs: performanceNow() - cpuStartedAt,
        totalDurationMs: performanceNow() - totalStartedAt,
        reason: ambiguousReason,
      };
    }
    if (bestPointIndex < 0) {
      return {
        picked: false,
        nodeKey,
        ...(node.ownerId === undefined ? {} : { ownerId: node.ownerId }),
        candidateCount,
        scannedPointCount: node.sourcePointCount,
        pickWidth,
        scenePickDurationMs,
        cpuResolveDurationMs: performanceNow() - cpuStartedAt,
        totalDurationMs: performanceNow() - totalStartedAt,
        reason: 'no-visible-candidate',
      };
    }

    const bestOffset = bestPointIndex * 3;
    const bestWorldX = node.worldCoordinates[bestOffset];
    const bestWorldY = node.worldCoordinates[bestOffset + 1];
    const bestWorldZ = node.worldCoordinates[bestOffset + 2];
    const bestClipX = viewProjection[0] * bestWorldX + viewProjection[4] * bestWorldY
      + viewProjection[8] * bestWorldZ + viewProjection[12];
    const bestClipY = viewProjection[1] * bestWorldX + viewProjection[5] * bestWorldY
      + viewProjection[9] * bestWorldZ + viewProjection[13];
    const bestClipW = viewProjection[3] * bestWorldX + viewProjection[7] * bestWorldY
      + viewProjection[11] * bestWorldZ + viewProjection[15];
    const bestScreenX = (bestClipX / bestClipW + 1) * drawingBufferWidth * 0.5;
    const bestScreenY = (1 - bestClipY / bestClipW) * drawingBufferHeight * 0.5;
    const bestDistanceX = bestScreenX / scaleX - windowPosition.x;
    const bestDistanceY = bestScreenY / scaleY - windowPosition.y;
    const bestDistanceSquared = bestDistanceX * bestDistanceX + bestDistanceY * bestDistanceY;
    const cpuResolveDurationMs = performanceNow() - cpuStartedAt;
    const offset = bestPointIndex * 3;
    return {
      picked: true,
      nodeKey,
      ...(node.ownerId === undefined ? {} : { ownerId: node.ownerId }),
      pointIndex: bestPointIndex,
      screenDistancePx: Math.sqrt(bestDistanceSquared),
      viewDepthMeters: bestViewDepth,
      pickWidth,
      worldPosition: [
        node.worldCoordinates[offset],
        node.worldCoordinates[offset + 1],
        node.worldCoordinates[offset + 2],
      ],
      candidateCount,
      scannedPointCount: node.sourcePointCount,
      scenePickDurationMs,
      cpuResolveDurationMs,
      totalDurationMs: performanceNow() - totalStartedAt,
    };
  }

  /** Return one source point's screen/world coordinates for deterministic probes. */
  getProbePoint(
    scene: Cesium.Scene,
    nodeKey: string,
    pointIndex: number,
  ): { visible: boolean; screenPosition?: { x: number; y: number }; worldPosition: [number, number, number] } | undefined {
    const node = this.nodes.get(nodeKey);
    if (!node || !Number.isInteger(pointIndex) || pointIndex < 0 || pointIndex >= node.sourcePointCount) {
      return undefined;
    }
    const offset = pointIndex * 3;
    const world = new Cesium.Cartesian3(
      node.worldCoordinates[offset],
      node.worldCoordinates[offset + 1],
      node.worldCoordinates[offset + 2],
    );
    const screen = Cesium.SceneTransforms.worldToWindowCoordinates(scene, world);
    return {
      visible: (node.pointSizes[pointIndex] ?? 0) > 0,
      ...(screen ? { screenPosition: { x: screen.x, y: screen.y } } : {}),
      worldPosition: [world.x, world.y, world.z],
    };
  }
}

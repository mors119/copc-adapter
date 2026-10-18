import * as Cesium from 'cesium';
import type { GeographicPointBuffer, PreparedPointData } from '../../core/copc/types/copc';
import { performanceNow } from '../../core/copc/performance';
import { prepareCopcPointColorBuffer } from '../../core/point/style/pointStyle';
import type { CopcCesiumPointRendererOptions, CesiumPointRenderer } from './CopcPointRenderer';
import { packRelativeEcef } from './relativeEcef';

type PointData = GeographicPointBuffer | PreparedPointData;

const VERTEX_SHADER = `
in vec3 position;
in vec3 a_color;
in float a_pointSize;
in float batchId;
out vec3 v_color;
out float v_show;
void main() {
  gl_Position = czm_modelViewProjection * vec4(position, 1.0);
  gl_PointSize = abs(a_pointSize);
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
  pointCount: number;
  observer?: CopcCesiumPointRendererOptions['onPerformance'];
};

/**
 * Research-only public Cesium Geometry(POINTS) prototype. It deliberately
 * remains outside the package entry points and is not the default renderer.
 * One GeometryInstance id is shared by the complete node, so Cesium picking
 * cannot return the existing per-point `{nodeKey, pointIndex}` identity.
 */
export class BatchedGeometryPointRenderer implements CesiumPointRenderer {
  private viewer?: Cesium.Viewer;
  private parent?: Cesium.PrimitiveCollection;
  private showState = true;
  private readonly nodes = new Map<string, NodeRecord>();

  /** Attach the research primitive container to a caller-owned Viewer. */
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

  /** Build or replace the single point Geometry for one prepared node. */
  addOrUpdateNode(nodeKey: string, points: PointData, options: CopcCesiumPointRendererOptions): void {
    if (!this.viewer || !this.parent) {
      throw new Error('BatchedGeometryPointRenderer is not attached to a Cesium viewer');
    }
    this.removeNode(nodeKey);
    const startedAt = performanceNow();
    const ecef = points.worldCoordinates;
    if (!ecef || points.worldCoordinateSystem !== 'wgs84-ecef-meters'
      || ecef.length !== points.pointCount * 3) {
      throw new Error('Batched Geometry renderer requires prepared WGS84 ECEF coordinates');
    }

    const relative = packRelativeEcef(ecef);
    const origin = new Cesium.Cartesian3(...relative.origin);
    const positions = relative.positions;
    const conservativeRadius = relative.radius + relative.maxAbsoluteError * Math.sqrt(3);
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

    const creationStartedAt = performanceNow();
    const attributes = new Cesium.GeometryAttributes() as Cesium.GeometryAttributes & {
      a_color: Cesium.GeometryAttribute;
      a_pointSize: Cesium.GeometryAttribute;
      batchId: Cesium.GeometryAttribute;
    };
    attributes.position = new Cesium.GeometryAttribute({
          componentDatatype: Cesium.ComponentDatatype.FLOAT,
          componentsPerAttribute: 3,
          values: positions,
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
      boundingSphere: new Cesium.BoundingSphere(Cesium.Cartesian3.ZERO, conservativeRadius),
    });
    const primitive = new Cesium.Primitive({
      geometryInstances: new Cesium.GeometryInstance({
        geometry,
        // Public Primitive picking identifies a GeometryInstance, not a vertex.
        id: { nodeKey },
      }),
      appearance: new Cesium.Appearance({
        vertexShaderSource: VERTEX_SHADER,
        fragmentShaderSource: FRAGMENT_SHADER,
        renderState: {
          depthTest: { enabled: true },
          depthMask: false,
          blending: Cesium.BlendingState.ALPHA_BLEND,
        },
      }),
      modelMatrix: Cesium.Matrix4.fromTranslation(origin),
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
    this.parent.add(primitive);
    this.nodes.set(nodeKey, {
      primitive,
      sphere: visibleSphere,
      origin,
      positions,
      pointCount: visibleCount,
      observer: options.onPerformance,
    });
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

  /** Probe public scene picking; returned ids are node-level, not point-level. */
  probePick(scene: Cesium.Scene, nodeKey: string): {
    picked: boolean;
    pickedNodeKey?: string;
    pointIndex?: number;
  } {
    const node = this.nodes.get(nodeKey);
    if (!node) return { picked: false };
    const stride = Math.max(1, Math.floor(node.positions.length / 3 / 500));
    for (let index = 0; index < node.positions.length / 3; index += stride) {
      const offset = index * 3;
      const world = new Cesium.Cartesian3(
        node.origin.x + node.positions[offset],
        node.origin.y + node.positions[offset + 1],
        node.origin.z + node.positions[offset + 2],
      );
      const windowPosition = Cesium.SceneTransforms.worldToWindowCoordinates(scene, world);
      if (!windowPosition || windowPosition.x < 0 || windowPosition.y < 0
        || windowPosition.x >= scene.canvas.clientWidth || windowPosition.y >= scene.canvas.clientHeight) {
        continue;
      }
      const picked = scene.pick(windowPosition) as { id?: unknown } | undefined;
      if (!picked) continue;
      const id = picked.id as { nodeKey?: unknown; pointIndex?: unknown } | undefined;
      if (id?.nodeKey === nodeKey) {
        return {
          picked: true,
          pickedNodeKey: nodeKey,
          ...(typeof id.pointIndex === 'number' ? { pointIndex: id.pointIndex } : {}),
        };
      }
    }
    return { picked: false };
  }
}

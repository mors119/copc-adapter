import type { CopcColorMode } from "../copc/points/fieldSelection";
import type { RenderablePointData } from "../point/compactEPointCache";

/** A project-owned numeric range used by renderer-independent styling. */
export type CopcValueRange = {
  /** Minimum value in the source units of the selected attribute. */
  min: number;
  /** Maximum value in the source units of the selected attribute. */
  max: number;
};

/**
 * Options shared by point renderers.
 *
 * These values describe the point data and the requested presentation. Scene
 * objects, attachment targets, and engine-specific diagnostics deliberately do
 * not cross this boundary.
 */
export type CopcPointRendererOptions = {
  /** Renderer-defined point size in implementation units. */
  pointSize: number;
  /** Source attribute or fallback mapping; omitted values use the renderer's fixed mode. */
  colorMode?: CopcColorMode;
  /** WGS84 ellipsoidal-height range in metres for elevation coloring. */
  elevationRange?: CopcValueRange;
  /** Dataset-stable source RGB display scale when RGB styling is active. */
  rgbMax?: 255 | 65535;
  /** Optional project-owned identity retained by an engine's picking path. */
  pointId?: (pointIndex: number) => unknown;
  /** Whether the point should be visible while retaining its original identity. */
  pointFilter?: (pointIndex: number) => boolean;
};

/** Validate a uniform per-layer alpha value. */
export function assertCopcLayerOpacity(opacity: number): void {
  if (
    typeof opacity !== "number" ||
    !Number.isFinite(opacity) ||
    opacity < 0 ||
    opacity > 1
  ) {
    throw new RangeError("COPC layer opacity must be a finite number in [0, 1]");
  }
}

/**
 * The smallest renderer contract required by shared streaming transitions.
 *
 * A renderer is attached by its engine adapter before this contract is used.
 * The shared contract consumes renderer-neutral prepared data, never a
 * viewer/scene/camera, and never returns engine geometry objects. Production
 * uses `PreparedPointData`; the internal experiment can pass compact E values.
 */
export interface CopcPointRenderer {
  /** Create or replace a node from shared A or internal compact E point data. */
  addOrUpdateNode(
    nodeKey: string,
    points: RenderablePointData,
    options: CopcPointRendererOptions,
  ): void;
  /** Remove one node and release its renderer-owned resources. */
  removeNode(nodeKey: string): void;
  /** Remove all nodes while keeping the renderer reusable. */
  clear(): void;
  /** Permanently release renderer-owned resources. */
  destroy(): void;
  /** Return whether a node is currently committed to the renderer. */
  hasNode(nodeKey: string): boolean;
  /** Optional per-node count used by a renderer workload guard. */
  getRenderedNodePointCount?(nodeKey: string): number | undefined;
  /** Return the sorted node keys currently committed to the renderer. */
  getRenderedNodeKeys(): string[];
  /** Return the number of points currently committed to the renderer. */
  getRenderedPointCount(): number;
}

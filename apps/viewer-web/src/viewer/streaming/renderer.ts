import type { CopcColorMode } from '../../copc/points/fieldSelection';
import type { PreparedPointData } from '../../copc/types/copc';

/** A project-owned numeric range used by renderer-independent styling. */
export type CopcValueRange = {
  min: number;
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
  colorMode?: CopcColorMode;
  elevationRange?: CopcValueRange;
  /** Dataset-stable source RGB display scale when RGB styling is active. */
  rgbMax?: 255 | 65535;
  /** Optional project-owned identity retained by an engine's picking path. */
  pointId?: (pointIndex: number) => unknown;
};

/**
 * The smallest renderer contract required by shared streaming transitions.
 *
 * A renderer is attached by its engine adapter before this contract is used.
 * The shared contract consumes `PreparedPointData`, never a viewer/scene/camera,
 * and never returns engine geometry objects. Concrete compatibility renderers
 * may continue to accept the legacy flat geographic view when used directly.
 */
export interface CopcPointRenderer {
  addOrUpdateNode(
    nodeKey: string,
    points: PreparedPointData,
    options: CopcPointRendererOptions,
  ): void;
  removeNode(nodeKey: string): void;
  clear(): void;
  destroy(): void;
  hasNode(nodeKey: string): boolean;
  /** Optional per-node count used by a renderer workload guard. */
  getRenderedNodePointCount?(nodeKey: string): number | undefined;
  getRenderedNodeKeys(): string[];
  getRenderedPointCount(): number;
}

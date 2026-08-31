import type { CopcColorMode } from '../../copc/points/fieldSelection';
import type { GeographicPointBuffer } from '../../copc/types/copc';

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
  /** Optional project-owned identity retained by an engine's picking path. */
  pointId?: (pointIndex: number) => unknown;
};

/**
 * The smallest renderer contract required by shared streaming transitions.
 *
 * A renderer is attached by its engine adapter before this contract is used.
 * The shared contract never accepts a viewer/scene/camera and never returns
 * engine geometry objects.
 */
export interface CopcPointRenderer {
  addOrUpdateNode(
    nodeKey: string,
    points: GeographicPointBuffer,
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

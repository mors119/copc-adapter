import type { CopcPointBuffer, CopcPointView } from '../types/copc';

/** Converts a backend-neutral point view into a renderable point buffer. */
export interface CopcPointDecoder {
  /** Decode the requested point components into a project-owned point buffer. */
  decode(view: CopcPointView): Promise<CopcPointBuffer>;
}

import type { CopcPointBuffer, CopcPointView } from '../types/copc';

/** Converts a backend-neutral point view into a renderable point buffer. */
export interface CopcPointDecoder {
  decode(view: CopcPointView): Promise<CopcPointBuffer>;
}

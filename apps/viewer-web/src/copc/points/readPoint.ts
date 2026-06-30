import type { CopcPoint, CopcPointView } from '../types/copc';

export type PointReader = {
  read(index: number): CopcPoint;
};

export function createPointReader(view: CopcPointView): PointReader {
  const getX = view.getter('X');
  const getY = view.getter('Y');
  const getZ = view.getter('Z');

  return {
    read(index: number): CopcPoint {
      return {
        x: getX(index),
        y: getY(index),
        z: getZ(index),
      };
    },
  };
}

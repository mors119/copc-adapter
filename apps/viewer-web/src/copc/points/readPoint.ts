import type { CopcPoint, CopcPointBuffer, CopcPointView } from '../types/copc';

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

export function readAllPoints(view: CopcPointView): CopcPoint[] {
  const reader = createPointReader(view);
  const points: CopcPoint[] = [];

  for (let index = 0; index < view.pointCount; index += 1) {
    points.push(reader.read(index));
  }

  return points;
}

export function readPointsFromBuffer(buffer: CopcPointBuffer): CopcPoint[] {
  const points: CopcPoint[] = [];

  for (let index = 0; index < buffer.pointCount; index += 1) {
    const offset = index * 3;

    points.push({
      x: buffer.coordinates[offset],
      y: buffer.coordinates[offset + 1],
      z: buffer.coordinates[offset + 2],
    });
  }

  return points;
}

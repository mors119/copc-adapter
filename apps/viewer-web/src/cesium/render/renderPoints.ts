import * as Cesium from 'cesium';
import type { GeographicPoint, GeographicPointBuffer } from '../../copc/types/copc';

export function toCartesian3Array(points: GeographicPoint[]): Cesium.Cartesian3[] {
  return points.map((point) =>
    Cesium.Cartesian3.fromDegrees(
      point.longitude,
      point.latitude,
      point.height,
    ),
  );
}

export function toCartesian3ArrayFromBuffer(
  points: GeographicPointBuffer,
): Cesium.Cartesian3[] {
  const positions: Cesium.Cartesian3[] = [];

  for (let index = 0; index < points.pointCount; index += 1) {
    const offset = index * 3;

    positions.push(
      Cesium.Cartesian3.fromDegrees(
        points.coordinates[offset],
        points.coordinates[offset + 1],
        points.coordinates[offset + 2],
      ),
    );
  }

  return positions;
}

export function renderCopcPoints(
  viewer: Cesium.Viewer,
  points: GeographicPointBuffer,
  existingCollection?: Cesium.PointPrimitiveCollection,
): Cesium.PointPrimitiveCollection {
  if (existingCollection) {
    viewer.scene.primitives.remove(existingCollection);
  }

  const collection = viewer.scene.primitives.add(
    new Cesium.PointPrimitiveCollection(),
  );
  const positions = toCartesian3ArrayFromBuffer(points);

  for (const position of positions) {
    collection.add({
      position,
      pixelSize: 3,
      color: Cesium.Color.CYAN.withAlpha(0.9),
    });
  }

  return collection;
}

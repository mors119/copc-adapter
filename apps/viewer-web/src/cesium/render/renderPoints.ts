import * as Cesium from 'cesium';
import type { GeographicPoint } from '../../copc/types/copc';

function toCartesian3Array(points: GeographicPoint[]): Cesium.Cartesian3[] {
  return points.map((point) =>
    Cesium.Cartesian3.fromDegrees(
      point.longitude,
      point.latitude,
      point.height,
    ),
  );
}

export function renderCopcPoints(
  viewer: Cesium.Viewer,
  points: GeographicPoint[],
  existingCollection?: Cesium.PointPrimitiveCollection,
): Cesium.PointPrimitiveCollection {
  if (existingCollection) {
    viewer.scene.primitives.remove(existingCollection);
  }

  const collection = viewer.scene.primitives.add(
    new Cesium.PointPrimitiveCollection(),
  );
  const positions = toCartesian3Array(points);

  for (const position of positions) {
    collection.add({
      position,
      pixelSize: 3,
      color: Cesium.Color.CYAN.withAlpha(0.9),
    });
  }

  return collection;
}

export { toCartesian3Array };

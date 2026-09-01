/**
 * Coordinate spaces used at the project-owned COPC/rendering boundary.
 *
 * `copc-source` is the source/project XYZ space represented by a COPC file.
 * `wgs84-geographic` stores longitude/latitude in degrees and ellipsoidal
 * height in metres. `wgs84-ecef-meters` is the shared world space used for
 * view geometry. `renderer-local` is deliberately renderer-neutral: an
 * adapter chooses its origin and may convert it to its GPU representation.
 */
export type CoordinateSystem =
  | 'copc-source'
  | 'wgs84-geographic'
  | 'wgs84-ecef-meters'
  | 'renderer-local';

export type CoordinateVector3<System extends CoordinateSystem = CoordinateSystem> = {
  coordinateSystem: System;
  x: number;
  y: number;
  z: number;
};

export type CoordinateBounds<System extends CoordinateSystem = CoordinateSystem> = {
  coordinateSystem: System;
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
};

/** Interleaved, high-precision XYZ triples in one explicitly named space. */
export type CoordinateBuffer<System extends CoordinateSystem = CoordinateSystem> = {
  coordinateSystem: System;
  pointCount: number;
  coordinates: Float64Array;
};

export type Wgs84GeographicPoint = {
  coordinateSystem: 'wgs84-geographic';
  longitude: number;
  latitude: number;
  height: number;
};

export type Wgs84EcefPoint = CoordinateVector3<'wgs84-ecef-meters'>;

export type RendererLocalPoint = CoordinateVector3<'renderer-local'>;

export type Wgs84GeographicBounds = CoordinateBounds<'wgs84-geographic'>;
export type Wgs84EcefBounds = CoordinateBounds<'wgs84-ecef-meters'>;

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
  /** Source/project XYZ decoded from the COPC; units are defined by its CRS. */
  | 'copc-source'
  /** WGS84 longitude/latitude in degrees and ellipsoidal height in metres. */
  | 'wgs84-geographic'
  /** WGS84 Earth-centred, Earth-fixed XYZ in metres. */
  | 'wgs84-ecef-meters'
  /** Adapter-owned local coordinates; the renderer contract defines the frame. */
  | 'renderer-local';

/** Three numeric components tagged with the coordinate space they represent. */
export type CoordinateVector3<System extends CoordinateSystem = CoordinateSystem> = {
  /** Coordinate space in which the vector components are expressed. */
  coordinateSystem: System;
  /** First component; its axis meaning depends on `coordinateSystem`. */
  x: number;
  /** Second component; its axis meaning depends on `coordinateSystem`. */
  y: number;
  /** Third component; its axis meaning depends on `coordinateSystem`. */
  z: number;
};

/** Axis-aligned bounds tagged with the coordinate space and units they use. */
export type CoordinateBounds<System extends CoordinateSystem = CoordinateSystem> = {
  /** Coordinate space in which all bounds are expressed. */
  coordinateSystem: System;
  /** Minimum value along the space's X axis. */
  minX: number;
  /** Minimum value along the space's Y axis. */
  minY: number;
  /** Minimum value along the space's Z axis. */
  minZ: number;
  /** Maximum value along the space's X axis. */
  maxX: number;
  /** Maximum value along the space's Y axis. */
  maxY: number;
  /** Maximum value along the space's Z axis. */
  maxZ: number;
};

/** Interleaved, high-precision XYZ triples in one explicitly named space. */
export type CoordinateBuffer<System extends CoordinateSystem = CoordinateSystem> = {
  /** Coordinate space and units used by each interleaved triple. */
  coordinateSystem: System;
  /** Number of triples stored in `coordinates`. */
  pointCount: number;
  /** Interleaved XYZ triples, using Float64 precision. */
  coordinates: Float64Array;
};

/** WGS84 geographic longitude/latitude in degrees and ellipsoidal height in metres. */
export type Wgs84GeographicPoint = {
  /** Identifies the WGS84 geographic coordinate space. */
  coordinateSystem: 'wgs84-geographic';
  /** WGS84 longitude in degrees. */
  longitude: number;
  /** WGS84 latitude in degrees. */
  latitude: number;
  /** Ellipsoidal height in metres. */
  height: number;
};

/** WGS84 Earth-centred, Earth-fixed XYZ position in metres. */
export type Wgs84EcefPoint = CoordinateVector3<'wgs84-ecef-meters'>;

/** Position in the renderer adapter's local frame. */
export type RendererLocalPoint = CoordinateVector3<'renderer-local'>;

/** A finite, unlabelled vector used for frame directions and camera axes. */
export type CoordinateDirection = {
  /** Direction component along the local X/east axis. */
  x: number;
  /** Direction component along the local Y/north axis. */
  y: number;
  /** Direction component along the local Z/up axis. */
  z: number;
};

/**
 * Stable renderer frame derived once from a dataset's metadata.
 *
 * Local coordinates use metres and the ENU convention: +X east, +Y north,
 * and +Z up at the ECEF origin. The frame is fixed for the dataset lifetime;
 * it is not a moving-origin/rebasing representation.
 */
export type DatasetLocalFrame = Readonly<{
  /** Identifies the renderer-local coordinate space. */
  coordinateSystem: 'renderer-local';
  /** Local +X east, +Y north, and +Z up. */
  axisConvention: 'enu';
  /** Unit used for local point positions and frame origin distances. */
  units: 'metres';
  /** Fixed WGS84 ECEF origin in metres. */
  origin: Readonly<Wgs84EcefPoint>;
  /** Unit east direction expressed in ECEF axes. */
  east: Readonly<CoordinateDirection>;
  /** Unit north direction expressed in ECEF axes. */
  north: Readonly<CoordinateDirection>;
  /** Unit up direction expressed in ECEF axes. */
  up: Readonly<CoordinateDirection>;
}>;

/** Axis-aligned WGS84 geographic bounds, with degree and metre axes. */
export type Wgs84GeographicBounds = CoordinateBounds<'wgs84-geographic'>;
/** Axis-aligned WGS84 ECEF bounds in metres. */
export type Wgs84EcefBounds = CoordinateBounds<'wgs84-ecef-meters'>;
/** Axis-aligned bounds in the adapter's renderer-local frame. */
export type RendererLocalBounds = CoordinateBounds<'renderer-local'>;

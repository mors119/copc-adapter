/**
 * Point fields understood by the project-owned COPC boundary.
 *
 * `position` represents the XYZ triplet and `rgb` represents all three RGB
 * channels. More LAS/COPC fields can be added here without exposing a
 * third-party decoder's dimension names to callers.
 */
export type CopcPointField =
  /** Required source XYZ coordinates. */
  | "position"
  /** LAS intensity attribute. */
  | "intensity"
  /** LAS classification attribute. */
  | "classification"
  /** All three RGB color channels. */
  | "rgb";

/** Immutable-by-contract set of source point fields requested from a backend. */
export type CopcPointFieldSelection = ReadonlySet<CopcPointField>;

/** Individual point components exposed by backend-neutral point views. */
export type CopcPointComponent =
  /** Source-coordinate axes. */
  | "x"
  | "y"
  | "z"
  /** LAS intensity and classification components. */
  | "intensity"
  | "classification"
  /** Individual RGB channels. */
  | "red"
  | "green"
  | "blue";

/** Color mapping names supported by Cesium, Three.js, and shared style helpers. */
export type CopcColorMode =
  /** Use the adapter's fixed fallback color; no source color field is needed. */
  | "fixed"
  /** Color by WGS84 ellipsoidal height in metres. */
  | "elevation"
  /** Use source RGB values when present. */
  | "rgb"
  /** Color by LAS intensity. */
  | "intensity"
  /** Color by LAS classification code. */
  | "classification"
  /** Color by one explicitly requested numeric dimension. */
  | "dimension";

const ALL_POINT_FIELDS: CopcPointField[] = [
  "position",
  "intensity",
  "classification",
  "rgb",
];

/** Create a detached field selection, suitable for passing across a backend boundary. */
export function createCopcPointFieldSelection(
  fields: Iterable<CopcPointField>,
): CopcPointFieldSelection {
  return new Set(fields);
}

/** Return all fields supported by the current project-owned point contract. */
export function allCopcPointFields(): CopcPointFieldSelection {
  return createCopcPointFieldSelection(ALL_POINT_FIELDS);
}

/** Map a render mode to the minimum fields needed to render it. */
export function getCopcPointFieldSelection(
  colorMode: CopcColorMode,
): CopcPointFieldSelection {
  switch (colorMode) {
    case "rgb":
      return createCopcPointFieldSelection(["position", "rgb"]);
    case "intensity":
      return createCopcPointFieldSelection(["position", "intensity"]);
    case "classification":
      return createCopcPointFieldSelection(["position", "classification"]);
    case "dimension":
      return createCopcPointFieldSelection(["position"]);
    case "fixed":
    case "elevation":
      return createCopcPointFieldSelection(["position"]);
  }
}

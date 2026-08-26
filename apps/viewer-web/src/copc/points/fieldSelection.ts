/**
 * Point fields understood by the project-owned COPC boundary.
 *
 * `position` represents the XYZ triplet and `rgb` represents all three RGB
 * channels. More LAS/COPC fields can be added here without exposing a
 * third-party decoder's dimension names to callers.
 */
export type CopcPointField =
  | 'position'
  | 'intensity'
  | 'classification'
  | 'rgb';

export type CopcPointFieldSelection = ReadonlySet<CopcPointField>;

export type CopcPointComponent =
  | 'x'
  | 'y'
  | 'z'
  | 'intensity'
  | 'classification'
  | 'red'
  | 'green'
  | 'blue';

export type CopcColorMode =
  | 'fixed'
  | 'elevation'
  | 'rgb'
  | 'intensity'
  | 'classification';

const ALL_POINT_FIELDS: CopcPointField[] = [
  'position',
  'intensity',
  'classification',
  'rgb',
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
    case 'rgb':
      return createCopcPointFieldSelection(['position', 'rgb']);
    case 'intensity':
      return createCopcPointFieldSelection(['position', 'intensity']);
    case 'classification':
      return createCopcPointFieldSelection(['position', 'classification']);
    case 'fixed':
    case 'elevation':
      return createCopcPointFieldSelection(['position']);
  }
}

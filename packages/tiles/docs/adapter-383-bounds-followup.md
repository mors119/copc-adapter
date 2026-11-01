# Historical Adapter #383 API proposal: conservative transformed cell bounds

## Status update — Adapter 0.7.1

This document records the original API gap and proposal. The published
`@frillab/copc-adapter@0.7.1` now exposes
`CopcConservativeNodeSource.getConservativeNodeEcefBounds(nodeKey)` from the
public `/core` subpath. COPC Tiles consumes the exact Registry package and
preserves supported/unsupported results through its typed connector. The
Registry integrity, result contract, and evidence are recorded in the
[compatibility matrix](./adapter-api-compatibility.md).

The public API resolves the integration contract gap for supported geographic
cells. It intentionally reports projected Autzen EPSG:2992 and SoFi
EPSG:32611 as `unsupported-horizontal-crs`; those sources still cannot use
multi-node ECEF bounds. Existing acceptance and validation requirements in
the proposal remain relevant to evaluating upstream implementation coverage.
This Tiles work does not change Adapter or update/close upstream issue #383.

## Blocker

The packed public `/core` API exposes two different bounds contracts:

- `CopcNodeSource.getNodeCellBounds(nodeKey)` returns an axis-aligned box in
  COPC source coordinates and source CRS units.
- `CopcPreparedNodeData.ecefBounds` encloses only points decoded from that
  node, in WGS 84 ECEF metres, with kind `decoded-point-content`.

Neither contract supplies the ECEF volume required for a 3D Tiles hierarchy
before that node's points are decoded. The public `createPointTransformer()`
maps one point at a time; its declaration does not guarantee that transformed
cell corners bound the interior or curved edges of a source cell. Tiles cannot
create that guarantee by sampling corners, copying Adapter's CRS code, or
reusing decoded-point bounds.

## Autzen evidence

Autzen's public Core metadata reports:

- Horizontal CRS: EPSG:2992, NAD83 / Oregon GIC Lambert, international feet.
- Vertical CRS: EPSG:6360, NAVD88 height, US survey feet.
- Transform plan: projected horizontal conversion is required; no validated
  vertical grid is configured, so the candidate records its compatibility
  pass-through policy for source height.
- Source cube: approximately `635577.79..640233.30` X,
  `848882.15..853537.66` Y, and `406.14..5061.65` Z in source units.

The adapter opens this dataset and lazily reads hierarchy pages and selected
point ranges. It does not expose a conservative transformed ECEF volume for an
unread cell. Consequently, the Tiles integration stops before emitting a real
multi-node tileset. The previous one-node render uses returned `ecefBounds`
only for the already-decoded node content; it says nothing about its
undecoded descendants.

## Narrow public API proposal

Add one read-only operation to `CopcNodeSource`:

```ts
getConservativeNodeEcefBounds(
  node: CopcHierarchyNode,
  options?: CopcCellBoundsOptions,
): Promise<CopcNodeCellEcefBounds>;

type CopcNodeCellEcefBounds = Readonly<{
  nodeKey: string;
  bounds: Wgs84EcefBounds;
  kind: 'conservative-source-cell';
  sourceIdentity: string;
  sourceGeneration: number;
  transformGeneration: number;
  transformPlanIdentity: string;
}>;

type CopcCellBoundsOptions = Readonly<{ signal?: AbortSignal }>;
```

The operation should:

1. Reuse the same Adapter-owned CRS, axis/unit normalization, and vertical
   operation as `loadPreparedNodeData()`; it must not decode node points or
   materialize a prepared cache.
2. Return a volume proven to enclose every transformed position in the full
   source cell, including nonlinear edge/interior extrema and any configured
   validated vertical grid. Grid extrema may be used only under an explicit
   coverage/no-data policy that is safe for synthetic bounds.
3. Fail with a typed unsupported-bounds error when the active transform cannot
   establish that enclosure. Do not return source bounds under an ECEF label or
   fall back to a decoded-point bound.
4. Honor cancellation and reject closed/stale source or transform generations.
5. Return the transform-plan identity and generations so Tiles can reject
   mixed-source tileset builds.

The exact method name can follow Adapter conventions; the essential addition
is a conservative cell-bound contract with a fail-closed unsupported result.
It is read-only and renderer-neutral and does not change Direct Cesium/Three
defaults. No Adapter internals or implementation are changed in this Tiles
worktree.

## Validation required upstream

- Unit tests for identity/geographic, projected, and vertical-grid transforms,
  including high latitude, date line, cell edges, projection extrema, and
  invalid/no-data grid coverage.
- Differential checks against the exact point-preparation transform for many
  source-cell samples as regression checks, plus a documented mathematical
  enclosure argument. Sampling alone is not the proof.
- Tests for unsupported CRS, unsupported vertical units, stale generations,
  cancellation and empty cells.
- Both `copc-js` and Rust/WASM must return bounds for the same transform plan
  within a documented tolerance or fail with the same unsupported reason.
- Public `/core` declaration, packed ESM and strict TypeScript consumer tests.

Until this API is released and verified, the requested Autzen on-demand
multi-node Cesium/Three integration is blocked at the bounds gate. Hierarchy
traversal, content generation and renderer code must not route around it.

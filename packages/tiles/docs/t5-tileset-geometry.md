# T5 — Tileset bounds and geometric error

`createExplicitTileset` builds a standards-based 3D Tiles 1.1 explicit
hierarchy from complete source-neutral node records and caller-supplied
conservative WGS 84 ECEF axis-aligned bounds. It reads hierarchy metadata only
and does not request or decode point payloads.

Each tile uses a local, zero-centered box and one translation to its ECEF
bounds center. A child translation is relative to its parent tile origin. GLB
content is addressed through UTF-8 hex encoding of the node key, so source keys
cannot become paths. Empty nodes have no content URI; `ADD` refinement keeps
non-empty point sets from parent and child nodes visible together.

The geometric-error policy is the largest child half-diagonal or descendant
error. This is a conservative spatial-cell coverage proxy in metres, not an
estimate of point density or visual error. It is monotone toward the root and
does not use decoded point data. Degenerate axes receive a 1 mm minimum half
extent. Input node count and accumulated point count have configurable, hard
bounds.

The module rejects incomplete child discovery, disconnected or cyclic
hierarchies, invalid octree coordinates, unsafe integers, non-finite or
non-conservative bounds, and resource-limit violations. Published Adapter
0.7.1 `/core` supplies public node/page access, generations, transform
provenance, decoded-point ECEF bounds, and
`getConservativeNodeEcefBounds(nodeKey)`. That method returns a typed
supported or unsupported result. Tiles validates its source, transform, and
cell provenance; unsupported results keep their reason and cannot be used to
build a bound. Source-cell bounds remain in source CRS, and decoded-point ECEF
bounds remain limited to loaded content.

The primary Autzen source declares horizontal EPSG:2992 (NAD83 / Oregon GIC
Lambert, international feet) and vertical EPSG:6360 (NAVD88, US survey feet).
Its transform plan has no configured vertical grid and marks the vertical
conversion as a compatibility pass-through. Adapter 0.7.1 correctly returns
`unsupported-horizontal-crs` for this projected source. The real Autzen path
therefore stops before creating a multi-node tileset bound. Generated
EPSG:4326 and EPSG:4979 fixtures with explicit ellipsoidal height return
analytic conservative bounds; an EPSG:4326 fixture with unknown vertical
reference fails closed. These cases do not establish support for projected
CRS, every geographic cell, or validated vertical-grid behavior. See the
[Adapter API compatibility matrix](./adapter-api-compatibility.md) and the
[historical #383 API proposal](./adapter-383-bounds-followup.md).

Fixture verification:

- `npm run validate:tileset` runs hierarchy/bounds/security tests and the
  CesiumGS 3D Tiles Validator against a generated tileset and GLB content.
- `npm run typecheck` checks the exported TypeScript implementation.

For supported geographic fixtures, the Adapter bound does not include GLB
Float32 reconstruction error. `createCopcTileResourceProvider` derives an
error envelope for each content-bearing cell before point reads and propagates
the largest descendant padding to ancestor volumes, including empty nodes. It
then verifies decoded point containment and actual GLB error. A two-node live
source passes the Khronos and CesiumGS validators and renders in the
Cesium/Three fixtures. Real
Autzen and SoFi are projected and remain unsupported; one-node renderer checks
do not evidence projected parent/child cell bounds or real production LOD. No
unsupported result falls back to decoded-point bounds.
See the [packed API compatibility matrix](./adapter-api-compatibility.md).

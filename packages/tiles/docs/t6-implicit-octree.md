# T6 — Implicit octree and subtree availability

`createImplicitOctreeTileset` emits a 3D Tiles 1.1 `OCTREE` root and binary
`.subtree` resources from a complete, source-neutral hierarchy. It sets
`availableLevels` from the deepest supplied node, uses coordinate templates
for both tile content and subtree resources, and returns subtree bytes by
their URL path. Empty hierarchy nodes remain tile-available while their
content-availability bit is zero.

Availability follows the official Morton Z-order per level. The subtree
binary contains a `subt` version-1 header, padded JSON and a padded binary
chunk. Bitstreams use the 3D Metadata least-significant-bit-first order, with
unused trailing bits zeroed and buffer-view offsets aligned to 8 bytes.
Tile and content availability cover the subtree's `subtreeLevels`; child
subtree availability covers the next global level. Constant availability is
used when every bit has the same value.

The implementation caps subtree depth at 6, nodes at 100,000 by default
(500,000 hard maximum), subtree resources at 10,000 by default (100,000 hard
maximum), and total encoded subtree bytes at 64 MiB by default (512 MiB hard
maximum). All limits can be lowered or raised within their hard bounds.
Hierarchy nodes must form one complete connected octree with unique keys and
coordinates. Each supplied conservative ECEF bound must fit the node's
regularly subdivided root cell. A mismatch fails closed.

The implicit root's one ECEF placement transform applies to descendants. The
returned `contentOriginEcef` is the Float64 origin to use when encoding every
content GLB under that implicit root; the encoder must enforce its existing
Float32 precision budget relative to this origin. This keeps one world
placement transform and avoids implying per-descendant transforms that
implicit tiling does not provide. Very large root extents can therefore fail
the Float32 position budget; use smaller independent implicit roots or the
explicit T5 hierarchy when tighter per-tile origins are required.

Fixture verification is `npm run validate:implicit`. It checks Morton indices,
bit offsets and lengths, empty content, fixed-size subtrees, URL templates,
hierarchy/bounds failures, configured work limits, and the CesiumGS 3D Tiles
Validator on a generated tileset with GLB content and binary subtrees.

The encoding follows the [CesiumGS implicit tiling specification](https://github.com/CesiumGS/3d-tiles/blob/main/specification/ImplicitTiling/README.adoc)
and its [availability indexing rules](https://github.com/CesiumGS/3d-tiles/blob/main/specification/ImplicitTiling/AVAILABILITY.adoc).

The published Adapter 0.7.1 `/core` provides hierarchy access, transform
generation, decoded-point bounds, and a separate conservative ECEF cell-bound
result. The generated EPSG:4326 and EPSG:4979 fixtures return supported bounds;
real Autzen EPSG:2992 returns `unsupported-horizontal-crs`, so this milestone
does not claim a real COPC implicit octree. Tiles does not substitute
decoded-point bounds or transformed cell corners. Live hierarchy-to-subtree
availability and production real-data LOD remain incomplete. See the
[Adapter API compatibility matrix](./adapter-api-compatibility.md) and
[historical Adapter #383 proposal](./adapter-383-bounds-followup.md).

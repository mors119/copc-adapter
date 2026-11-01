# T2 node access through Adapter Core

## Scope

`TileNodeReader` resolves only explicitly requested node keys with bounded,
lazy hierarchy traversal and bounded point-read concurrency. It does not choose
nodes from a camera, invoke Adapter's Direct `NodeSelector`, or preload the
whole octree. Fixture sources and the Adapter connector implement the same
source-neutral `TileNodeSource` contract.

## Public `/core` connector

`src/adapter/copcCoreAdapter.ts` consumes types from the public
`@frillab/copc-adapter/core` export. `createCopcCoreNodeSource()` opens a
context through `createCopcContext()` and owns it by default;
`wrapCopcCoreNodeSource()` adapts an already-open `CopcNodeSource` and leaves
ownership with its caller by default. The bridge calls only these public
methods:

- `getRootHierarchyPage()` and `loadHierarchyPage(page, { signal })` for lazy
  hierarchy access.
- `loadPreparedNodeData(node, fields, { signal, extraDimensions })` for one
  selected node.
- `getConservativeNodeEcefBounds(nodeKey)` for metadata-only ECEF source-cell
  bounds where the published Adapter certifies the active transform.
- `isCurrent(sourceGeneration)` and `close()` for generation and lifecycle
  handling.

The prepared result's A-shaped point data is passed to `createTilePointViewFromA`
without copying ECEF or selected attribute arrays. Adapter-provided
`availableFields` and `availableExtraDimensions` decide which selected
attributes are exposed. Missing fields stay absent. Tiles stores the stable
node key, source generation, transform generation, immutable transform plan,
available fields, and the decoded-point ECEF bounds with their documented
kind. It does not create E from A or rehydrate an Adapter E cache.

Adapter reports decoded-point bounds and a separate conservative source-cell
result. The connector checks source cell, node, source identity/generations,
and transform-plan identity. The result is metadata-only and does not issue
point or network reads. It preserves an explicit unsupported reason without
fallback. Projected Autzen EPSG:2992 and EPSG:32611 still cannot provide a
Tiles bound, so multi-node culling and LOD remain limited for those sources.

## Limits and failure handling

The reader defaults remain 512 hierarchy pages / 64 MiB of hierarchy ranges,
500,000 hierarchy records, 512 requested nodes, 2,000,000 points per node,
4,000,000 points per batch, 64 selected Extra Dimensions, 256 MiB of point
ranges per batch, 384 MiB of decoded views per batch, and four concurrent node
reads. Configurable limits are clamped to documented hard caps.

Hierarchy ranges, page/node records, point count, point byte ranges, decoded
buffer lengths, source generations, requested node identity, and returned
prepared identity are checked before data is exposed. Invalid or mismatched
data fails without retry or fabricated values. Request signals pass through to
both Core hierarchy-page reads and prepared-node reads. Closing a connector
aborts its local requests; it closes the Core context only when it owns it.

## Acceptance evidence

| Issue #2 criterion | Evidence / status |
| --- | --- |
| Requested keys without Direct scheduler | Implemented in `src/source/tileNodeReader.ts`; repository scan shows no `NodeSelector` or `StreamingManager` imports in the Tiles connector. |
| Lazy hierarchy pages and bounded traversal | Fixture tests cover early stop, page limits, incomplete hierarchy, unsafe ranges, and missing/fabricated nodes. Ordinary requested-node reads do not retain hierarchy records after returning; only explicit bounded `readHierarchy()` retains records for subsequent node reads. Autzen and SoFi hierarchy reads pass without full object downloads. The live explicit provider scans metadata only after `scanCompleteHierarchy: true` and stays within page/byte/node limits; it decodes only requested content. |
| Deduplicate node requests | Duplicate keys in one batch collapse to one point preparation; cross-call resource deduplication remains a T8 provider responsibility. |
| Public prepared data path | Uses `CopcNodeSource.loadPreparedNodeData()` for all nodes. No `/cesium` fallback, copied decoder, point buffer rehydration, or duplicate CRS code. |
| Cancellation and source lifecycle | Unit tests assert signals reach hierarchy and point methods, connector close aborts local work, owned context close is idempotent, and stale generations are rejected. |
| Actual attributes and precise coordinates | Autzen returns position/intensity/classification/RGB and SoFi returns position/intensity/classification on both backends; ECEF stays the exact Adapter Float64 buffer. |
| Packed package contract | The actual Registry Adapter 0.7.1 tarball and packed Tiles artifact pass Node ESM, strict Bundler and strict NodeNext consumers. |

## Real browser evidence

Autzen was 81,123,042 bytes with SHA-256
`db2d56cdfa058bffccdc5d6019dae2fc9c6a551df10a5523c06c76a3e25a27fa`; the
file stayed in `/private/tmp`. `validate:adapter-integration` passed for both
backends in Chromium:

- `copc-js`: node `4-11-2-0`, 5,122 points, 6 COPC Range GETs / 164,880 bytes.
- Rust/WASM: same node and points, 7 COPC Range GETs / 101,455 bytes; WASM and
  worker asset reads are separate from COPC ranges.
- Both outputs passed Khronos glTF and CesiumGS 3D Tiles validators without
  errors/warnings and rendered in Cesium and Three.

SoFi was read directly from the public 2.03 GB object with bounded HTTP Range
requests. Both backends visited one page (2,599 nodes) and decoded the three
selected nodes at levels 2/3/4 with 1,131 / 7,690 / 6,975 points. The source
is EPSG:32611 and its conservative bounds correctly remain unsupported, so
these reads do not demonstrate real live multi-node Tileset generation.

No File/Blob, real named Extra Bytes, explicit vertical grid,
complete octree, or production multi-node LOD result is claimed. The public
Adapter 0.7.1 supports configured Extra Bytes on `copc-js`; Rust/WASM
rejects non-empty Extra Bytes requests. See the
[API compatibility matrix](./adapter-api-compatibility.md).

## Adapter #383 follow-up

The public renderer-neutral source methods, node/page types, source and
transform generations, cancellation, and A-shaped point preparation are now
available in the published Registry 0.7.1 package and exercised by Tiles.
Adapter issue [#383](https://github.com/mors119/copc-adapter/issues/383) is
unchanged by this Tiles work:

1. The 0.7.1 public conservative-bounds method reports tested projected
   sources as unsupported; projected support must remain an Adapter-owned
   enhancement with its own proof and validation.
2. No read-only E cache view is exposed. This is not required for the A
   baseline; if Tiles later uses E, expose retained ECEF Float64 and prepared
   height Float64 through a narrow public view instead of rehydrating A.

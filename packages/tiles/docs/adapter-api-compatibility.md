# Adapter API compatibility — 2026-10-31

## Supported published artifact

This milestone supports exactly `@frillab/copc-adapter@0.7.1`. Both the
optional peer dependency and development dependency are pinned to that exact
version. Compatibility with earlier or later releases is not claimed.

The npm Registry metadata and the actual downloaded Registry tarball were
checked. The published archive was installed in clean packed consumers.

| Registry field | Value |
| --- | --- |
| Version | `0.7.1` |
| Public exports | `.`, `./core`, `./cesium`, `./three` |
| Tarball | [`copc-adapter-0.7.1.tgz`](https://registry.npmjs.org/@frillab/copc-adapter/-/copc-adapter-0.7.1.tgz) |
| `dist.integrity` | `sha512-apm67tKwhOr41elWw845NaYJrMsz74oXWtD7ZEMntLkUaFhos0uM/EMsVBNOEwXg77JjN363hQi70hTOLD7yJQ==` |
| `dist.shasum` | `03e8f790b8f2627bbfee72c9f9033b5547993dcd` |
| Packed / unpacked | 646,494 / 2,289,736 bytes; 127 files |
| Adapter Node engine field | Not declared |
| Optional renderer peers | `cesium >=1.142.0`, `three >=0.170.0` |

The declaration files for `/core`, `/cesium`, and `/three` are included in the
archive. The actual `/core` declarations use `.js` extensions for relative
declaration imports, fixing the strict NodeNext TS2834/TS2835 failure found in
the 0.7.0 package.

## Public contract inventory

| Operation | Public Adapter 0.7.1 API | Data and ownership | Cancellation and lifecycle | Tiles coverage and limits |
| --- | --- | --- | --- | --- |
| Open source | `createCopcContext(input, backend, options)` from `@frillab/copc-adapter/core`; `CopcContext` | Supports the public URL, `File`/`Blob`, and random-access inputs; explicit `copc-js` or `rust` backend. | Context close invalidates the source; source and transform generations identify results. | Public ESM and runtime Core capability verified from the Registry package. HTTP Range integration tested. |
| Read metadata | `CopcNodeSource.getMetadata()`; `CopcMetadata` | Source-space bounds, point count, and CRS evidence. Tiles returns a defensive immutable copy and preserves source units/labels. | Connector checks current source before returning metadata. | Unit and real Autzen integration coverage. |
| Traverse hierarchy | `getRootHierarchyPage()`, `loadHierarchyPage(page, { signal })`; public hierarchy page/node types | Lazy page and node records carry keys, coordinates, point ranges/counts, known children, and completeness. | Page load takes an `AbortSignal`; close/stale generations reject work/results. | Requested-node reads and an explicitly bounded metadata scan are covered. The live explicit provider scans metadata at creation, then reads only requested content nodes. |
| Read source cell | `CopcNodeSource.getNodeCellBounds(nodeKey)`; `CopcHierarchyBounds` | Axis-aligned source CRS bounds in source units. | Current source required. | Preserved as source-space bounds and never relabeled ECEF. |
| Prepare a node | `loadPreparedNodeData(node, fields, options)`; `CopcPreparedNodeData` | A-shaped prepared data exposes adapter-owned typed arrays, including Float64 ECEF and selected available attributes. Tiles aliases read-only buffers. | Per-call signal plus source lifecycle/generation checks. Synchronous decode can finish before an abort is observed; backend physical cancellation is not promised. | Real Autzen and SoFi node paths covered with both backends. |
| Select attributes | `CopcPointFieldSelection`, `CopcPointField`, and `extraDimensions`; result `availableFields` / `availableExtraDimensions` | Actual returned fields only; exact Extra Dimension names and supported numeric arrays remain adapter-owned/read-only. No zero-filled missing fields. | Same preparation signal and generation checks. | Autzen standard LAS attributes covered. Real Extra Bytes coverage incomplete; Rust rejects non-empty Extra Dimension requests. |
| Preserve transform evidence | `sourceGeneration`, `transformGeneration`, `transformPlan`, `isCurrent()` on `CopcNodeSource` | Immutable plan identity and source/vertical CRS, unit, height-offset, and grid evidence. | Source close/replacement makes stale results unusable. | Connector checks node/source/transform identity and keeps height/grid provenance. |
| Read decoded-point bound | `CopcPreparedNodeData.ecefBounds`, `ecefBoundsKind` | `decoded-point-content` bound encloses only decoded point positions in WGS84 ECEF metres. | Bound has the prepared result's generations. | Kept distinct from source-cell and conservative-cell bounds. |
| Read conservative source-cell bound | `CopcConservativeNodeSource.getConservativeNodeEcefBounds(nodeKey): CopcConservativeBoundsResult` from `/core` | Synchronous, metadata-only result. Supported values include `boundsEcef`, full-cell-and-descendant coverage, analytic verification/method, vertical reference and units, assumptions, and `encoderErrorPaddingRequired: true`. Unsupported values retain `reasonCode`, `reason`, source-cell bounds, source identity/generations, transform-plan identity, height offset, and optional vertical-grid provenance; they have no `boundsEcef`. | No signal parameter. Evaluation performs no point payload reads or network requests. A closed/stale context throws `CopcStaleSourceError`. | Connector validates exact node/source/cell/transform provenance and copies/freezes the result. It rejects malformed or fabricated bounds. Unsupported results cannot build a Tiles bound. |
| Build live explicit resources | Tiles `createCopcTileResourceProvider(source, { scanCompleteHierarchy: true, ... })`; public from package root and `/resources` | Uses the source-neutral hierarchy/bounds/point contract; full metadata scan is explicitly authorized and bounded; content GLBs are generated on demand. | Bounded metadata scan is cancellable; content requests combine caller cancellation with provider shutdown and check source/transform generations. Source ownership is opt-in. | Supported bounds only. Unsupported results stop construction with their unchanged Adapter result; no decoded-point fallback is used. |

The published unsupported reason codes are `unsupported-horizontal-crs`,
`unsupported-horizontal-units`, `unsupported-axis-order`,
`unsupported-coordinate-epoch`, `unsupported-vertical-reference`,
`unsupported-vertical-grid`, `vertical-grid-has-nodata-sentinel`,
`vertical-grid-outside-cell-coverage`, `invalid-source-cell`,
`unsupported-geographic-cell`, and `numeric-range`. Tiles preserves the exact
reason code and context.

Conservative bounds report `coverage: 'full-source-cell-and-descendant-cells'`,
`method: 'wgs84-geodetic-interval-v1'`,
`verification: 'analytic-interval'`, and WGS84 ECEF metres for supported
results. Source-cell bounds remain in the source CRS; decoded-point bounds
remain point-content bounds. The result does not certify GLB Float32
reconstruction error. The live provider computes a conservative Float32
envelope only for content-bearing cells before point reads, propagates the
largest descendant padding to ancestor volumes (including empty nodes), then
checks decoded points and actual GLB reconstruction error. Default maximum
accepted padding is 1 cm and can be tightened. Unit fixtures validate the
generated GLB and Tileset with Khronos and CesiumGS validators.

## Connector behavior

`src/adapter/copcCoreAdapter.ts` imports only the public
`@frillab/copc-adapter/core` subpath. It uses the public context, metadata,
hierarchy, node preparation, transform, generation, and conservative bounds
contracts. It does not import private Adapter files, decode COPC, implement
Range access, transform CRS, rebuild the E cache, or use Direct `NodeSelector`.

The Tiles Engine remains usable without Adapter installed: its source-neutral
types contain a structural result contract, and the optional connector lives
at `@frillab/copc-tiles/adapter/copc-core`. The connector's `sourceIdentity`
is the caller's opaque application identity. Conservative results retain the
Adapter's exact `sourceIdentity`; the wrapper exposes that expected value as
`conservativeBoundsSourceIdentity` so Tiles can validate provenance without
rewriting Adapter metadata.

## Conservative bounds evidence and limits

| Source class | Evidence | Result |
| --- | --- | --- |
| EPSG:4326 with explicit ellipsoidal height | Generated validated COPC fixture with a 123.5 m manual height offset; `copc-js` and Rust/WASM | Supported; result preserves the offset and all 11 prepared root-node points are contained; no Range reads during bounds evaluation. |
| EPSG:4979 with ellipsoidal height | Generated validated COPC fixture; `copc-js` and Rust/WASM | Supported; Adapter transform plan resolves to WGS84 horizontal plus ellipsoidal height; all 11 prepared root-node points contained; no Range reads during bounds evaluation. |
| EPSG:4326 with unknown vertical reference | Generated COPC fixture; both backends | Explicit `unsupported-vertical-reference`; no ECEF bounds returned. |
| EPSG:32611 projected | Generated COPC CRS fixture; both backends | Explicit `unsupported-horizontal-crs`; no ECEF bounds returned. |
| Autzen EPSG:2992 | Real Autzen source; both backends | Explicit `unsupported-horizontal-crs`; no ECEF bounds returned. The live provider rejects after one hierarchy page and performs zero point reads. |
| SoFi EPSG:32611 | Real 2.03 GB public object; both backends, three node payloads and renderer consumers | `unsupported-horizontal-crs`, no ECEF bounds. Separate real-source integration reads bounded HTTP ranges and verifies point preparation, GLB and Cesium/Three consumption; it does not build a safe live multi-node Tileset. |

Connector unit coverage also verifies a manual height offset and validated
vertical-grid provenance are preserved, checks parent/descendant bound
containment on contract fixtures, and proves decoded-point bounds remain a
separate concept. A validated vertical-grid real COPC source and its grid
coverage/no-data behavior have not been exercised in browser integration.
Geographic fixtures establish a supported bounds class; they do not establish
coverage for every geographic cell, epoch, vertical grid, or height policy.

## Compatibility verification

- Strict packed consumer checks use TypeScript `5.9.3`, `skipLibCheck: false`,
  strict NodeNext, and strict Bundler resolution. They cover public root,
  `/core`, `/cesium`, and `/three` type-only imports; Tiles root and
  `/resources`; runtime ESM imports; and a separate Adapter Core plus Tiles
  consumer without renderer packages.
- Runtime and declaration checks passed from the actual installed Registry
  package. The packed Tiles tarball was installed in clean temporary consumers.
- Clean installs and type/build/unit checks were verified under Node `18.20.8`
  and Node `22.14.0`. Node `26.12.1` can run the suite after a local Sharp
  rebuild, but clean development installation fails while compiling the
  development-only `better-sqlite3@11.10.0`; see the implementation report.
  Adapter 0.7.1 itself declares no Node engine range.
- Real Autzen and SoFi browser checks run against Chromium. Their one-node or
  selected-node renderer checks do not claim real multi-node live Tiles LOD.
  Firefox and WebKit are not part of this evidence.

Adapter Direct `.`, `/cesium`, and `/three` were not modified. This Tiles
change does not change Adapter or close upstream issue #383.

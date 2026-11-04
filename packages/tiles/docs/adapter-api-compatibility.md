# Adapter API compatibility — 2026-11-04

## Supported published artifact

The current released baseline is `@frillab/copc-adapter@0.8.0`. Tiles uses
that exact version as its development dependency and declares
`^0.7.1 || ^0.8.0` as an optional peer range. Packed consumers run the full
renderer type/runtime matrix against published 0.8.0 and 0.7.1, plus a
renderer-free Core import check against 0.7.1. Compatibility beyond these
tested versions is not claimed.

The npm Registry metadata and published 0.8.0 tarball were checked. The
published 0.8.0 archive is installed in clean packed consumers.

| Registry field | Adapter 0.8.0 |
| --- | --- |
| Public exports | `.`, `./core`, `./cesium`, `./three` |
| Tarball | [`copc-adapter-0.8.0.tgz`](https://registry.npmjs.org/@frillab/copc-adapter/-/copc-adapter-0.8.0.tgz) |
| `dist.integrity` | `sha512-2ASSn7CK0iw8p8PtfMf9mVh1bRPfyS89Eg33FrDkn3bLT2aNjQ9tpUoUvsW+LLbPy8gnqDD92XpKsUCuQMMbNA==` |
| Packed / unpacked | 655,534 / 2,329,620 bytes; 129 files |
| Adapter Node engine field | Not declared |
| Optional renderer peers | `cesium >=1.142.0`, `three >=0.170.0` |

### Previous compatibility artifact — Adapter 0.7.1

The 0.7.1 Registry artifact remains covered by full-renderer and
renderer-free Core packed consumers. Its metadata and integrity below are
retained as the compatibility record.

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

| Operation | Public Adapter 0.8.0 API (compatible with 0.7.1) | Data and ownership | Cancellation and lifecycle | Tiles coverage and limits |
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
| Build live explicit resources | Tiles `createCopcTileResourceProvider(source, { scanCompleteHierarchy: true, ... })`; public from package root and `/resources` | `conservative-source-cell` uses the certified result; `indexed-decoded-content` validates a reusable content-bounds index; explicit `decoded-content` scans all prepared content points and can create that index. | The initial implementation discovers the complete bounded metadata hierarchy. Streaming modes read no points before renderer content requests. Index validation checks source fingerprint, transform plan, complete hierarchy, datum evidence, encoder allowance, and SHA-256 integrity. Reads retain node, batch, byte, and cancellation limits. | Conservative mode retains source-cell coverage. Indexed mode covers only scanned content points and descendants; it never claims unobserved source-cell bounds. Full decoded mode is preprocessing with a 4,000,000 default and 20,000,000 hard point budget. |

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
generated GLB with Khronos `gltf-validator` and the local Tileset with
`@frillab/copc-tiles-validate`. The latter checks structural references,
subtrees, and GLB containers; its conformance report remains partial and it
does not validate glTF extension semantics.

Tiles' `decoded-content` strategy is a separate provider capability. It
requires `boundsStrategy: 'decoded-content'`,
`allowDecodedContentBounds: true`, and `scanCompleteHierarchy: true`; set
`createBoundsIndex: true` only when the node source supplies an immutable
fingerprint and transform-plan identity. The default total point limit is
4,000,000; Dev Viewer allows explicit scans up to 20,000,000. A complete scan
records source/transform identity and per-content-node CRS/vertical provenance.
For later streaming use `boundsStrategy: 'indexed-decoded-content'` with the
saved index. The strategy validates complete hierarchy metadata before it
returns a Tileset but decodes no points until a content URI is requested.
Source-cell metadata results remain unchanged. Unknown vertical evidence is
reported as unverified placement.

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

## Issue #383 public contract decision

The existing `@frillab/copc-adapter/core` exports cover the implemented Tiles
connector path, so no Adapter-specific Tiles API is added. This is the
supported minimum contract for the current connector and is cross-checked
against [COPC Tiles T1](https://github.com/FrilLab/copc-tiles/issues/1) and
[T2](https://github.com/FrilLab/copc-tiles/issues/2):

- `createCopcContext()` opens HTTP, `File`/`Blob`, or caller-owned random-access
  input and returns the public renderer-neutral node-source contract.
- Public hierarchy methods resolve root and child pages lazily; callers keep
  the page budget and `childrenComplete` evidence.
- `loadPreparedNodeData()` decodes the requested node and selected fields,
  returns ECEF Float64 plus the A-shaped prepared coordinate buffers, and
  records actual field availability and source/transform generations.
- Per-request `AbortSignal`, source `close()`, `isCurrent()`, immutable
  transform provenance, and distinct decoded-point versus conservative
  source-cell bounds support connector cancellation and validation.
- The Tiles connector exposes the ECEF and selected attribute buffers as
  read-only views. It does not depend on Direct `NodeSelector`, renderer
  packages, or private Adapter imports.

Direct layer E-cache entries remain an internal experiment. The current Tiles
connector reads nodes through public Core preparation and does not consume or
rehydrate those layer-cache entries. This is an explicit support boundary; no
E-cache export is needed for the verified connector path.

Verify packed package declarations and runtime entrypoints with:

```sh
npm run test:packed-consumer -w @frillab/copc-tiles
```

The script installs the packed Tiles tarball alongside the exact published
Adapter `0.7.1` artifact and the packed local Adapter `0.8.0` candidate in
clean temporary consumers. It runs strict NodeNext and Bundler declaration
checks and ESM imports for the public Adapter and Tiles entrypoints, including
the optional Core connector. It also checks renderer-free Core and Adapter-free
Tiles consumers.

Verify the real COPC-to-Tiles connector path in Chromium against the official
range-served Autzen source with:

```sh
curl --fail --location \
  https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz \
  --output /tmp/copc-tiles-autzen.copc.laz
COPC_TILES_AUTZEN=/tmp/copc-tiles-autzen.copc.laz \
  npm run validate:adapter-integration -w @frillab/copc-tiles
```

The browser integration opens the public Adapter `/core` context and runs the
Tiles connector against selected real nodes with both `copc-js` and Rust/WASM.
It verifies bounded HTTP Range reads, prepared ECEF Float64 positions, actual
attribute availability, source/transform provenance, GLB encoding and Cesium
and Three.js consumption. Projected Autzen bounds fail closed before point
reads. This is a selected-node integration check, not complete-hierarchy
scanning, safe projected-source bounds, or proof of real multi-node Tiles LOD.
Keep the npm-packed package checks and browser source integration separate:
the Adapter runtime is browser-oriented, and its Core package is not a
Node-runtime integration target.

### Validation record — 2026-11-03

- Adapter and Tiles typechecks passed, including Tiles' packed public-Core
  compatibility typecheck. The targeted connector suite passed all 21 tests.
- `npm run test:packed-consumer -w @frillab/copc-tiles` passed against Registry
  Adapter `0.7.1` and the locally packed Adapter `0.8.0` candidate. The Tiles
  tarball was 123.2 kB (501.0 kB unpacked); the Adapter candidate was 655.5 kB
  (2.3 MB unpacked). Strict NodeNext/Bundler consumers, ESM exports, Core-only
  imports, and Adapter-free Tiles imports passed. Direct renderer bundles
  contained no Tiles modules.
- The Autzen Chromium integration passed all four tests with the local `0.8.0`
  candidate's public `/core` build: both backends failed closed for projected
  conservative bounds before point reads, and both encoded and rendered one
  real node through Cesium and Three.js. The selected node was `4-11-2-0` with
  5,122 points; each backend produced a 119,292-byte GLB with zero Khronos or
  CesiumGS validator errors or warnings in that historical pre-migration run.
  Current tests use the structural validator and do not claim full standards
  conformance. `copc-js` used 6 Range requests
  (164,880 bytes); Rust/WASM used 7 (101,455 bytes). Maximum measured GLB
  reconstruction error was about 1.97 micrometres. The temporary 81,123,042-byte
  source matched the repository sample SHA-256
  `db2d56cdfa058bffccdc5d6019dae2fc9c6a551df10a5523c06c76a3e25a27fa`.
- These are selected-node results. They do not demonstrate a complete Autzen
  hierarchy scan or safe projected-source multi-node Tiles LOD. The Adapter
  package was not changed by this audit, so no runtime package-size delta is
  claimed.

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
  Adapter 0.7.1 package and the packed local Adapter 0.8.0 candidate. The
  packed Tiles tarball was installed in clean temporary consumers with each.
- Clean installs and type/build/unit checks were verified under Node `18.20.8`
  and Node `22.14.0`. Node `26.12.1` can run the suite after a local Sharp
  rebuild, but clean development installation fails while compiling the
  development-only `better-sqlite3@11.10.0`; see the implementation report.
  Adapter 0.7.1 itself declares no Node engine range.
- Real Autzen and SoFi browser checks run against Chromium. Their one-node or
  selected-node renderer checks do not claim real multi-node live Tiles LOD.
  Firefox and WebKit are not part of this evidence.

Adapter Direct `.`, `/cesium`, and `/three` runtime implementations were not
modified. The 0.8.0 candidate adds a narrowly scoped WKT2 vertical CRS
diagnostic while keeping `getConservativeNodeEcefBounds()` unchanged and
projected source-cell bounds unsupported. Upstream issue #383 remains open.

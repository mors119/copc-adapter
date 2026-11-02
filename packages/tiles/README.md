# COPC Tiles

**COPC → standard 3D Tiles 1.1** as an optional, independently published companion to [COPC Adapter](https://github.com/mors119/copc-adapter). This package is developed at `packages/tiles` in the Adapter npm Workspaces monorepo.

> **Status: 0.1.0 conditional review candidate; not published.** The live provider supports certified `conservative-source-cell` streaming and indexed, rendered-content bounds streaming. Complete `decoded-content` preprocessing is a separate explicit operation with a default 4,000,000-point limit. A generated projected EPSG:32611 COPC fixture exercises both indexed streaming and complete preprocessing in Cesium and Three.js. Real projected bounds still do not certify unobserved source cells, and vertical placement remains separately evidenced. The initial provider traverses complete bounded hierarchy metadata before first render; standard renderers request point nodes and GLBs on demand. See [`docs/implementation-status.md`](docs/implementation-status.md), the [API compatibility matrix](docs/adapter-api-compatibility.md), and the [3D Tiles demo runbook](../../apps/dev-viewer/docs/3d-tiles-demo.md).

## Why separate?

COPC Adapter streams COPC points directly with CesiumJS and Three.js. COPC Tiles is an independent integration path for clients that require **standards-compliant 3D Tiles**. Projects using only the direct adapter must not pay a Tiles runtime, dependency, or install-size cost.

- Package candidate: `@frillab/copc-tiles@0.1.0` (not published).
- Its original standalone repository remains the historical source and issue
  tracker. Packed install and dependency-graph measurements for the current
  Adapter 0.7.1 contract are recorded in
  [`docs/implementation-status.md`](docs/implementation-status.md) and the
  migration records. This remains a separate npm distribution; it is not an
  Adapter subpath.
- Adapter package: `@frillab/copc-adapter` ([upstream repository](https://github.com/mors119/copc-adapter)).
- Dependency direction: **copc-tiles → copc-adapter**, never the reverse.
- Reuse verified *public* Adapter APIs for COPC hierarchy/Range/decode/CRS, read-only point data, and conservative source-cell bounds. Compatibility is checked against the published Adapter `0.7.1` Registry artifact and packed `0.8.0` candidate. Adapter 0.8 adds WKT2 CRS diagnostics, strong-ETag Range pinning, and aggregate returned-byte diagnostics. Do not import private Adapter source or bypass its `/core` export.
- Where required public APIs do not exist, define the narrowest viable contract and propose a separate, reviewed upstream PR. Never duplicate the entire COPC decoder or silently use private exports.
- Keep direct `/cesium`, `/three`, source/cache defaults, behavior, and consumers unaffected.

## Scope

**In scope:** selected COPC nodes → valid glTF 2.0 `POINTS` GLB → 3D Tiles 1.1 tileset and implicit octree/subtrees → bounded on-demand resource serving → independent Cesium and Three.js rendering → conformance, precision, performance, and release verification.

**Out of scope:** replacing Direct COPC, running Direct NodeSelector as the Tiles LOD scheduler, mesh reconstruction, terrain snapping, bundled authoritative geoid grids, nonstandard Cesium-only Tiles formats, and silent attribute/precision loss.

## Architecture

```text
COPC source (HTTP Range / File)
           |
@frillab/copc-tiles (optional independent package)
           |
           +── public @frillab/copc-adapter/core contract
    |  TilePointView / node access (A / experimental E)
    |  ECEF-to-tile-local precision mapping
    |  glTF POINTS GLB + LAS metadata
    |  tileset.json / implicit octree / subtrees
    |  cancellation-aware TileResourceProvider
    +---- standard Cesium3DTileset
    +---- standards-compatible Three.js Tiles renderer
```

Keep transform/height provenance, node identity, precise `Float64` ECEF input, and original attributes. Do not force E cache reconstruction to full Source/Geographic arrays or redundant inverse ECEF transforms. The upstream adapter owns CRS and vertical conversion semantics.

## Roadmap — T1 through T12

Implementation is tracked against all twelve issues. A milestone remains
partial until every acceptance criterion is verified; fixture evidence and
real COPC evidence are reported separately in the implementation status.

| Step | Issue | Deliverable | Dependencies |
| --- | --- | --- | --- |
| T1 | [#1](https://github.com/FrilLab/copc-tiles/issues/1) | Tile input/attribute contract; A/E read-only views | — |
| T2 | [#2](https://github.com/FrilLab/copc-tiles/issues/2) | Node-key hierarchy/point decoding, independent of Direct NodeSelector | T1 |
| T3 | [#3](https://github.com/FrilLab/copc-tiles/issues/3) | Precision-safe ECEF tile-local coordinates | T1 |
| T4 | [#4](https://github.com/FrilLab/copc-tiles/issues/4) | Standards-valid glTF POINTS / GLB encoder | T1, T3 |
| T5 | [#5](https://github.com/FrilLab/copc-tiles/issues/5) | Tileset bounds and geometric error | T1, T2 |
| T6 | [#6](https://github.com/FrilLab/copc-tiles/issues/6) | Implicit octree and subtree availability | T5 |
| T7 | [#7](https://github.com/FrilLab/copc-tiles/issues/7) | LAS attribute → glTF metadata mapping | T1, T4 |
| T8 | [#8](https://github.com/FrilLab/copc-tiles/issues/8) | Bounded resource serving, cancellation and cache | T2, T4–T6 |
| T9 | [#9](https://github.com/FrilLab/copc-tiles/issues/9) | Real Cesium 3D Tiles browser comparison | T8, applicable T11 gates |
| T10 | [#10](https://github.com/FrilLab/copc-tiles/issues/10) | Identical content in Three.js | T8, T9 |
| T11 | [#11](https://github.com/FrilLab/copc-tiles/issues/11) | Tiles/glTF validator, precision and malformed-input gates | Applicable T3–T10; run incrementally |
| T12 | [#12](https://github.com/FrilLab/copc-tiles/issues/12) | A/E and Direct/Tiles performance, bundle isolation, release readiness | T9–T11 |

The public source contract and package usage are documented in
[`docs/usage.md`](docs/usage.md). See the [Adapter API compatibility
matrix](docs/adapter-api-compatibility.md), [issue-by-issue acceptance
audit](docs/release-audit-2026-10-29.md), and
[`docs/implementation-status.md`](docs/implementation-status.md) for exact
commands, source evidence, limitations and release classification.

## Compatibility and release gates

1. Pin a verified compatible adapter version/range; validate against actual packed consumers, not arbitrary local private source aliases.
2. Maintain explicit compatibility and feature matrices for A/default vs experimental E, copc-js vs Rust/WASM, HTTP vs local File, Cesium vs Three.
3. Validate position/height precision (including datums, offsets, polar/dateline cases), attribute preservation, cancellation, source identity, malformed inputs and memory bounds. The current encoder-padding test uses the encoder's measured Float32 reconstruction error; geographic CRS support is limited to the verified cases in the compatibility matrix.
4. Run real standard Cesium and Three.js rendering and official glTF / 3D Tiles validators before claiming compatibility.
5. Measure clean Direct COPC bundle and **npm install** footprint without Tiles; tree shaking is not sufficient proof of install-size isolation.
6. Do not publish, deploy or claim full T12 completion before maintainer review and required passing gates.

Tiles keeps Adapter `0.7.1` as its exact development baseline and supports
`^0.7.1 || ^0.8.0` as an optional peer range. Strict NodeNext and Bundler
packed-consumer checks run against the Registry 0.7.1 artifact and the local
packed 0.8.0 candidate; the compatibility matrix records the Registry
integrity and candidate checks. CesiumJS `1.146.0`, Three.js
`0.186.1`, `3d-tiles-renderer` `0.5.3`, and Chromium are tested points, not
declared broad compatibility ranges.

## Implemented behavior and integration limits

The source-neutral engine provides read-only point views, Float64 ECEF to
tile-local Float32 encoding, glTF 2.0 POINTS/GLB output, explicit Tilesets,
fixture-driven implicit octree/subtree generation, and bounded resource
serving. The package root and `./resources`, `./tileset`, and
`./tileset/implicit` entrypoints do not load the Adapter, Cesium, or Three.
The Adapter connector is isolated at `./adapter/copc-core`.

The COPC connector uses only public `@frillab/copc-adapter/core` APIs and is
compatible with 0.7.1 and 0.8.x. Real Autzen and SoFi requested-node reads and
single-node rendering were verified. `createCopcTileResourceProvider()`
requires explicit `scanCompleteHierarchy: true` authorization for a bounded
complete metadata traversal. It does not implement another camera selector.
The standard renderer requests content URIs and the provider prepares only
those COPC nodes. The certified `conservative-source-cell` strategy retains
its existing full-cell proof. For projected sources, the optional
`indexed-decoded-content` strategy validates a reusable complete index against
source fingerprint, transform plan and live hierarchy metadata; it does not
claim source-cell coverage. The explicit `decoded-content` strategy scans all
content points to generate that index. Its default point budget is 4 million,
configurable to 20 million in Dev Viewer. Per-node, batch, hierarchy, byte,
concurrency, cache and GLB budgets remain independent.

Decoded-content Tileset extras identify the strategy, source and transform
generation, transform-plan identity, node, point count, content/descendant
coverage, raw and padded ECEF envelopes, Float32 error allowance, and vertical
placement status. The provider's `decodedContentScan` summary records exact
node/point/byte accounting and per-node CRS and vertical evidence. A GLB
request rereads the node and validates the source/transform provenance, every
prepared point, and reconstructed Float32 positions against the recorded
content and tile envelopes. Unknown vertical provenance is `unverified`; a
finite ECEF transform is not a survey-datum claim.

Adapter 0.7.1 returns `unsupported-horizontal-crs` for projected Autzen
EPSG:2992 and SoFi EPSG:32611. The default source-cell strategy preserves that
result and fails closed. Indexed content bounds can stream projected data only
after a valid index exists; SoFi's 364-million-point total exceeds the current
complete-preprocessing hard limit, so no SoFi index is claimed. Fixture
implicit tiling is implemented, while a live COPC implicit subtree provider
remains planned. The current limitations and T1–T12 acceptance status are recorded in
[`docs/implementation-status.md`](docs/implementation-status.md).

The package now lives at `packages/tiles` in the
[`mors119/copc-adapter`](https://github.com/mors119/copc-adapter) monorepo and
remains an independently packed npm distribution. Its optional Adapter peer
uses only the public `@frillab/copc-adapter/core` entrypoint; Adapter has no
dependency on Tiles. The original
[`FrilLab/copc-tiles`](https://github.com/FrilLab/copc-tiles) repository is
unchanged and remains the source of the historical T1–T12 issues and
pre-migration evidence. The migration record and package workflow are in the
repository's [`docs/monorepo-development.md`](../../docs/monorepo-development.md);
the earlier staging audit is retained in
[`docs/migration-readiness.md`](docs/migration-readiness.md).

## Development policy

See [AGENTS.md](AGENTS.md). Document actual validations, and stop at
**AWAITING MAINTAINER REVIEW**. Keep GitHub issues/PRs in English. This README
is the public architecture and implementation roadmap.

The packed Tiles engine runtime targets Node `>=18`. Clean installs were
verified on Node 18 and 22. On Node 26, the development-only native
`better-sqlite3@11.10.0` fails to compile; the runtime test suite can run after
rebuilding Sharp locally. Exact command results and the separately skipped
real-source cases are recorded in the implementation status.

## Original planning history

The requirements were migrated from [mors119/copc-adapter#332–#343](https://github.com/mors119/copc-adapter/issues/332). The old issue discussions remain as historic references; new Tiles work is tracked here.

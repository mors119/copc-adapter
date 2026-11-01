# T1–T12 release acceptance audit — 2026-10-29

## Release verdict

**CONDITIONAL.** The independent Tiles engine passes its fixture tests,
official validator checks, packed root ESM/TypeScript consumer checks and
clean-install isolation checks. Published Adapter 0.6.0 also supplies real
bounded copc-js node data for Autzen and SoFi, including three SoFi nodes at
levels 2–4. Both Cesium and Three actually rendered a real node from each
source.

This is not a full COPC-to-3D Tiles release. The real renderer wrapper is
prebuilt from decoded node points; it is not an on-demand, conservative-bounds,
multi-node Tiles hierarchy. No current published Adapter version exposes the
merged `/core` API, and 0.6.0 does not supply transformed conservative bounds
for undecoded hierarchy cells or an Adapter transform generation. The Direct
comparison, multi-node Tiles LOD, cancellation under real network churn, and
several T12 measurements are still absent. Keep all T1–T12 issues open.

The exact metrics and package measurements are in
[`benchmark-report-2026-10-29.md`](benchmark-report-2026-10-29.md); the API
contract inventory is in [`adapter-api-compatibility.md`](adapter-api-compatibility.md).

## Repository, package and renderer versions

- Tiles HEAD: `dba0d8db091f23bdb811d0c8d3b6a18f7a59bfc0` (merged PR #14).
- Adapter upstream main: `c5b563b3d0c5743b8030a79eca8c820421c9d4a7` (PR #391
  merged); Adapter issue #383 remains open.
- Latest published and packed Adapter: `@frillab/copc-adapter@0.6.0`, exact
  registry integrity recorded in the API compatibility document. Published
  exports are `.`, `/cesium`, `/three`; there is no published `/core`.
- Tiles candidate: `@frillab/copc-tiles@0.1.0`, Apache-2.0, ESM, Node engine
  `>=18`, not published. Runtime dependencies: none. Optional exact Adapter
  peer: `0.6.0`. Cesium, Three, `3d-tiles-renderer`, validators, Playwright,
  TypeScript and Vite are development dependencies.
- Tested runtime versions: Node `18.20.8`, `22.23.4`, and `26.12.1`. Unit
  tests passed on all three; typecheck/build passed on Node 18 and 26. The
  clean development install on Node 26 remains constrained by the
  development-only `better-sqlite3@11.10.0` build noted in the release
  checklist.
- Tested browser/renderer stack: Chromium `156.0.8078.4`, CesiumJS `1.146.0`,
  Three.js `0.186.1`, and `3d-tiles-renderer` `0.5.3`. No Firefox, WebKit,
  mobile browser, or supported-version range has been validated.

## Issue-by-issue acceptance results

### T1 — [#1 Input contract](https://github.com/FrilLab/copc-tiles/issues/1): **Partial**

- **Acceptance scope:** required Float64 ECEF and identity/provenance; optional
  Source/Geographic/attributes; A and experimental E read-only views; field
  selection; mixed/missing fields, BigInt, bad lengths and stale generations.
- **Implementation:** `src/input/tilePointView.ts`,
  `src/adapter/copcAdapterNodeSource.ts`.
- **Tests / command / result:** `test/tilePointView.test.mjs`,
  `test/copcAdapterNodeSource.test.mjs`; `npm test` — 68 passed. Real browser
  tests — A-shaped Adapter data on Autzen and SoFi.
- **Backend:** synthetic A/E fixtures; published Adapter 0.6.0 copc-js A path.
- **Remaining / satisfied:** public E is unavailable, named Extra Bytes are
  unavailable, and no Rust E path was checked. Partial; #1 remains open.

### T2 — [#2 Requested node access](https://github.com/FrilLab/copc-tiles/issues/2): **Partial**

- **Acceptance scope:** requested keys only, lazy pages, stable identity,
  copc-js and Rust, no Direct `NodeSelector`, bounded ranges and work,
  cancellation and damaged-response handling.
- **Implementation:** `src/source/tileNodeReader.ts`,
  `src/adapter/copcAdapterNodeSource.ts`, `src/adapter/copcJsAdapter.ts`.
- **Tests / command / result:** `test/tileNodeReader.test.mjs`,
  `test/copcAdapterNodeSource.test.mjs`; `npm test` — traversal, identity,
  malformed pages, limits and fixture cancellation passed. The optional SoFi
  browser test loaded and encoded `2-3-0-0` (1,131 points), `3-0-5-0`
  (7,690), and `4-0-10-1` (6,975); each returned count matched its COPC
  hierarchy record. One coordinate-derived parent/child key pair was verified. Eight source
  ranges totaled 422,669 bytes including repeated harness reads.
- **Backend:** public Adapter 0.6.0 copc-js only; real Autzen and SoFi.
- **Remaining / satisfied:** only one SoFi hierarchy page was loaded; full
  descendant coverage, Rust, active real request cancellation and malformed
  real Range responses are unverified. Adapter 0.6.0 cannot abort a hierarchy
  page read. Partial; #2 remains open.

### T3 — [#3 Precision](https://github.com/FrilLab/copc-tiles/issues/3): **Partial**

- **Acceptance scope:** Float64 tile origin, Float32 local glTF positions,
  exactly one transform, thresholds, geographic/projected fixtures, seam and
  no input mutation.
- **Implementation:** `src/geometry/tileLocalCoordinates.ts`,
  `src/gltf/pointCloudGlb.ts`.
- **Tests / command / result:** `test/tileLocalCoordinates.test.mjs` and real
  browser checks; `npm test` — synthetic pole/dateline/high-altitude/large
  coordinate fixtures passed. Latest Autzen encoder max error was
  `0.0000019626224569 m`; first-point world error was
  `0.0000014947356675 m`. SoFi encoder max error was
  `0.0000041748075762 m`; Three first-point world error was
  `0.0000023887571673 m`.
- **Backend:** real Adapter ECEF Float64 points from copc-js.
- **Remaining / satisfied:** these errors compare local encoding and renderer
  reconstruction to Adapter-prepared ECEF; they do not independently verify
  source CRS axes, geodetic datum, vertical datum or applied correction. No
  real seam/full-cloud study. Partial; #3 remains open.

### T4 — [#4 GLB encoder](https://github.com/FrilLab/copc-tiles/issues/4): **Partial**

- **Acceptance scope:** valid POINTS GLB, alignment and lengths, normalized
  LAS RGB, empty/malformed/bounded input, rendering, allocations and time.
- **Implementation:** `src/gltf/pointCloudGlb.ts`.
- **Tests / command / result:** `test/pointCloudGlb.test.mjs`;
  `npm test` — Khronos validator passed fixtures. Autzen real GLB was 119,292
  bytes and SoFi primary-node GLB was 18,256 bytes; both real GLBs had zero
  validator errors and warnings.
- **Backend:** fixtures and real Adapter 0.6.0 copc-js points.
- **Remaining / satisfied:** real per-node output is verified, but transient
  allocation profiling and no-loss coverage for all requested fields are not.
  Partial; #4 remains open.

### T5 — [#5 Bounds and geometric error](https://github.com/FrilLab/copc-tiles/issues/5): **Partial**

- **Acceptance scope:** source octree mapping, conservative transformed
  bounds, meters/screen-error policy, ADD coverage and no point-payload decode
  while building hierarchy.
- **Implementation:** `src/tileset/explicitTileset.ts`,
  `src/geometry/tileLocalCoordinates.ts`.
- **Tests / command / result:** `test/explicitTileset.test.mjs`,
  `test/tileLocalCoordinates.test.mjs`; `npm test` — explicit fixture
  validator and conservative fixture-bound tests passed. The real one-node
  wrapper used measured decoded-point bounds and placed the encoder origin and
  tile transform consistently; Cesium rendered those points.
- **Backend:** synthetic hierarchy and decoded real copc-js nodes.
- **Remaining / satisfied:** Adapter 0.6.0 exposes no conservative ECEF
  bounds for undecoded COPC cells. Decoded-point bounds do not prove parent
  coverage. Screen-space error progression, ADD coverage and multi-node
  culling are unverified. Partial; #5 remains open.

### T6 — [#6 Implicit tiling](https://github.com/FrilLab/copc-tiles/issues/6): **Partial**

- **Acceptance scope:** OCTREE implicit tiling, Morton availability,
  subtrees, sparse/empty nodes, nested boundaries and bounded traversal.
- **Implementation:** `src/implicit/octreeAvailability.ts`,
  `src/tileset/implicitOctreeTileset.ts`.
- **Tests / command / result:** `test/implicitOctreeTileset.test.mjs`;
  `npm test` — sparse, empty, invalid and configured-bound fixtures passed the
  CesiumGS validator.
- **Backend:** fixture-only for implicit hierarchy and subtree output.
- **Remaining / satisfied:** no real COPC implicit tileset/subtree resource or
  nested real subtree has been validated. Partial; #6 remains open.

### T7 — [#7 Metadata](https://github.com/FrilLab/copc-tiles/issues/7): **Partial**

- **Acceptance scope:** original display RGB versus LAS inspection fields,
  point identity, typed extras, 64-bit values and renderer support.
- **Implementation:** `src/input/tilePointView.ts`,
  `src/gltf/pointCloudGlb.ts`.
- **Tests / command / result:** `test/pointCloudGlb.test.mjs`,
  `test/tilePointView.test.mjs`; `npm test` — typed fixture metadata passed.
  Real Autzen preserved RGB/intensity/classification; real SoFi preserved
  intensity/classification, with RGB correctly absent. Three exposed the same
  primary-node values and structural metadata.
- **Backend:** fixture A/E and real Adapter copc-js standard fields.
- **Remaining / satisfied:** named Extra Bytes, GPS Time, all LAS return
  fields, 64-bit metadata interoperability and both renderers' complete
  metadata feature matrix are incomplete. Partial; #7 remains open.

### T8 — [#8 Resource server](https://github.com/FrilLab/copc-tiles/issues/8): **Partial**

- **Acceptance scope:** URL provider, path safety, MIME, cancellation,
  deduplication, bounded jobs/cache, generation invalidation and HTTP/File/
  Blob integration.
- **Implementation:** `src/resources/tileResourceServer.ts`.
- **Tests / command / result:** `test/tileResourceServer.test.mjs`;
  `npm test` — route traversal, size limits, deduplication, LRU, generation
  switches and cancellation fixtures passed. Both renderers fetched the same
  tileset and GLB URLs from the browser test server.
- **Backend:** in-memory resource provider; real node output was uploaded to a
  local test URL after encoding.
- **Remaining / satisfied:** the server was not connected to a live Adapter
  hierarchy and node decoder per renderer request. Real cancellation under
  camera churn and HTTP/File/Blob provider comparison are unavailable.
  Partial; #8 remains open.

### T9 — [#9 Cesium](https://github.com/FrilLab/copc-tiles/issues/9): **Partial**

- **Acceptance scope:** real Autzen on-demand tiles through public Cesium APIs,
  comparison with Direct rendering, first point, camera movement, refinement,
  placement, network and resource cleanup.
- **Implementation:** `test/browser/adapter.real.entry.js`,
  `test/browser/adapter.real.spec.mjs`,
  `test/browser/second-source.real.spec.mjs`.
- **Tests / command / result:** `npm run validate:adapter-integration` — one
  Autzen test passed. The opt-in SoFi Playwright command — one test passed.
  Both actual node GLBs were requested through standard URLs, decoded and
  rendered with normal culling; visible points remained after representative
  camera movement.
- **Backend:** CesiumJS 1.146.0 / Chromium 156; Adapter 0.6.0 copc-js.
- **Remaining / satisfied:** content was pre-generated before renderer fetch;
  no Direct comparison, real multi-node LOD, zoom refinement, real aborts,
  height reference comparison or full network/frame/memory measurements.
  Partial; #9 remains open.

### T10 — [#10 Three.js](https://github.com/FrilLab/copc-tiles/issues/10): **Partial**

- **Acceptance scope:** same standard resources as Cesium, coordinate axes,
  metadata, style, camera LOD, content hashes and dependency isolation.
- **Implementation:** same browser tests as T9; renderer integration is test
  code using public `3d-tiles-renderer` and Three APIs.
- **Tests / command / result:** Autzen and SoFi tests passed. The SoFi test
  hashed the GLB response from Cesium and Three; both hashes matched the
  generated GLB. Three rendered the content after movement and released active
  tiles on disposal. Clean Direct bundle graph had no Tiles inputs.
- **Backend:** Three.js 0.186.1 / `3d-tiles-renderer` 0.5.3 / Chromium 156.
- **Remaining / satisfied:** only one standard content tile was rendered per
  dataset; no multilevel Tiles selection or full package-bundle CI matrix.
  Partial; #10 remains open.

### T11 — [#11 Standards/security](https://github.com/FrilLab/copc-tiles/issues/11): **Partial**

- **Acceptance scope:** official validators, A/E and backend/source matrix,
  precision, malformed inputs, ranges, cancellation, stale state, safe numbers
  and unsupported transformations.
- **Implementation:** encoder, input, hierarchy, tileset, implicit and
  resource modules; focused tests listed above.
- **Tests / command / result:** `npm test` — 68 passed, including Khronos and
  CesiumGS fixture checks. Both real Autzen and SoFi wrapper GLBs and explicit
  tilesets had zero errors/warnings. Path traversal, malformed length,
  unsafe count, queue, size and fixture cancellation checks passed.
  `npm audit --omit=dev` and clean Adapter/combined runtime installs reported
  zero vulnerabilities.
- **Backend:** fixture data plus real Adapter 0.6.0 copc-js sources.
- **Remaining / satisfied:** no truncated real Range, corrupted real node,
  Blob/File, Rust, E cache, vertical transform, or active decode/encode abort
  test. Full development audit has five high findings under the validator's
  `sharp`/image-processing tree; no supported safe validator upgrade was
  found. A simulated Adapter network error exposed source host/path but not
  sentinel URL credentials or signed-query parameters. Tiles does not impose a
  source-host allowlist; URL admission remains the caller's responsibility.
  Partial; #11 remains open.

### T12 — [#12 Performance and release](https://github.com/FrilLab/copc-tiles/issues/12): **Partial**

- **Acceptance scope:** A/E, Direct/on-demand/pre-generated comparison,
  network/cache cold/warm, CPU/memory/workers/cancellation, package install
  and bundle isolation, stable Adapter compatibility and release workflow.
- **Implementation:** `bench/engine.mjs`, package exports and release docs.
- **Tests / command / result:** `npm run bench:engine`; actual install and
  esbuild bundle measurements in
  [`benchmark-report-2026-10-29.md`](benchmark-report-2026-10-29.md). Packed
  Tiles ESM and strict NodeNext types passed clean consumer checks without
  Adapter. Direct-only install and bundle contained no Tiles. Full and
  runtime-only audits were recorded separately.
- **Backend:** synthetic A/E benchmark; real node browser observations; npm
  tarballs from Tiles 0.1.0 and Adapter 0.6.0.
- **Remaining / satisfied:** no Direct comparison, pre-generated full Tiles,
  production on-demand pipeline, real A/E, worker/peak browser memory or
  repeated complete-pipeline medians/p95. No publish/provenance workflow is
  configured, and package distribution/migration remains for maintainer
  review. Partial; #12 remains open.

## Test and audit summary

| Command / check | Result |
| --- | --- |
| `npm test` on Node 18.20.8, 22.23.4 and 26.12.1 | 68 passed on each; 0 failed. |
| `npm run typecheck`, `npm run build` | Passed on Node 26.12.1; Node 18.20.8 direct TypeScript build/typecheck also passed. |
| `npm run test:browser` with no real source env vars | 2 passed, 2 skipped (the opt-in real COPC tests). |
| `COPC_TILES_AUTZEN=/tmp/copc-tiles-autzen.copc.laz npm run validate:adapter-integration` | 1 passed; Autzen one-node resource wrapper rendered by Cesium and Three. |
| `COPC_TILES_SECOND_COPC_URL=https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz npx playwright test --config test/browser/playwright.config.mjs test/browser/second-source.real.spec.mjs` | 1 passed; bounded real three-node access, primary-node validator and Cesium/Three rendering. |
| Real Khronos glTF / CesiumGS Tiles validators | 0 errors and 0 warnings on the real Autzen and SoFi primary GLB/wrapper artifacts. |
| Packed Tiles ESM + strict NodeNext declarations; optional connector ESM + strict NodeNext declarations | Passed in clean consumers without Adapter; optional peer not statically loaded. |
| Adapter 0.6.0 `/cesium` clean TypeScript declaration check | Strict `NodeNext` fails on upstream extensionless imports (TS2834); passes `moduleResolution: bundler` and `skipLibCheck`. Runtime ESM passes when its optional Cesium peer is installed. |
| `npm audit` | 5 high development-only findings under `3d-tiles-validator@0.6.1` → `3d-tiles-tools@0.5.0` / `sharp@0.32.6` and related image packages. Suggested audit fix downgrades validator to 0.4.1 (major); not forced. |
| `npm audit --omit=dev`; clean Adapter runtime consumer; clean Adapter+Tiles runtime consumer | 0 vulnerabilities. |
| Signed URL diagnostics probe | Mocked Adapter open failure included source host/path, but no sentinel username, password or signed-query value. Browser test logs omit source URLs. |
| GitHub issues #1–#12 | All remain open; no issue was closed by this audit. |

## Remaining release gates

1. Publish and pack a reviewed Adapter release that contains the public
   renderer-neutral contract; verify declarations and runtime compatibility
   using that exact package.
2. Define conservative bounds for undecoded nodes in ECEF with explicit CRS,
   vertical and transform provenance, or document and review a narrower
   supported-culling policy.
3. Build a real multi-node on-demand tileset and serve its selected GLBs and
   implicit subtree resources through the actual resource provider.
4. Complete real Cesium/Three multilevel refinement, camera movement, abort,
   source switching and cleanup tests; compare to Direct at equivalent camera
   and point density.
5. Complete T11 malformed Range/binary and unsupported transform coverage;
   decide how to handle development validator advisories.
6. Run complete-pipeline repeated performance and clean package/release
   provenance checks. The package remains unpublished and no GitHub Release
   was created.

**AWAITING MAINTAINER REVIEW**

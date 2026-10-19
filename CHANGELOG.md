# Changelog

All notable changes to COPC Adapter are documented here. The project follows
the principles of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.0] - 2026-10-20

### Added

- Added incremental COPC reads from local browser `File` and `Blob` sources.
- Added the opt-in Cesium `BatchedGeometryPointRenderer` and spacing-aware
  point sizing for renderers with shader support.
- Added selectable `foveated` and `screen-projection` refinement strategies,
  plus a Cesium screen-circle Focus Lens.
- Added bounded camera-motion lookahead and opt-in predictive prefetch for
  likely next-view nodes.
- Expanded the browser Playground with local and remote sources, Cesium and
  Three.js views, and refinement and focus controls.

### Changed

- Changed the default HTTP `rangeValidation` policy to `head-fallback` across
  the Core, Cesium, Three.js, and source probe APIs. Readable `Content-Range`
  values remain strictly checked; when JavaScript cannot read that header, the
  default now requires a successful `HEAD` size check and an exact range body.
- Kept explicit `rangeValidation: 'strict'` as the strongest available HTTP
  validation policy. It requires readable request-matching `Content-Range` and
  never uses `HEAD` fallback. Local `File`, `Blob`, and custom byte sources are
  unaffected.
- Changed the default refinement strategy to `foveated`; choose
  `screen-projection` to retain the v0.5 ranking. Camera-motion lookahead now
  defaults to enabled and changes priorities only among currently visible
  candidates; set `motionLookahead: false` to disable it.

### Fixed

- Fixed Rust/WASM decoding of LAS 1.4 extra bytes in point records.

### Security and compatibility

- Successful HEAD-based compatibility validation warns once per HTTP source
  instance. This path checks exact response length and detectable size or
  readable validator changes, but cannot establish byte-offset correctness or
  cryptographic data integrity. Existing users who require the previous
  fail-closed behavior should set `rangeValidation: 'strict'` explicitly.
- The Cesium point-primitive renderer remains the default. The batched
  renderer's point identity picking is supported in 3D mode; ambiguous picks
  and 2D, Columbus View, or morphing scenes return no selection.
- Predictive prefetch remains opt-in and bounded. Attenuated point sizing needs
  a renderer with shader support; the public batched renderer supports it.

## [0.5.3] - 2026-10-17

### Added

- Added native-style Cesium and Three.js layer APIs, including Cesium
  ellipsoidal height offsets, visibility controls, and automatic framing for
  geographic WKT.
- Added Cesium `boundingSphere` from full metadata bounds in WGS84 ECEF metres,
  explicit `zoomTo()`, and typed progress and lifecycle events for both
  renderers.
- Added lifecycle generations and terminal view outcomes for settlement,
  cancellation, and errors while preserving each adapter's existing `load()`
  completion behavior.

### Improved

- Applied height offsets consistently to prepared custom data and preserved
  the streaming controller module path.
- Simplified package and Rust crate layouts, clarified API documentation, and
  improved browser regression sharding.

### Compatibility and limitations

- Existing package entrypoints and streaming defaults remain intact. Cesium
  bounds use bounded CRS sampling; invalid or unsupported metadata returns
  `undefined`. Three.js native `Box3` bounds describe instantiated root
  geometry, not the complete COPC dataset.
- No GPU renderer rewrite, complete 3D Tiles compatibility, or automatic
  vertical datum conversion is included.

## [0.5.2] - 2026-10-16

### Improved

- Load independent hierarchy pages concurrently with a
  bounded limit of four active requests.
- Derive adaptive view distance from the visible world
  footprint with overscan and hysteresis.
- Preserve existing hierarchy, LoD, and point budgets.

### Changed

- Parallelize viewer CI validation without removing
  existing test coverage.

### Validation

- SoFi median first-visible-point latency improved
  from 67.17 s to 23.37 s.
- SoFi median hierarchy query time improved
  from 59.25 s to 14.52 s.
- See the #254 and #191 benchmark records.

## [0.5.1] - 2026-10-16

### Added

- Added opt-in `head-fallback` validation for servers whose browser responses do
  not expose `Content-Range`. It checks readable `HEAD` size and exact response
  body length, but cannot prove the returned byte offset or immutable object
  version. Strict `Content-Range` validation remains the default.

### Security

- Limited HTTP range reads to 64 MiB per request and four concurrent requests
  per source by default. Oversized or surplus response bodies are rejected;
  streamed surplus is canceled early. Applications that need larger valid
  ranges can raise `maxRangeBytes` and `maxConcurrentRangeRequests`. A valid
  single range larger than 64 MiB now needs an explicit higher limit.

## [0.5.0] - 2026-10-14

### Added

- Added opt-in LAS extra schema dimension decoding for `CopcJsBackend`, including
  picked-point `dimensions` and exact `bigint` values for unscaled 64-bit
  integers (PR #205).
- Added runtime Cesium point styling through `getStyle()` / `setStyle()`,
  including classification include/exclude filters without re-decoding cached
  point chunks (PR #215).
- Added an EPSG:5186 Korean CRS conformance fixture and independent controls
  for TypeScript, Rust, and Cesium point placement (PR #214).
- Added bilingual VitePress documentation and a standalone Cesium Playground
  under the existing GitHub Pages site (PRs #222-#225).
- Added English and Korean HTTP Range/CORS hosting guides for AWS S3,
  MinIO AIStor, and nginx, including browser diagnostics and certificate
  verification guidance (PR #245).

### Changed

- Cancel obsolete HTTP Range point reads on view and lifecycle changes, with
  cancellation diagnostics and retryable cache behavior (PR #217).
- Coalesce bounded adjacent HTTP Range reads while preserving requested byte
  slices, input order, and cancellation semantics (PR #218).

### Validation and compatibility

- Expanded Rust Worker responsiveness, SoFi multi-GB streaming, EPSG:5186,
  cancellation, and browser regression evidence (PRs #214, #216, #219-#221).
- `copc-js` remains the default backend; Rust/WASM remains opt-in. Extra schema
  dimensions are currently supported by `copc-js` only.
- No intentional breaking public API change. The existing Cesium and Three.js
  entrypoints and application-owned viewer/scene lifecycles are preserved.
- Browser cross-origin COPC reads still require compatible Range/CORS server
  configuration; the new deployment guides do not change server behavior.

## [0.4.0] - 2026-09-12

### Added

- Added first-class Three.js support through `CopcThreeLayer` and the
  `@frillab/copc-adapter/three` entrypoint.
- Added the explicit `@frillab/copc-adapter/cesium` entrypoint while retaining
  the root Cesium import for compatibility.
- Added the renderer-neutral shared streaming/view contracts and prepared-point
  data used by the Cesium and Three.js adapters.
- Added the pure Rust `copc-adapter-core` processing engine and thin
  `copc-adapter-wasm` ABI,
  including the validated Rust CRS scope, fused point preparation, and related
  diagnostics.
- Added packed external Three.js/Vite consumer validation for the isolated
  renderer entrypoint.

### Changed

- Rebuilt the Cesium adapter over the shared renderer-neutral streaming core;
  Three.js now consumes the same streaming and prepared-point boundaries.
- Applied bounded center-directed refinement influence to effective SSE while
  keeping refinement influence and scheduling relevance as separate concerns.
- Preserved final selected-node visual priority into streaming work order and
  replaced batch completion barriers with bounded priority scheduling. Ready
  nodes can surface without waiting for unrelated slower siblings.
- Made Cesium and Three.js optional peers for renderer-specific subpath imports.
- Moved Rust backend node preparation through a fused decode, CRS, geographic,
  ECEF, attribute, and statistics path where supported.

### Fixed / Improved

- Fixed loss of selector-computed visual priority when the final frontier was
  reordered for streaming.
- Fixed batch-level completion latency that delayed ready high-priority nodes
  behind slower siblings.
- Added aggregate priority, queue, concurrency, completion, cancellation, and
  first-ready diagnostics for streaming validation.

### Compatibility and known state

- `copc-js` remains the default and reference runtime path; Rust/WASM remains
  opt-in.
- `proj4js` remains retained for current compatibility and reference paths.
- Rust CRS support is limited to the validated supported matrix; this release
  does not claim full PROJ or vertical-datum parity.
- Applications retain ownership of their Cesium `Viewer`, Three.js scene and
  camera, renderer, render loop, and other viewer/engine resources.
- Focus Lens, predictive prefetch, adaptive view distance, hierarchy-priority
  research, and v0.5 quality hardening are not included.

## [0.3.0] - 2026-08-31

### Added

- Added a coverage-preserving mixed-LoD frontier that treats node and point
  budgets as refinement constraints.
- Added gaze-aware refinement priority and screen-space-error hysteresis.
- Added coverage-safe coarse-to-fine and fine-to-coarse renderer transitions,
  including stale-generation protection.

### Changed

- Changed hierarchy discovery to follow the active perspective view with a
  conservative view-driven query instead of relying on a camera-position-
  centered spatial query.
- Improved deterministic and browser validation for mixed-LoD coverage,
  oblique views, and transition stability.

### Fixed

- Fixed oblique-view hierarchy coverage gaps caused by bounded hierarchy
  queries being centered around the camera position instead of the active
  visible view.

## [0.2.1] - 2026-08-31

### Fixed

- Fixed Rust/WASM asset resolution in affected Vite development consumers
  without requiring `optimizeDeps.exclude`.
- Preserved package-owned Rust Worker decoding across dependency-optimized Vite
  environments.
- Fixed Rust Worker peak-activity diagnostics.

### Compatibility note

This release improves Rust/WASM compatibility in dependency-optimized Vite
development environments and removes the workaround required by affected older
Vite consumers. Modern Vite 8 releases also contain an upstream fix for the
original asset-resolution behavior.

## [0.2.0] - 2026-08-30

- Added incremental, view-aware hierarchy loading with frustum and
  screen-space-error refinement.
- Added differential backend conformance coverage and an opt-in Rust/WASM
  backend with selective LAS 1.4 point-format 6/7/8 decoding.
- Added bounded Worker decode, decoded-point caching, rendered-point budget
  backpressure, and renderer-stage diagnostics.
- Added point picking/inspection and a structured COPC Range/CORS source probe.
- Validated the packed artifact in an external Vite + Cesium consumer.

## [0.1.1]

- Corrected the npm packaging boundary by cleaning the library output before a
  build and excluding sample COPC data from the published artifact.
- Added packed-artifact smoke coverage for an external Cesium/Vite consumer.
- Published the typed ESM library with package-local decoder runtime assets.

[Unreleased]: https://github.com/mors119/copc-adapter/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/mors119/copc-adapter/compare/v0.5.3...v0.6.0
[0.5.3]: https://github.com/mors119/copc-adapter/compare/v0.5.2...v0.5.3
[0.5.2]: https://github.com/mors119/copc-adapter/compare/v0.5.1...v0.5.2
[0.5.1]: https://github.com/mors119/copc-adapter/compare/v0.5.0...v0.5.1
[0.5.0]: https://github.com/mors119/copc-adapter/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/mors119/copc-adapter/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mors119/copc-adapter/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/mors119/copc-adapter/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mors119/copc-adapter/compare/v0.1.1...v0.2.0
[0.1.1]: https://www.npmjs.com/package/@frillab/copc-adapter/v/0.1.1

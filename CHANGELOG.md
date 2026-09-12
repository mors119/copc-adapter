# Changelog

All notable changes to COPC Adapter are documented here. The project follows
the principles of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.4.0] - 2026-09-12

### Added

- Added first-class Three.js support through `CopcThreeLayer` and the
  `@frillab/copc-adapter/three` entrypoint.
- Added the explicit `@frillab/copc-adapter/cesium` entrypoint while retaining
  the root Cesium import for compatibility.
- Added the renderer-neutral shared streaming/view contracts and prepared-point
  data used by the Cesium and Three.js adapters.
- Added the pure Rust `copc-core` processing engine and thin `copc-wasm` ABI,
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

[Unreleased]: https://github.com/mors119/copc-adapter/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/mors119/copc-adapter/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/mors119/copc-adapter/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/mors119/copc-adapter/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mors119/copc-adapter/compare/v0.1.1...v0.2.0
[0.1.1]: https://www.npmjs.com/package/@frillab/copc-adapter/v/0.1.1

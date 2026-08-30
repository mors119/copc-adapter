# Changelog

All notable changes to COPC Adapter are documented here. The project follows
the principles of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

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

[Unreleased]: https://github.com/mors119/copc-adapter/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/mors119/copc-adapter/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mors119/copc-adapter/compare/v0.1.1...v0.2.0
[0.1.1]: https://www.npmjs.com/package/@frillab/copc-adapter/v/0.1.1

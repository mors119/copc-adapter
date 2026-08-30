# Changelog

All notable changes to COPC Adapter are documented here. The project follows
the principles of [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and versions follow [Semantic Versioning](https://semver.org/).

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

[0.2.0]: https://github.com/mors119/copc-adapter/compare/v0.1.1...HEAD
[0.1.1]: https://www.npmjs.com/package/@frillab/copc-adapter/v/0.1.1

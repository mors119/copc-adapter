# Release checklist — Adapter 0.7.1 integration

> Historical release review for the 2026-10-31 Adapter integration. The
> monorepo migration is recorded separately in
> [`docs/monorepo-development.md`](../../../docs/monorepo-development.md).
> Tiles remains an independent npm distribution. This checklist does not
> authorize merging, publishing, tagging, or closing issues.

This records the review state for the Adapter 0.7.1 integration and
conservative-bounds capability at that time. It is not a release approval. No npm package
was published, no GitHub Release was created, no issue was closed, and no
Adapter change was made.

## Verified in this milestone

- [x] Read repository instructions, README, all T1–T12 issue acceptance
  criteria, Adapter issue #383, and relevant release/API documentation.
- [x] Verify npm Registry `0.7.1` version, exports, integrity, package size,
  optional peer dependencies and actual downloaded tarball.
- [x] Pin the exact `0.7.1` development and optional peer dependency; update
  lockfile while retaining optional peer metadata.
- [x] Verify normal clean installs on Node 18.20.8 and 22.23.4. Record the
  development-only `better-sqlite3@11.10.0` Node 26 V8 build failure and the
  successful Node 26 test run after local Sharp rebuild.
- [x] Extend the source-neutral connector using only public Adapter `/core`
  types and runtime API. Preserve unsupported reasons and provenance; fail
  closed on missing/mismatched API or unsupported results.
- [x] Exercise supported EPSG:4326 / EPSG:4979 geographic fixtures and
  unsupported unknown-height and EPSG:32611 projected fixtures with both
  backends. Bounds evaluation made no source Range requests.
- [x] Verify real Autzen requested-node read, both backends, GLB validation,
  Cesium/Three point visibility, movement, encoder precision and explicit
  `unsupported-horizontal-crs` result.
- [x] Add packed consumer coverage for strict TypeScript 5.9.3 NodeNext and
  Bundler checks, Adapter root/Core/Cesium/Three imports, renderer-free Core,
  and Adapter-free Tiles Engine usage.
- [x] Run typecheck, Adapter Core typecheck, build, all unit/validator/resource
  suites, Chromium integration, benchmark, runtime-scope audit, packed
  consumer, and pack dry-run. Exact pass/skip counts are in
  [`implementation-status.md`](./implementation-status.md).
- [x] Keep all T1–T12 issues open and report remaining criteria individually.

## Still required before complete COPC-to-Tiles support

- [ ] Real SoFi integration with both backends, hierarchy nodes, prepared
  points, GLB and renderers. This run skipped it because no binary or URL was
  available.
- [ ] Reviewed Adapter-supported projected conservative bounds for Autzen
  EPSG:2992 and SoFi EPSG:32611. Tiles must continue to reject these classes
  until public Adapter results certify them.
- [ ] Real/validated vertical-grid coverage, no-data, epoch and transform
  evidence; larger geographic edge/polar/date-line coverage.
- [ ] Production live multi-node COPC-to-Tiles request path, including
  hierarchy completeness, geometric error, sparse nodes, subtrees, bounded
  queues and cancellation.
- [ ] Live multi-node Cesium and Three refinement, same bytes, camera movement,
  source switching and cleanup. The current real Autzen renderer wrapper is
  one node only.
- [ ] Broader malformed data/Range, File/Blob, real Extra Bytes, full A/E cache,
  peak temporary memory, retained browser memory, and browser/platform tests.
- [ ] T12 comparison of Direct, on-demand Tiles and pre-generated Tiles with
  comparable datasets/camera paths and both supported distribution models.

## Historical distribution and publication gate

The monorepo integration selected the separate `@frillab/copc-tiles`
distribution and validated that it packs and installs independently. T12's
runtime/performance comparisons remain incomplete.

- [ ] Compare optional Adapter `/tiles` and standalone `@frillab/copc-tiles`
  using packed install footprint, lockfile dependency graph, runtime bundles,
  renderer dependencies, compatibility and release overhead.
- [ ] Maintainer review approves scope, package version, documentation,
  changelog and release workflow.
- [ ] Final maintainer approval before merge, publish, release or issue closure.

Adapter 0.7.1 compatibility and strict NodeNext are verified. The package
remains `0.1.0`; release readiness is **CONDITIONAL** because projected source
bounds and real multi-node Tiles LOD remain incomplete.

**AWAITING MAINTAINER REVIEW**

# Roadmap

The roadmap describes capabilities and architectural direction. It is
deliberately independent of issue numbers, release versions, and temporary
implementation order.

## Project goal

COPC Adapter is a browser library for directly streaming and visualizing COPC
point clouds through renderer adapters such as CesiumJS and Three.js, without
preprocessing the source into another tile format.

## Current capabilities

The current main branch provides:

- direct COPC access through browser HTTP Range requests;
- incremental hierarchy loading;
- a renderer-neutral TypeScript streaming controller;
- coverage-preserving mixed-LoD selection;
- gaze-aware priority and LoD hysteresis;
- bounded node and point workload;
- an opt-in Rust/WASM path for LAS/COPC parsing, hierarchy interpretation,
  LAZ decoding, and requested point-field extraction;
- a default `copc-js` backend;
- CesiumJS and Three.js adapters;
- root, Cesium, and Three.js package exports; and
- typed project-owned metadata, point buffers, diagnostics, and lifecycle
  contracts.

The default runtime still performs CRS transformation and WGS84/ECEF
preparation in TypeScript. `copc-core` now provides an opt-in reusable Rust
CRS/ECEF path through `copc-wasm`; browser Range I/O and streaming policy
remain TypeScript responsibilities. See [ARCHITECTURE.md](ARCHITECTURE.md) for
the current implementation boundaries.

## Active architecture direction

### Pure Rust processing domain

The shipped extraction is complete for the current supported scope:
`copc-core` owns native-testable COPC/LAS metadata and hierarchy parsing,
supported LAZ point decoding, reusable CRS/WKT transformation, WGS84/ECEF
preparation, fused point preparation, statistics, and typed domain errors,
while `copc-wasm` remains the ABI and memory/transport wrapper. Broader Rust
coverage and backend migration remain future work.

### Rust CRS capability

The reusable Rust CRS pipeline is integrated into `copc-core` and the WASM
boundary using real COPC WKT/CRS fixtures and differential validation against
the current JavaScript path. The opt-in TypeScript wrapper reuses initialized
handles but does not change the default runtime. The compatibility gate is
documented in [the issue #171 audit](benchmarks/issue-171-proj4rs-compatibility.md)
and the implementation evidence in
[the issue #173 integration record](benchmarks/issue-173-rust-crs-integration.md).

### Renderer-neutral prepared point pipeline

The current Rust path returns typed renderer-neutral buffers from the processing
core. Continue extending point-level binary and numeric coverage in Rust while
keeping camera, hierarchy, LoD, cache, and workload policy in the shared
TypeScript streaming core.

### Fused Worker processing

The current Rust Worker prepares supported node data before returning it to
TypeScript, reducing repeated main-thread passes and WASM crossings. Continue
measuring end-to-end responsiveness, transfer cost, memory, and renderer
preparation rather than optimizing an isolated decode stage.

### Thin renderer integration

CesiumJS and Three.js consume the same renderer-neutral prepared data.
Continue keeping engine objects, camera conversion, local frames, picking,
styling details, and resource disposal in renderer adapters without
reimplementing COPC, CRS, hierarchy, or streaming logic.

### Rust correctness and performance validation

Validate native Rust behavior, the WASM boundary, CRS behavior, real datasets,
browser integration, and measured performance before changing backend defaults.
Rust-path failures must remain visible during this validation.

### LoD quality improvements

Continue improving allocation of bounded point budgets toward visually
important regions while preserving coarse coverage. Candidate policies should
be judged using deterministic tests and measured browser workloads.

### Release readiness

Prepare a release only after architecture, renderer, package, LoD, browser, and
conformance validation are satisfactory. Release planning belongs in release
artifacts, not in the permanent architecture vocabulary.

## Later work

Possible later investigations include:

- making the Rust backend the default or authoritative implementation after
  sufficient conformance;
- removing reference runtime dependencies only after the replacement has
  adequate coverage;
- Focus Lens and other deliberate refinement-influence experiments;
- camera-motion lookahead and predictive prefetch;
- wider renderer and package-boundary research;
- scalable rendering approaches; and
- occlusion only when measurement supports conservative, useful behavior.

These are capability areas, not commitments to a particular version or
implementation sequence.

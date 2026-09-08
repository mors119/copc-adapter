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

Current CRS transformation, WGS84/ECEF preparation, and renderer-local
preparation remain in TypeScript. Rust/WASM decoding is worker-backed when the
browser provides `Worker`, but browser Range I/O and streaming policy remain
TypeScript responsibilities. See [ARCHITECTURE.md](ARCHITECTURE.md) for the
current implementation boundaries.

## Active architecture direction

### Pure Rust processing domain

The first extraction is complete: `copc-core` owns native-testable COPC/LAS
metadata and hierarchy parsing, supported LAZ point decoding, and typed domain
errors, while `copc-wasm` remains the ABI and memory/transport wrapper. Future
work may move CRS, world-coordinate preparation, statistics, and fused point
preparation into the same core; this does not claim the broader #169 migration
is complete.

### Rust CRS capability

Evaluate and integrate a Rust CRS pipeline using real COPC WKT/CRS fixtures and
differential validation against the current JavaScript path. Adoption depends
on measured supported behavior and explicit handling of unsupported CRS input.
The completed compatibility gate is documented in
[the issue #171 audit](benchmarks/issue-171-proj4rs-compatibility.md); the
remaining upstream and adapter-boundary follow-ups must be resolved before
production integration.

### Renderer-neutral prepared point pipeline

Move suitable point-level binary and numeric work into the Rust processing core
and return typed renderer-neutral buffers. Keep camera, hierarchy, LoD, cache,
and workload policy in the shared TypeScript streaming core.

### Fused Worker processing

Reduce repeated main-thread passes and WASM crossings by preparing point data
inside the Worker before returning it to TypeScript. Measure end-to-end effects
on responsiveness, transfer cost, memory, and renderer preparation rather than
optimizing an isolated decode stage.

### Thin renderer integration

Ensure CesiumJS and Three.js consume the same renderer-neutral prepared data.
Renderer adapters should own engine objects, camera conversion, local frames,
picking, styling details, and resource disposal without reimplementing COPC,
CRS, hierarchy, or streaming logic.

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

# Roadmap

## Project Goal

> Load COPC data directly in CesiumJS and visualize selected point-cloud chunks
> in the browser without a preprocessing conversion step.

## Current MVP

| Area | Status | Current scope |
| --- | --- | --- |
| COPC source access | Implemented | Shared project-owned boundary with `copc.js` default and opt-in Rust/WASM backend |
| Metadata and hierarchy | Implemented | Metadata loading plus root-first incremental hierarchy-page queries |
| Point data | Implemented | XYZ plus available intensity, classification, and RGB dimensions converted to project-owned typed buffers |
| Coordinate transformation | Implemented | COPC CRS values transformed to WGS84 coordinates |
| Cesium rendering | Implemented | Point primitive collections rendered in a Cesium viewer |
| Point styling | Implemented | Fixed cyan, elevation, RGB, intensity, and classification modes with missing-attribute fallback |
| Streaming | Implemented | Incremental view-driven hierarchy loading, perspective frustum/SSE selection, coverage-preserving mixed-LoD frontier, gaze priority, hysteresis, and bounded node/point workload |
| Renderer transitions | Implemented | Coverage-safe coarse-to-fine and fine-to-coarse replacement with stale-generation suppression |
| Public API | Implemented | `CopcCesiumLayer` load, attach, detach, unload, reload, and destroy lifecycle |
| WASM decoder | Implemented | Rust/WASM LAS 1.4 point 6/7/8 node decoding with selected project-owned attributes |
| ESM package build | Implemented | Packed ESM bundle, declarations, package-local WASM assets, and Cesium peer dependency |

## Known Gaps

- Hierarchy loading starts with the root page and follows relevant pages for a
  conservative envelope of the active perspective view; invalid or missing
  perspective data uses a finite camera-based fallback. Broader optimization
  for very large datasets remains future work.
- Selection uses adapter-owned perspective frustum and screen-space error,
  mixed-LoD coverage frontier, gaze-aware priority, hysteresis, and node/point
  workload caps.
- Range loading and point preparation remain workload-dependent, but Rust
  browser decode is worker-backed with bounded concurrency and streaming uses a
  rendered-point budget with stale-work suppression.
- Intensity normalization currently uses each loaded node buffer's range.
- The packed artifact is validated in a clean Vite + Cesium consumer; broader
  consumer compatibility validation remains future work.
- Repository-owned demo media is available in `docs/assets/`; there is no
  hosted demo yet.

## Next Work

1. Broaden Rust backend format and edge-case coverage before considering it for
  the default backend.
2. Explore measured scalable rendering approaches and dataset-global attribute
   statistics; the Issue #48 boundary and baseline are complete.
3. Add a public Playground, then explore Focus Lens refinement influence,
   camera-motion lookahead, and predictive prefetch.
4. Continue larger-dataset validation and revisit occlusion culling only after a
   validation run quantifies hidden
   in-frustum workload; see the [Issue #60 investigation](benchmarks/issue-60-occlusion.md)
   and [Issue #68 report](benchmarks/issue-68-streaming.md).
5. Continue broader consumer compatibility validation beyond the current packed
   consumer test.

## Submission State

The v0.3.0 MVP demonstrates the intended direct COPC-to-Cesium path with
coverage-preserving, view-aware streaming on local and larger COPC validation
datasets. The roadmap keeps scalable rendering, predictive/focus features,
broader backend coverage, and wider consumer validation as future work.

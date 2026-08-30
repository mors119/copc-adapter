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
| Streaming | Implemented | Camera-driven selection, basic depth/distance limits, and bounded cache |
| Public API | Implemented | `CopcCesiumLayer` load, attach, detach, unload, reload, and destroy lifecycle |
| WASM decoder | Implemented | Rust/WASM LAS 1.4 point 6/7/8 node decoding with selected project-owned attributes |
| ESM package build | Implemented | Packed ESM bundle, declarations, package-local WASM assets, and Cesium peer dependency |

## Known Gaps

- Hierarchy loading starts with the root page and follows relevant intersecting
  pages for the current project-coordinate bounds and target level. Broader
  optimization for very large datasets remains future work.
- Selection uses adapter-owned viewport-aware screen-space error with depth and
  node-count safety caps.
- Range loading and point preparation remain workload-dependent, but Rust
  browser decode is worker-backed with bounded concurrency and streaming uses a
  rendered-point budget with stale-work suppression.
- Intensity normalization currently uses each loaded node buffer's range.
- The v0.2.0 packed artifact is validated in a clean Vite + Cesium consumer;
  broader consumer compatibility validation remains future work.
- Repository-owned demo media is available in `docs/assets/`; there is no
  hosted demo yet.

## Next Work

1. Improve view-aware LOD selection and hierarchy loading for larger datasets.
2. Broaden Rust backend format and edge-case coverage before considering it for
  the default backend.
3. Explore measured scalable rendering approaches and dataset-global attribute
   statistics; the Issue #48 boundary and baseline are complete.
4. Revisit occlusion culling only after a validation run quantifies hidden
   in-frustum workload; see the [Issue #60 investigation](benchmarks/issue-60-occlusion.md)
   and [Issue #68 report](benchmarks/issue-68-streaming.md).
5. Continue broader consumer compatibility validation beyond the tested
   v0.2.0 packed consumer.

## Submission State

The MVP demonstrates the intended direct COPC-to-Cesium path with the local
Autzen sample. Its submission value is the working end-to-end pipeline and a
clear account of the remaining performance, rendering, and distribution work;
the roadmap does not treat those future items as implemented.

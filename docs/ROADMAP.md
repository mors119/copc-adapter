# Roadmap

## Project Goal

> Load COPC data directly in CesiumJS and visualize selected point-cloud chunks
> in the browser without a preprocessing conversion step.

## Current MVP

| Area | Status | Current scope |
| --- | --- | --- |
| COPC source access | Implemented | Browser-readable URLs and local sample files through `copc.js` getters |
| Metadata and hierarchy | Implemented | Metadata loading plus recursive hierarchy-page traversal |
| Point data | Implemented | Selected point-data views converted to project-owned buffers |
| Coordinate transformation | Implemented | COPC CRS values transformed to WGS84 coordinates |
| Cesium rendering | Implemented | Point primitive collections rendered in a Cesium viewer |
| Point styling | Implemented | Backward-compatible fixed cyan and dataset-normalized elevation modes |
| Streaming | Implemented | Camera-driven selection, basic depth/distance limits, and bounded cache |
| Public API | Implemented | `CopcCesiumLayer` load, attach, detach, unload, reload, and destroy lifecycle |
| WASM decoder | Implemented | Rust/WASM interleaved XYZ buffer decoding |
| ESM package build | Implemented | Bundle and declaration build configuration; no npm publication yet |

## Known Gaps

- Hierarchy metadata is traversed before point streaming begins.
- Selection is heuristic-based rather than screen-space-error-based.
- Main-thread loading and decoding can affect responsiveness for larger data.
- RGB, intensity, and classification attributes are not decoded or styled yet.
- Rust/WASM does not yet parse COPC metadata or hierarchy.
- Browser runtime assets are not packaged for a published npm release.
- The repository contains no owned screenshot, GIF, or hosted demo.

## Next Work

1. Improve LOD selection with screen-space error and viewport-aware metrics.
2. Evaluate Web Workers for hierarchy, loading, and decoder work.
3. Extend the Rust/WASM implementation beyond the XYZ interleaving boundary.
4. Decode optional LAS attributes, add attribute styling, and explore scalable rendering approaches.
5. Complete browser runtime-asset packaging and publish the library.
6. Add repository-owned demo media when a reproducible capture is available.

## Submission State

The MVP demonstrates the intended direct COPC-to-Cesium path with the local
Autzen sample. Its submission value is the working end-to-end pipeline and a
clear account of the remaining performance, rendering, and distribution work;
the roadmap does not treat those future items as implemented.

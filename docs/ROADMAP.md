# Roadmap

## Project Goal

> Load COPC data directly in CesiumJS and visualize selected point-cloud chunks
> in the browser without a preprocessing conversion step.

## Current MVP

| Area | Status | Current scope |
| --- | --- | --- |
| COPC source access | Implemented | Pluggable project-owned backend/source boundary with `copc.js` as the default |
| Metadata and hierarchy | Implemented | Metadata loading plus recursive hierarchy-page traversal |
| Point data | Implemented | XYZ plus available intensity, classification, and RGB dimensions converted to project-owned typed buffers |
| Coordinate transformation | Implemented | COPC CRS values transformed to WGS84 coordinates |
| Cesium rendering | Implemented | Point primitive collections rendered in a Cesium viewer |
| Point styling | Implemented | Fixed cyan, elevation, RGB, intensity, and classification modes with missing-attribute fallback |
| Streaming | Implemented | Camera-driven selection, basic depth/distance limits, and bounded cache |
| Public API | Implemented | `CopcCesiumLayer` load, attach, detach, unload, reload, and destroy lifecycle |
| WASM decoder | Implemented | Replaceable point-decoder boundary with Rust/WASM interleaved XYZ decoding as the default |
| ESM package build | Implemented | Packed ESM bundle, declarations, package-local WASM assets, and Cesium peer dependency |

## Known Gaps

- Hierarchy metadata is traversed before point streaming begins.
- Selection is heuristic-based rather than screen-space-error-based.
- Main-thread loading and decoding can affect responsiveness for larger data.
- Intensity normalization currently uses each loaded node buffer's range.
- Rust/WASM does not yet parse COPC metadata or hierarchy.
- The package is not published to npm yet.
- The repository contains no owned screenshot, GIF, or hosted demo.

## Next Work

1. Improve LOD selection with screen-space error and viewport-aware metrics.
2. Evaluate Web Workers for hierarchy, loading, and decoder work.
3. Extend the Rust/WASM implementation beyond the XYZ interleaving boundary.
4. Explore scalable rendering approaches and dataset-global attribute statistics.
5. Publish the library after broader consumer compatibility validation.
6. Add repository-owned demo media when a reproducible capture is available.

## Submission State

The MVP demonstrates the intended direct COPC-to-Cesium path with the local
Autzen sample. Its submission value is the working end-to-end pipeline and a
clear account of the remaining performance, rendering, and distribution work;
the roadmap does not treat those future items as implemented.

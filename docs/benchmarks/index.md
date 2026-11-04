# Historical Benchmarks

These reports preserve measurements, experiments, and validation records from
the issues and checkouts where they were produced. Their commands, package
paths, dependencies, source data, and browser or hardware environments describe
those historical runs; they may need the matching revision and are not current
setup instructions or performance guarantees. See the
[monorepo development guide](../monorepo-development.md) for current commands.

## Renderer

- [Issue #48: Cesium renderer boundary](issue-48-renderer.md)
- [Issue #142: Three.js CPU renderer observation](issue-142-three-renderer.md)
- [Issue #303: Three.js browser renderer profile](issue-303-three-renderer.md)

Issue #142 measures CPU scene-object preparation without WebGL. Issue #303
measures browser rendering and GPU-related behavior, so the records cover
different parts of the renderer path.

## Streaming, workers, and cache

- [Issue #60: Occlusion-culling investigation](issue-60-occlusion.md)
- [Issue #68: Streaming, memory, and backpressure](issue-68-streaming.md)
- [Issue #208: Worker responsiveness](issue-208-worker-responsiveness.md)
- [Issue #210: HTTP Range coalescing](issue-210-range-coalescing.md)
- [Issue #212: SoFi multi-GB browser streaming](issue-212-sofi-multigb-streaming.md)
- [Issue #254: Hierarchy concurrency](issue-254-hierarchy-concurrency.md)
- [Issues #324 and #326: ECEF cache layouts](issue-324-ecef-cache-layouts.md)

## Coordinates and refinement

- [Issue #171: `proj4rs` / `proj4wkt` compatibility](issue-171-proj4rs-compatibility.md)
- [Issue #173: Rust CRS integration](issue-173-rust-crs-integration.md)
- [Issue #191: Adaptive view distance](issue-191-adaptive-view-distance.md)

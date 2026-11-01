# T10 Three.js browser evidence

## Fixture integration

`npm run test:browser` sends the same standard fixture GLBs served by the T8
`TileResourceServer` to the NASA-AMMOS `3d-tiles-renderer` Three.js integration
and public `GLTFLoader`. The browser test verifies six points across root and
child content, normalized RGB values, indexed `EXT_structural_metadata`
intensity/classification values, ECEF placement within one centimetre,
non-background rendered pixels, cached resources, and tile/group disposal.

This uses the same 3D Tiles/glTF bytes as Cesium. No Three-specific tile format
or geometry encoding is introduced. The recorded run uses headless Chromium
and SwiftShader; it is renderer integration evidence, not a hardware GPU
benchmark. The 2026-10-30 full browser suite measured 55.1 ms until both
models loaded and 28.4 ms for the two frames after load at 640×480. This Three
run followed Cesium in the same browser server and reused its fixture resource
cache, so the values are not directly comparable with the Cesium cold-load time.

## Real Adapter 0.7.1 Registry package

The real-source test imports the public `/core` export from the actual
published Adapter 0.7.1 Registry package. The same pre-generated one-node
Autzen GLB used by Cesium is consumed through the public `3d-tiles-renderer`
Three.js path. The Chromium integration passed with both `copc-js` and
Rust/WASM. Three loaded and rendered 5,122 points before and after a camera
move, exposed encoded RGB and the `intensity`/`classification` structural
metadata properties, and disposed the active tile. First-point world error
was about 1.5 µm; exact backend precision results are in the [packed API
matrix](./adapter-api-compatibility.md). This is one pre-generated real
Autzen resource, not a multi-node COPC tileset. Separately, the Three fixture
now consumes the synthetic live explicit provider's two-node hierarchy over
HTTP and verifies on-demand GLBs, metadata, camera movement, and disposal.
The real SoFi selected node `2-3-0-0` (1,131 points) also rendered through
Three from the public COPC source after bounded hierarchy/point reads. At
640×480 the SwiftShader
`copc-js` run produced 4,640 initial and 4,606 post-move non-background
pixels. In the latest 2026-10-30 full browser run, Three load/render measured
182.6 ms / 165.0 ms. The separate integration command measured 204.4 ms /
182.6 ms. These are individual
observations, not a stable latency distribution. The measurements include
browser startup and local resource handling; they are not a hardware or
Direct-rendering comparison.

Adapter 0.7.1 has a separate conservative source-cell API, but it reports
`unsupported-horizontal-crs` for real Autzen EPSG:2992 and SoFi EPSG:32611.
No unsupported cell bound is replaced with decoded-point bounds. Real
selected-node rendering does not establish projected multi-node bounds.

## Acceptance boundary

Synthetic two-node live-provider and real selected-node Autzen/SoFi rendering
pass in headless Chromium with SwiftShader. Multi-level real COPC hierarchy,
zoom-driven refinement, source cancellation/cleanup during real renderer
requests, representative GPU performance, and cross-renderer visual coverage
comparison remain unverified. Strict packed NodeNext consumers pass; projected
multi-node bounds and real live LOD remain the T10 blockers. T10 remains
partial.

# T9 Cesium browser evidence

## Fixture integration

`npm run test:browser` loads the source-neutral fixture tileset in CesiumJS
through the public `Viewer` and `Cesium3DTileset.fromUrl` APIs. Cesium fetches
the `tileset.json` and both GLBs from the actual T8 `TileResourceServer` over
HTTP. The test verifies six loaded points, root and refined child content,
ECEF tile centers, red/green/blue rendered pixels, resource cache reuse, and
`Viewer.destroy()` cleanup.

The browser run uses headless Chromium with SwiftShader on the recorded
development environment. It is deterministic renderer integration evidence,
not a hardware GPU benchmark or real COPC hierarchy test. The 2026-10-30 full
suite measured 641.6 ms to load initial fixture tiles and 392.2 ms for the two
frames after load at 640×480. Browser startup, cold fixture requests and
SwiftShader are included; this timing is not a stable performance baseline.

## Real Adapter 0.7.1 Registry package

The real-source test installs the actual published Adapter 0.7.1 Registry
package and imports its public `/core` export. It opens the Autzen COPC, reads
node `4-11-2-0` (5,122 points), passes the returned A-shaped ECEF Float64
buffers through the Tiles connector, and encodes a 119,292-byte GLB. Both
`copc-js` and Rust/WASM passed the Chromium integration. The test validates the
GLB and a test-only one-node tileset, then uploads the bytes to the test
resource server. Public `Cesium3DTileset.fromUrl` fetched both `tileset.json`
and the GLB. With normal frustum culling and `maximumScreenSpaceError: 1`,
Cesium selected and rendered all 5,122 points and kept them visible after a
camera move. The transformed bound center matches the encoder origin (0 m
error); first rendered point error was about 1.5 µm. Exact per-backend ranges,
validator output and precision are in the [packed API matrix](./adapter-api-compatibility.md).
The camera location was -123.062693°, 44.051994°; the 640×480 SwiftShader
`copc-js` run counted 9,812 initial and 9,497 post-move non-background pixels.
In the latest 2026-10-30 full browser run, Cesium load/render measured
1,166.5 ms with `copc-js` and 1,086.3 ms with Rust/WASM. In the separately
rerun integration command it measured 1,226.3 ms and 1,036.1 ms. These are individual browser
observations, not a stable latency distribution. The geographic position
remains a broad area check, not an independent CRS or survey-reference
validation.

The original test wrapper was culled because it declared `geometricError: 0`;
Cesium treated the root as already meeting its screen-space target and issued
no content request. The wrapper now uses the measured decoded-node bounds and
a non-zero root error, and uses the encoder's origin/transform. This is a
meaningful one-node test wrapper, not a production COPC hierarchy. Separately,
the Cesium fixture now consumes the new live explicit provider over a synthetic
two-node source; it verifies metadata-only Tileset creation, HTTP content URI
requests, child rendering, camera movement, and cleanup. Real SoFi node
`2-3-0-0` (1,131 points) was also served to Cesium from the public COPC source
after bounded hierarchy/point reads. Both real projected sources remain
unsupported for conservative bounds: Autzen EPSG:2992 and SoFi EPSG:32611.
The real-source checks still do not establish safe live multi-node COPC LOD.
No unsupported cell bound is replaced with a decoded-point bound. See the
[bounds/API evidence](./adapter-api-compatibility.md).

## Acceptance boundary

Synthetic two-node live-provider and real selected-node Autzen/SoFi rendering
pass in headless Chromium with SwiftShader. Multi-level real COPC LOD,
zoom-driven real node selection, comparison against Direct rendering,
representative GPU performance, and source switching during a renderer
request remain unverified. Strict packed NodeNext consumers pass; projected
multi-node bounds and real live LOD remain the T9 blockers. T9 remains partial.

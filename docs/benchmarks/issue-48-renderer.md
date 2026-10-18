# Issue #48 renderer benchmark

This benchmark answers whether the existing Cesium point path is expensive
enough to require a project-owned renderer boundary. It does not claim that
browser timings are deterministic.

## Reproduction

```bash
npm ci
npm ci --prefix packages
npm ci --prefix apps/dev-viewer
npm run download-samples -- autzen
mkdir -p apps/dev-viewer/public/samples
cp samples/local/autzen.copc.laz apps/dev-viewer/public/samples/autzen.copc.laz
npm run benchmark:renderer --prefix packages
npm run test:e2e --prefix apps/dev-viewer -- e2e/renderer-performance.spec.ts
```

The synthetic command uses deterministic projected coordinates and all point
attributes, with two warmups and seven measured samples. It reports minimum,
median, and maximum milliseconds. The browser benchmark repeats the same
measurements in Chromium and also runs the real Autzen Far/Near streaming
scenario.

## Environment

The recorded browser run used:

- macOS Darwin arm64;
- Apple Silicon host, 8 reported hardware threads;
- Google Chrome / HeadlessChrome 151.0.0.0;
- Chromium viewport 1280x720, device pixel ratio 1;
- Cesium WebGL forced to SwiftShader by Playwright;
- Node.js v26.7.0 for the headless synthetic command;
- Autzen classified COPC sample, 10,653,336 points, 77 MiB local file.

## Deterministic browser synthetic benchmark

Values are min / median / max milliseconds. CRS is measured before the
renderer receives its geographic buffer. Renderer preparation includes the
full `PointPrimitiveCollection` compatibility path; replacement updates the
same node key; removal is the collection removal operation.

| points | CRS transform | Cartesian3 | style/color | collection create | collection add | renderer preparation | replacement | removal |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 6.8 / 7.1 / 7.5 | 1.0 / 1.0 / 1.1 | 0.4 / 0.4 / 0.5 | 0.0 / 0.0 / 0.0 | 0.4 / 0.5 / 1.0 | 1.8 / 2.1 / 2.5 | 2.1 / 2.3 / 2.9 | 0.0 / 0.1 / 0.1 |
| 50,000 | 33.3 / 33.6 / 35.4 | 4.6 / 4.7 / 4.9 | 2.0 / 2.1 / 2.3 | 0.0 / 0.0 / 0.1 | 3.9 / 4.2 / 4.5 | 11.0 / 11.1 / 12.0 | 11.5 / 11.6 / 12.6 | 0.5 / 0.6 / 0.8 |
| 100,000 | 65.2 / 66.6 / 69.9 | 9.2 / 9.4 / 11.5 | 3.8 / 3.9 / 6.3 | 0.0 / 0.0 / 0.0 | 13.0 / 13.9 / 14.9 | 28.2 / 29.0 / 30.1 | 30.4 / 35.6 / 43.5 | 0.3 / 0.6 / 0.8 |

The Node.js collection-only run shows the same shape: at 100,000 points the
median CRS transform was 56.8 ms, Cartesian conversion 10.1 ms, style 3.9 ms,
collection creation 0.02 ms, `add()` 27.6 ms, and total renderer preparation
43.4 ms. These numbers are useful for relative attribution, not as a promise
of a fixed runtime budget.

## Real Autzen Far/Near streaming run

These are representative snapshots from the browser benchmark. The near
transition was sampled while streaming was active, so the rendered count is
not intended to equal the final dataset count.

| scenario | rendered points | loaded nodes | range fetch | decode | CRS transform | Cartesian3 | style/color | collection create | collection add | renderer preparation | longest Long Task | frame median / p95 / max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| baseline initial, before boundary extraction | 90,670 | 11 | 1,183.0 | 13.5 | 43.0 | 5.4 | 2.2 | 0.2 | 8.3 | ~16.1 | 364 | 83.6 / 134.0 / 149.4 ms |
| baseline near, before boundary extraction | 418,074 | 10 | 3,583.5 | 75.9 | 296.7 | 57.8 | 21.2 | 0.1 | 65.4 | ~144.5 | 452 | 283.4 / 516.7 / 516.7 ms |
| boundary extraction, near transition sample | 274,520 | 7 | 1,484.4 | 42.4 | 149.0 | 20.7 | 14.7 | 0.0 | 22.4 | 57.8 | 368 | 83.7 / 249.7 / 283.4 ms |

The baseline measurements were taken before the boundary extraction in the
same checkout and browser setup. The final row is a progressive early sample,
not a controlled before/after speedup claim. In the full near update, CRS
transformation is the largest measured CPU stage; renderer preparation is also
material, while collection creation and node removal are small.

Network/range fetch, decode, CRS transformation, renderer preparation, and
Cesium frame/submission effects are kept as separate measurements. The Long
Task API and animation-frame intervals are browser observations, not
deterministic test assertions. The browser benchmark also records the
`preRender` → `postRender` Cesium frame duration separately from the
application's animation-frame interval; it is a wall-time submission/frame
proxy, not a GPU-only timer.

## Decision

**YES — introduce the smallest useful boundary, without a custom renderer.**

At the representative near update, the existing path can block the main thread
for hundreds of milliseconds. That justifies allowing the controller to depend
on a project-owned renderer contract. It does not justify a GPU rewrite because
CRS work is larger than any individual collection operation and the benchmark
does not compare a batched implementation.

`PointPrimitiveRenderer` remains the compatibility implementation. It owns
only renderer node lifecycle and optional point IDs. The controller still owns
COPC loading, decoding, CRS transformation, hierarchy selection, LoD/SSE,
frustum decisions, progressive scheduling, and cache lifecycle.

## Precision check

Autzen close-range rendering was exercised at the 1 km camera scenario. The
existing `Cesium.Cartesian3.fromDegrees` path showed no visible jitter or
large-coordinate artifact in the browser acceptance run, and the rendered
height/color diagnostics remained finite and varied as expected. No RTC or
local-origin encoding was added. A custom Float32/batched renderer should
repeat this check as a separate focused follow-up if it introduces large
global coordinate buffers.

## Issue #232: public Cesium batched-point spike (2026-10-18)

The repeatable browser path is
`npm --prefix apps/dev-viewer run test:e2e -- e2e/renderer-performance.spec.ts`;
set `COPC_RENDERER_VARIANT=public-batched` to opt into the prototype. SoFi uses
the same variable with
`e2e/sofi-multigb-validation.spec.ts`. Both paths use the Rust backend, a
250,000-point budget, fixed camera scenarios, and the same Cesium 1.146.0
dependency. The SoFi browser route forwards real Range reads and adds the
missing `Access-Control-Expose-Headers` header for test observation; see
[issue #212](issue-212-sofi-multigb-streaming.md) for the direct-source CORS
limitation.

Reproduce the same browser paths in order with:

```bash
npm --prefix apps/dev-viewer run test:e2e -- e2e/renderer-performance.spec.ts
COPC_RENDERER_VARIANT=public-batched npm --prefix apps/dev-viewer run test:e2e -- e2e/renderer-performance.spec.ts
npm --prefix apps/dev-viewer run test:e2e -- e2e/sofi-multigb-validation.spec.ts
COPC_RENDERER_VARIANT=public-batched npm --prefix apps/dev-viewer run test:e2e -- e2e/sofi-multigb-validation.spec.ts
```

`npm --prefix packages run benchmark:renderer` also passed its Node synthetic
baseline after its import was updated to the current app benchmark module. At
100,000 points its median CRS transform, world-coordinate conversion, style
preparation, collection add, and total renderer preparation were 64.0, 1.7,
6.9, 20.2, and 30.9 ms, respectively. This headless collection-only row does
not measure GPU work and is reported separately from the paired browser runs.

Environment: macOS 26.6.2, Apple M2 / arm64, Node.js 26.7.0, Chrome 155.0.8059.82
headless, 1280 × 720 at DPR 1, eight reported hardware threads, Cesium 1.146.0,
WebGL2 via SwiftShader. These are single-run Chromium measurements; startup,
remote Range latency, SwiftShader, and background host load vary between runs.

### Comparable Autzen near view

The camera was moved from the issue-61 initial view to a 1 km close view over
the local 81,123,042-byte Autzen file. Both paths estimated, loaded, and
rendered the same 233,908 points across eight nodes under the 250,000-point
budget.

| renderer | range bytes | decode | point prep | ECEF→Float32 / Cartesian | style | primitive create | primitive add | renderer prep | max Long Task | frame median / p95 / max |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PointPrimitiveCollection | 1,450,612 | 68.0 ms | 115.4 ms | 10.9 ms | 17.5 ms | 0.2 ms | 43.4 ms | 75.1 ms | 419 ms | 216.6 / 416.6 / 416.6 ms |
| public Geometry(POINTS) prototype | 1,450,612 | 73.8 ms | 115.1 ms | 3.7 ms | 22.0 ms | 0.3 ms | <0.1 ms | 26.0 ms | 430 ms | 116.7 / 449.9 / 449.9 ms |

The prototype cut measured renderer preparation by 65% in this run. The
animation-frame median improved while p95 and the longest browser task did not;
the result does not establish an FPS or end-to-end speedup. `primitive add` is
only the synchronous `PrimitiveCollection.add()` call; geometry processing,
shader compilation, and GPU buffer work happen during Cesium frame updates and
are represented only indirectly by frame intervals and `preRender` →
`postRender` time.

### Larger SoFi view

The permitted public SoFi COPC is 2,029,696,615 bytes / 364,384,576 source
points. The initial camera estimated, loaded, and rendered 247,960 points in
15 nodes in both runs, within the same 250,000-point budget. The exact read
workload was 3,386,421 bytes in both runs.

| renderer | first visible | coordinate conversion | style | primitive create | primitive add | renderer prep | longest browser task | initial frame median / p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| PointPrimitiveCollection | 24.8 s | 11.9 ms | 24.0 ms | 0.4 ms | 52.4 ms | 94.4 ms | 616 ms | 233.3 / 233.3 ms (5 samples) |
| public Geometry(POINTS) prototype | 22.2 s | 8.1 ms | 14.1 ms | 2.1 ms | 0.2 ms | 24.9 ms | 462 ms | 133.3 / 133.4 ms (9 samples) |

The prototype's renderer preparation was 74% lower for this initial view. The
first-visible times are dominated by remote hierarchy and Range requests, so
their difference is not attributed to rendering. The existing SoFi test also
exercises close, overview, oblique, two nearby areas, and a return to the first
area; all selected-point and decoded-cache budgets stayed within their existing
limits. The source response still requires the test route's CORS exposure shim.

### Prototype and constraints

The opt-in `BatchedGeometryPointRenderer` creates one public `Geometry` with
`PrimitiveType.POINTS` and one `Primitive` per node. It uses the project's
prepared ECEF typed buffer, computes a Float64 node center and Float64 relative
positions on the CPU, then narrows those relative positions to Float32 vertex
data. A conservative per-node bounding sphere includes the narrowing error.
The test-only viewer enables `scene3DOnly`: `Primitive.modelMatrix` is
documented for 3D mode, so 2D and Columbus View were not exercised.

The browser smoke passed for fixed, RGB, elevation, intensity, and
classification styles, static 2 px point size, classification include filters,
show/hide, node removal, and cleanup. The candidate screenshot showed the
Autzen points aligned over the imagery at the 1 km close view. A public
`scene.pick` probe picked a node id but returned no point index. One
`GeometryInstance` has one id, so this path cannot preserve
`{nodeKey, pointIndex}` without a separate CPU hit test or a different picking
path. Style updates rebuild each node's geometry. The custom appearance has no
projected clipping-plane hook; clipping was not exercised.

The candidate retains four typed vertex arrays (position, RGB, point size, and
batch id): 32 bytes per input point, or about 7.6 MiB for 247,960 points, before
Cesium's GPU buffers and geometry objects. The default renderer's JavaScript,
Cesium collection, and GPU memory were not measured, so this is a candidate
buffer accounting proxy, not a comparable heap/GPU memory result.

The Float64 → node-relative Float32 precision test covers four ECEF extremes
(equatorial ±X and polar ±Z), 500 m local spans, and 1 mm offsets. Its maximum
coordinate error stays below 0.04 mm. Browser checks at Autzen and SoFi showed
no obvious origin displacement. No physical GPU/WebGL1 driver matrix was
tested; the shader was exercised with Chrome 155 and SwiftShader only.

### Issue #232 recommendation

**Abandon this public Primitive path as the production renderer while the
current per-point picking identity is required.** The public Geometry/Primitive
path is feasible on Cesium 1.146.0 and substantially lowers synchronous CPU
renderer preparation in these runs, but its one-id-per-geometry-instance
public picking model does not return point identity. Do not change the shipped
default. Private `DrawCommand`/`VertexArray` APIs remain a possible
version-pinned experiment for point-level picking, with upgrade and shader
maintenance costs; this spike did not expose or ship that fallback.

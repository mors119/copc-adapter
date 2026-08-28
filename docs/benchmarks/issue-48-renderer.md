# Issue #48 renderer benchmark

This benchmark answers whether the existing Cesium point path is expensive
enough to require a project-owned renderer boundary. It does not claim that
browser timings are deterministic.

## Reproduction

```bash
npm ci
npm ci --prefix apps/viewer-web
npm run download-samples -- autzen
mkdir -p apps/viewer-web/public/samples
cp samples/local/autzen.copc.laz apps/viewer-web/public/samples/autzen.copc.laz
npm run benchmark:renderer --prefix apps/viewer-web
npm run test:e2e --prefix apps/viewer-web -- e2e/renderer-performance.spec.ts
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

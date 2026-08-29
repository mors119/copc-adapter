# Issue #68 streaming, memory, and backpressure validation

This is the post-scalability acceptance gate for the combined #45 cache, #46
Rust worker decode, #48 renderer boundary/instrumentation, and #59 rendered
point budget work. It is a measurement record, not a claim of universal frame
rate or browser memory usage.

## Reproduction

Prepare the representative local Autzen sample, then run:

```bash
npm ci
npm ci --prefix apps/viewer-web
npm run download-samples -- autzen
mkdir -p apps/viewer-web/public/samples
cp samples/local/autzen.copc.laz apps/viewer-web/public/samples/autzen.copc.laz
npm run benchmark:streaming --prefix apps/viewer-web
npm run benchmark:renderer --prefix apps/viewer-web
npm run test:e2e --prefix apps/viewer-web
npm run test:pack
```

`benchmark:streaming` is the repeatable issue-specific gate. It prints JSON
for the Far/Near/rotation/stale-work sequence, low/high budgets, and a forced
decoded-CPU-cache pressure run. The benchmark does not lower `maxNodes` to
hide workload; the Autzen scenario uses the documented representative
configuration below.

## Configuration and environment

The recorded run was made on 2026-08-30 with:

- Autzen classified COPC, 10,653,336 points, 81,123,042 bytes (about 77 MiB);
- `backend: 'rust'`, `colorMode: 'elevation'`, `pointSize: 2`;
- `maxNodes: 32`, `maxDepth: 6`, `maxScreenSpaceError: 8`;
- `maxRenderDistanceMeters: 20,000`, `maxRenderedPoints: 250,000`;
- macOS Darwin arm64, Node.js v26.7.0;
- Headless Chrome 151.0.0.0, 1280×720, device pixel ratio 1;
- Playwright Chromium WebGL forced to SwiftShader;
- `navigator.hardwareConcurrency: 8` and a four-worker Rust decode pool.

The sample is served locally with HTTP range responses. Timings therefore
include local server and browser scheduling behavior, not a representative
internet round trip.

## Far/Near and rotation evidence

The focused browser capture produced the following representative snapshots.
Values vary between runs; stage values are cumulative for the most recent
streaming update and are in milliseconds unless noted.

| transition | selected / rendered points | selected candidates | deferred nodes / points | range ms / bytes | decode | CRS | Cartesian | style | renderer preparation | update | max app blocking section | worker peak active / queue |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Far, 100 km | 0 / 0 | 0 | 0 / 0 | 0 / 0 | 0 | 0 | 0 | 0 | 0 | 0.1 | 0.1 | 1 / 1 |
| Near, 1 km | 6 / 242,601 | 1,470,043 | 26 / 1,227,442 | 1,179 / 518,475 | 19.3 | 60.2 | 7.9 | 3.1 | 23.5 | 1,171 | 48.9 | 3 / 1 |
| Far again, 100 km | 0 / 0 | 0 | 0 / 0 | 0 / 0 | 0 | 0 | 0 | 0 | 0 | 0.1 | 0.1 | 3 / 1 |
| Near again, 1 km | 6 / 242,601 | 1,470,043 | 26 / 1,227,442 | 0 / 0 | 0 | 0 | 0 | 0 | 0 | 0.2 | 0.2 | 3 / 1 |
| Rotate under load | 6 / 195,538 | 195,538 | 0 / 0 | 80 / 388,090 | 10.0 | 29.4 | 3.7 | 1.8 | 10.1 | 109 | 29.4 | 3 / 1 |

The near selection stayed below the 250,000 active rendered-point budget while
deferring 1,227,442 estimated points. The second near view reused retained
decoded data: no new range/decode/transform/render work was recorded for that
sample. Rotation changed the selected workload and remained budgeted.

The rapid replacement sequence (`near → far → near` without waiting between
camera commands) ended at 242,601 rendered points, with zero queued workers and
no error. This exercises generation checks and confirms that an obsolete
worker result does not create a late over-budget render burst.

The Long Task API observed a largest browser task of roughly 0.45 seconds in
the focused gate. Other concurrent browser tests observed up to about 1.0
second during startup and high-budget setup. These are browser observations,
not a deterministic main-thread guarantee. The measured application blocking
sections during the near and rotation updates were below 50 ms in the focused
capture.

## Budget scaling

The required low/high run used 100,000 and 500,000 rendered points:

| budget | sampled rendered / active points | candidate points | deferred nodes / points |
| ---: | ---: | ---: | ---: |
| 100,000 | 99,412 / 99,412 | 720,362 | 24 / 620,950 |
| 500,000 | 160,908 / 160,908 | 720,362 | 16 / 223,944 |

Both stayed bounded, and the higher budget admitted more useful detail. The
sample is taken after progressive work has become idle; it is not intended to
represent the final dataset point count.

## Cache pressure

The forced pressure run used `maxPointCacheBytes: 1,048,576` and retained the
250,000-point render budget. It recorded:

- current decoded CPU cache bytes: 387,408;
- cached nodes: 2;
- cache hits / misses: 11 / 12;
- evictions: 10;
- bytes evicted: 5,435,016;
- largest cached entry: 249,744 bytes.

These are project-owned typed-array byte estimates only. They are not exact
Cesium, WebGL, GPU, or total browser memory measurements. Active selected nodes
remain protected by the cache policy during eviction.

## Renderer attribution

The existing renderer benchmark remains separate from decode/cache claims. In
the same environment's Node benchmark, the 100,000-point median was roughly:

| CRS transform | Cartesian | style | collection create | collection add | renderer preparation |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 62.9 ms | 11.5 ms | 4.1 ms | 0.02 ms | 27.9 ms | 44.2 ms |

The renderer boundary remains backed by Cesium
`PointPrimitiveCollection`; no custom renderer or occlusion optimization is
claimed by this validation.

## Packed consumer

`npm run test:pack` passed both production consumer tests. The generated
package installed in a clean external Vite + Cesium app, built successfully,
loaded the package-local Rust worker/WASM assets, and preserved the
`copc-js` path. No worker/WASM 404s or monorepo-only paths were observed.

## Decision for #60

**NO / NOT YET — defer occlusion-culling investigation.**

The near run demonstrates meaningful frustum filtering (166 candidates before
culling, 40 frustum-culled), but this instrumentation cannot distinguish
in-frustum-and-occluded nodes from visible nodes. The measured workload is
already bounded and the dominant attributable costs are range scheduling and
CRS/point preparation, not evidence of a quantified hidden-node burden.
Proceeding to #60 would therefore add visibility complexity without a measured
occlusion-specific acceptance target. Re-run this gate with depth/occlusion
instrumentation if a future workload shows a material in-frustum hidden-node
share.

## Validation result

The gate passed:

- 150 unit tests and coverage;
- Rust workspace tests (10 tests);
- 8 real-browser E2E tests, including all issue-specific scenarios;
- renderer benchmark;
- production build;
- packed external Vite + Cesium consumer (2 tests).

The acceptance result is **performance-ready for the measured scope**, with
the documented caveat that browser/hardware timings are environment-specific
and no universal FPS or memory guarantee is made.

# COPC Adapter Dev Viewer

The Dev Viewer is an internal development workbench for visualizing, debugging,
and regression-testing `@frillab/copc-adapter`. It is separate from the public
Playground and is not a production consumer interface. It imports the workspace
package source and keeps development diagnostics and local Range middleware out
of the published package.

## Workbench

The full-window Cesium or Three.js canvas sits behind two independently
collapsible panels:

- **Controls** on the left groups source selection, rendering engine and backend,
  camera presets, appearance, streaming, and advanced settings.
- **Inspector** on the right groups current source status, the selected point,
  streaming metrics, source and hierarchy diagnostics, cache and Worker
  information, performance data, and advanced internal diagnostics. Detailed
  metrics use collapsible subsections and scroll within the panel.

Each panel has a keyboard-operable toggle that remains visible while collapsed.
The panels do not reserve space when closed. At narrow widths they become
viewport-sized drawers, with the canvas remaining full-window. The compact
version label reads the workspace adapter package version; it does not indicate
the version currently published to npm.

## Sources and configuration

Supported sources are the local Autzen fixture, public Autzen and Chicago URLs,
a custom HTTP/HTTPS URL, and a user-selected COPC File. Remote URLs load directly
from their host. Local Files use bounded Blob reads, so HTTP Range validation is
not applicable to them.

Selecting a different source and pressing **Load selected source** probes and
loads that source with the visible settings. The active source remains available
while the candidate is checked and loaded. Changes to settings that require a
new layer are staged until **Apply Settings** is pressed. These include the
rendering engine, backend, refinement algorithm, HTTP Range policy for remote
sources, Cesium point-renderer implementation, point size, and constructor-time
streaming limits. **Reload current source** explicitly rebuilds the current
source with the applied settings. Camera presets and Cesium color mode apply
live; camera distance is adjustable under Advanced settings.

Rendering engine and point renderer are separate choices. Cesium supports the
public PointPrimitive and Batched Geometry implementations; the point-renderer
choice is hidden when Three.js is active. The JavaScript and Rust/WASM backends
are available where supported by the selected renderer.

The **Refinement Algorithm** control selects `foveated` or `screen-projection`.
If omitted, the library default remains `foveated`. The algorithm is applied
when the layer is rebuilt and is shown in Inspector diagnostics alongside
selected and rendered nodes, points, and visible LoD levels.

The **HTTP Range Validation** control selects `head-fallback` or `strict` for
HTTP/HTTPS sources. A readable, valid `Content-Range` is validated strictly under
either policy. `head-fallback` uses limited compatibility checks only when
JavaScript cannot read `Content-Range` and a valid HEAD response is available;
the Inspector reports the actual probe validation level and warnings. HEAD
metadata is not cryptographic integrity verification. `strict` requires a
readable matching `Content-Range` and does not fall back to HEAD.

## Development and browser tests

From the repository root:

```bash
npm ci
npm ci --prefix packages
npm ci --prefix apps/dev-viewer
npm run download-samples -- autzen
npm run dev
```

`npm run dev` prepares the Rust/WASM decoder and laz-perf assets before starting
Vite. Download the local Autzen fixture once with the command above when it is
not already present. Public remote sources and custom URLs continue to load
directly from their original hosts.

Useful validation commands are:

```bash
npm --prefix apps/dev-viewer run typecheck
npm --prefix apps/dev-viewer run test:unit
npm --prefix apps/dev-viewer run build:ci
npm --prefix apps/dev-viewer run test:e2e
npm --prefix apps/dev-viewer run test:functional
```

## First-visible startup benchmark

The first-visible benchmark uses the downloaded Autzen fixture (81,123,042
bytes, SHA-256 `db2d56cdfa058bffccdc5d6019dae2fc9c6a551df10a5523c06c76a3e25a27fa`,
10,653,336 points). It records time from document initialization and from the
first COPC HTTP Range request. First visible means the first Cesium WebGL
`POINTS` draw; it also records the following `requestAnimationFrame` callback,
first camera heading/pitch change after a canvas pointer-down, and settled
quality after a one-step camera move. Quality requires all selected nodes for
that view to be committed and range/decode work and replacement transitions to
be idle for 300 ms.

The harness records header/VLR Range reads in the first 64 KiB, source open,
root hierarchy load/query, node selection, Range body bytes and concurrency,
LAZ decode, Rust point preparation, Rust/WASM fetch/compile/instantiate, worker
startup and utilization, coordinate conversion, Cesium buffer upload calls,
first draw/frame, camera response, and settled quality. It samples page JS heap
every 25 ms and sums RSS for Chromium processes reported by CDP every 250 ms.

Network conditions are emulated in Chromium at 40 ms round-trip latency, 50
Mbit/s download, and 10 Mbit/s upload. The COPC object is served by the local
Range middleware; these measurements include the emulated link but not public
Internet transit. Five cold BrowserContext runs use fresh browser caches. Five
warm runs reuse one context after one unreported warm-up. The operating
system's file cache and Chromium process are reused, so “cold” refers to the
browser context, not a cold machine. With five samples, the reported nearest
rank p95 is the maximum observed sample.

Build the optimized viewer with its benchmark-only debug hook, then run the
five cold and five warm samples:

```bash
npm run download-samples -- autzen
npm --prefix apps/dev-viewer run build:ci -- --mode benchmark
COPC_BENCHMARK_PRODUCTION=1 COPC_BENCHMARK_HARDWARE=1 COPC_FIRST_VISIBLE_BENCHMARK=1 npm --prefix apps/dev-viewer run benchmark:first-visible
```

The reference run used macOS 26.6.2, an Apple M2 with 8 GB RAM, system Google
Chrome 155.0.8059.82 in headless mode, ANGLE Metal, and a 1280 × 720 viewport.
The benchmark asserts cold and warm p95 first-point draw latency is at most four
seconds.

### Results after the WASM overlap change

Times are median / p95 across five runs. The camera gesture occurs after first
draw. “Page to draw” starts at the benchmark's document-init timestamp;
“Range to draw” starts at the first COPC Range request.

| Measurement | Cold | Warm |
| --- | ---: | ---: |
| Page to first point draw | 1,726 / 1,761 ms | 1,389 / 1,423 ms |
| First Range to first point draw | 997 / 1,002 ms | 864 / 877 ms |
| First Range to usable camera movement | 1,310 / 1,458 ms | 1,893 / 1,986 ms |
| Pointer-down to camera response | 141 / 160 ms | 576 / 699 ms |
| First Range to target quality | 1,800 / 1,960 ms | 2,264 / 2,455 ms |
| Range bytes at first point | 1,349,753 / 1,349,753 bytes | 1,349,753 / 1,349,753 bytes |
| Range bytes to target quality | 2,160,773 / 2,160,773 bytes | 3,613,793 / 3,613,793 bytes |
| Points at first draw | 37,032 / 37,032 | 37,032 / 37,032 |
| Selected target points after camera move | 195,538 / 195,538 | 233,383 / 233,383 |
| Worker utilization; peak active workers | 17.5 / 18.8%; 4 | 19.3 / 22.1%; 4 |
| Peak active Range requests | 4 / 4 | 4 / 4 |
| Peak page JS heap | 208.7 / 211.7 MB | 323.0 / 329.8 MB |
| Peak summed Chromium process RSS | 1.284 / 1.296 GB | 1.388 / 1.401 GB |
| Decoded point cache at target quality | 15.8 / 15.8 MB | 26.6 / 26.6 MB |

At first draw, the browser had issued four header/VLR-region Range reads totaling
3,847 bytes; their last body completed 235 / 244 ms after the first Range in
cold runs and 260 / 286 ms in warm runs. Root hierarchy load took 52 / 56 ms
cold and 53 / 58 ms warm. The first hierarchy query took 1.9 / 2.2 ms cold and
2.3 / 2.5 ms warm; node-selection work itself took 0.7 / 0.8 ms and 0.9 / 0.9
ms respectively.

The first visible node was selected 602 / 608 ms after the first Range in cold
runs and 432 / 483 ms in warm runs. Selection-to-draw took 395 / 399 ms cold
and 425 / 433 ms warm. LAZ decode took 33 / 37 ms cold and 38 / 43 ms warm;
Rust point preparation took 54 / 56 ms and 62 / 67 ms. World-to-Cartesian
preparation took 3.2 / 5.2 ms cold and 3.5 / 5.7 ms warm. Renderer preparation
took 26 / 29 ms cold and 27 / 30 ms warm.

The 850,370-byte Rust/WASM asset request started 234 / 245 ms after the first
Range cold and 260 / 286 ms after it warm. Its body completed in 274 / 278 ms
cold and 78 / 95 ms warm; compilation took 1.6 / 7.3 ms and 2.3 / 3.6 ms, and
instantiation took 0.7 / 0.7 ms and 0.8 / 1.0 ms. Decode workers became ready
in a per-run mean of 102 / 105 ms median/p95 cold and 113 / 136 ms warm; the
slowest worker took 251 / 270 ms cold and 299 / 333 ms.

Before first draw, GL `bufferData`/`bufferSubData` calls accounted for about
5.96 MB of uploads and 1.4 / 1.7 ms of synchronous WebGL API time cold, and
5.96 MB and 1.1 / 1.7 ms warm. Those totals include Cesium scene buffers and
are not isolated point-cloud buffer measurements. Range fetch duration is the
sum of overlapping request durations, not wall-clock critical-path time.

### Measured change

`RustCopcReader.open` previously fetched and parsed the complete metadata before
starting `loadCopcWasm()`. It now starts the shared WASM load after the 375-byte
LAS header passes layout validation and while the remaining header/VLR bytes
are fetched. The parser still awaits that same promise before parsing. The
public API and error result are unchanged.

| Metric | Cold before → after | Warm before → after |
| --- | ---: | ---: |
| Source open, median / p95 | 471 / 475 → 379 / 390 ms | 283 / 344 → 195 / 245 ms |
| WASM fetch start from first Range, median / p95 | 445 / 452 → 234 / 245 ms | 370 / 445 → 260 / 286 ms |
| First point draw from first Range, median / p95 | 1,199 / 1,215 → 997 / 1,002 ms | 1,051 / 1,088 → 864 / 877 ms |
| Range bytes at first draw | 1,349,753 → 1,349,753 bytes | 1,349,753 → 1,349,753 bytes |

The WASM request begins about 211 ms earlier cold and 110 ms earlier warm.
Source-open time fell by about 92 ms cold and 88 ms warm, while first draw fell
by about 202 ms and 187 ms. Aggregate Range duration rose about 13 ms in both
conditions as the asset transfer overlapped source reads. No node-selection,
decode, cache, buffer-copy, or cancellation tuning was added: first draw already
shows 37,032 points before all 195,538–233,383 selected target points are
committed, concurrency peaks at the existing four Range requests and four
workers, and hierarchy query, decode, preparation, and WebGL upload times are
small relative to the end-to-end startup. The existing stale-work gate still
passes, including one superseded Range cancellation and zero active requests at
settle.

### Measurement limits

The local Range server and emulated link do not measure public Internet transit.
An earlier run with 100 ms RSS polling had a 7.03-second cold first-draw outlier
and a 1.66-second main-thread long task plus a 1.76-second root-hierarchy wait;
it did not recur in the final runs with 250 ms RSS polling. Treat the
five-sample p95 as a reference result, not a population guarantee. Per-allocation
buffer timing is not exposed by the reader, so Rust allocation/preparation is
reported together with its duration, page heap, decoded cache, and GL upload
bytes. The WebGL `POINTS` call measures command submission, not compositor
presentation or GPU completion. Process RSS is the sum across browser-reported
Chromium processes; shared pages can be counted more than once, and this does
not include device-resident GPU memory. The page heap and decoded cache are
reported separately.

Playwright uses `debugPanel=0` (also `false` or `off`) to start with the Inspector
collapsed while leaving its toggle available. `renderer=public-batched` remains
supported for renderer benchmarks. Existing `source`, `backend`, refinement,
Range-policy, camera, and issue-scenario query parameters remain available for
browser regression cases.

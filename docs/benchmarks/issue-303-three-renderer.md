# Issue #303 Three.js renderer browser profile

This profile addresses [Issue #303](https://github.com/mors119/copc-adapter/issues/303)
and closes the measurement gap in the earlier [Issue #142 CPU renderer
observation](./issue-142-three-renderer.md). That Node benchmark does not create
a WebGL context and does not measure browser frame or GPU upload behavior.

The checked-in opt-in browser profile is
`apps/dev-viewer/e2e/three-renderer-performance-profile.spec.ts`.

## Reproduction

Prepare the repository's browser dependencies and local Autzen sample, then run
the profile against the host GPU:

```sh
npm run setup
COPC_BENCHMARK_HARDWARE=1 npm --prefix apps/dev-viewer run benchmark:three-renderer
```

Without `COPC_BENCHMARK_HARDWARE=1`, Playwright uses the configured SwiftShader
path. The JSON report is written outside the repository to
`os.tmpdir()/copc-adapter-validation/three-renderer-profile.json`. The test
records the browser's actual WebGL renderer string so software and hardware runs
can be distinguished.

The profile runs Rust / copc-js / copc-js / Rust, with two repetitions per
backend. It disables the browser HTTP cache for each run and uses the same
local same-origin Autzen file and five camera positions in each run:

| Pose | Camera position (dataset-local metres) |
| --- | --- |
| near | `(0, -350, 133)` |
| far | `(0, -5000, 1900)` |
| oblique east | `(1100, -900, 342)` |
| reverse west | `(-1100, -900, 342)` |
| near return | `(0, -350, 133)` |

Both backends use elevation styling, point size 2, a 250,000 rendered-point
budget, a 256 MiB decoded cache budget, at most 4 concurrent range requests, 32
nodes, depth 6, screen-space error 8 px, 20 km render distance, and motion
lookahead. The local sample is 81,123,042 bytes and declares 10,653,336 points.

For each pose, the report captures time to first useful points and settled
view, selected/rendered node and point counts, renderer preparation stages,
cache and typed-array bytes, `renderer.info`, frame interval p50/p95, Long Tasks,
WebGL buffer calls/bytes/CPU-call duration, HTTP Range traffic, and worker queue
peaks. Settled time includes three idle observations 250 ms apart. The run also
recorded that `EXT_disjoint_timer_query_webgl2` is available; a diagnostic query
around each buffer call returned 0 ms for all 240 calls, so it did not provide
a usable GPU transfer duration on this Metal driver.

## Baseline

Measured October 28, 2026 on baseline SHA
`3c420d453314f30263b95719181451c51fe80155`:

| Environment | Version / value |
| --- | --- |
| Package | `@frillab/copc-adapter` 0.6.0 |
| Three.js | 0.186.0 |
| Node / npm | 26.12.1 / 11.20.0 |
| OS / CPU | Darwin 25.6.0 / Apple M2 |
| Browser | Headless Chrome 156.0.8078.49 |
| WebGL | WebGL 2, ANGLE Metal Renderer: Apple M2 |
| Device pixel ratio / concurrency | 1 / 8 |

The path reached the same rendered point counts for both backends: 249,525 at
near, 219,951 at far, 240,303 oblique east, 214,678 reverse west, and 249,525
at near return. Each run fetched about 6.48 MB (Rust) or 6.54 MB (copc-js) in
HTTP 206 Range responses. The final near view held 9 point objects/materials;
the decoded point cache held 19.96 MB against the 256 MiB budget. Its live
position and color attributes were 2.99 MB each.

Two-run medians for the first near view and the five-pose path were:

| Measure | Rust | copc-js |
| --- | ---: | ---: |
| First useful points, initial near view | 236 ms | 518 ms |
| Settled initial near view | 1,075 ms | 1,536 ms |
| Settled time, median across five poses | 1,576 ms | 1,574 ms |
| Renderer preparation, cumulative across path | 154 ms | 152 ms |
| ECEF/world to local conversion stage, cumulative | 27.7 ms | 30.1 ms |
| Geometry creation stage, cumulative | 74.9 ms | 73.4 ms |
| Material creation stage, cumulative | 1.1 ms | 1.0 ms |
| Node removal stage, cumulative | 1.3 ms | 1.6 ms |
| Median per-pose frame interval p95 | 16.7 ms | 16.8 ms |
| Long Tasks per full run | 0–1 | 13–14 |

The Rust worker pool peaked at 4 active workers and 1 queued job. copc-js runs
reported Long Tasks up to 117 ms, concentrated in the near and far poses. The
renderer snapshot on the final pose reported 5 draw calls, 168,653 drawn
points, 6 live GPU geometries, 0 textures, and 1 program for both backends.

Across each five-pose run, the WebGL instrumentation observed either 60 buffer
calls / 21.96 MB or 54 calls / 19.54 MB for both backends. The measured
`bufferData` / `bufferSubData` CPU-call duration was at most 0.6 ms at the
per-pose p95. These are CPU-side submission timings and byte counts, not GPU
completion time or exact GPU memory. Frame intervals include browser and
compositor scheduling. Scripted camera poses do not measure interactive input
response.

The initial near-view response differs by backend, while later camera poses
reuse cached nodes and settle at similar times. The renderer's measured CPU work
is geometry creation and coordinate preparation; this run does not identify a
GPU upload bottleneck. The copc-js Long Tasks coincide with the near and far
poses, but this profile does not attribute their call stacks, so they cannot be
assigned to the decoder or renderer from these data alone.

## Candidate and decision gate

One small candidate for maintainer review is to write the final Float32 local
position attribute directly while transforming ECEF positions, retaining
double-precision arithmetic until each value is assigned. The current path
creates an intermediate Float64 local-coordinate array and then copies it into
Float32. At the 250,000-point cap, removing that intermediate would avoid about
5.7 MiB of temporary position storage per full view. The measured combined
world-to-local stage is 28–30 ms across the five-pose path; the copy's share is
not isolated, so elapsed-time improvement is not yet established.

The main risk is changing Float32 rounding, which could affect near-zoom
precision, bounds, or picking positions. If approved, compare an opt-in
prototype against this baseline in the same browser, dataset, backend, budgets,
and camera path with counterbalanced repeated runs. Require identical point and
node counts, visual/local-coordinate precision, and pick identity; compare
renderer stage times, transient bytes, frame p50/p95, and WebGL submission
proxies. Keep the baseline if timing gains do not exceed run variance.

No renderer optimization is adopted by this profile. Packed-consumer browser
render/pick/cleanup validation and precision checks are recorded in the
2026-11-01 follow-up below.

## 2026-11-01 profile and packed-consumer follow-up

### Hardware profile

The current profile was run from source revision `a504cafc281f94e0910498e8ff73c23bb5a4b4a5`
using the checked-in command above, `COPC_BENCHMARK_HARDWARE=1 npm --prefix
apps/dev-viewer run benchmark:three-renderer`. It used Node 26.12.1, Playwright
Headless Chrome 156.0.8078.74, macOS 25.6.0, Apple M2, WebGL 2 / ANGLE Metal
Renderer: Apple M2. The profile completed Rust / copc-js / copc-js / Rust, two
runs per backend, with the same Autzen input, five-pose camera path and budgets
listed above. Both backends rendered the same per-pose point counts:
249,525 / 219,951 / 240,303 / 214,678 / 249,525.

| Backend / run | Near first useful / settled | Renderer preparation, five poses | WebGL calls / submitted bytes | Long Tasks / maximum | Near frame p95 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Rust 1 | 147 / 942 ms | 142 ms | 54 / 19.54 MB | 0 / 0 ms | 16.7 ms |
| Rust 2 | 124 / 903 ms | 157 ms | 60 / 21.96 MB | 0 / 0 ms | 16.7 ms |
| copc-js 1 | 203 / 1,093 ms | 157 ms | 54 / 19.54 MB | 8 / 71 ms | 66.7 ms |
| copc-js 2 | 250 / 1,099 ms | 153 ms | 60 / 21.96 MB | 8 / 73 ms | 66.7 ms |

Across the five poses, per-call WebGL buffer submission CPU p95 was at most
0.7 ms. This is CPU time spent in the instrumented calls; it does not measure
GPU completion or exact GPU memory. Rust and copc-js had the same uploaded byte
counts within each repeat. Their different first-view frame and Long Task
results do not establish which call stacks caused the stalls. The final decoded
point cache was 19,963,936 bytes under the configured 256 MiB limit. The
renderer had 9 live point objects and no errors. These observations do not
identify a GPU upload bottleneck or isolate the copy share of world-to-local
conversion.

### Packed Three consumer

`npm run test:pack:three` built and installed the actual
`@frillab/copc-adapter@0.7.1` tarball in an isolated consumer with Three.js and
no Cesium dependency, then ran it in Chromium 156 with SwiftShader. The packed
Rust/E layer rendered 219,951 points across 7 nodes within the 250,000-point
budget. A real `THREE.Raycaster` pick returned node `1-1-0-0`, point index
7416, and a finite prepared height; E inspection correctly omitted unavailable
source coordinates. The consumer made 9 byte-range requests, all HTTP 206,
transferring 2,377,673 bytes. After layer destruction, rendered points were
zero while the application-owned scene object, material, renderer and canvas
remained intact; the WebGL context was not lost.

### Decision

**NEUTRAL / KEEP BASELINE.** This profile closes the browser measurement and
packed-consumer validation gaps. It does not compare an optimization candidate
against the baseline, and the available data do not isolate a CPU/GPU cost with
a demonstrated benefit. Keep the current renderer and defer the direct
Float32-write candidate until a controlled comparison can measure its copy
share and verify bounds, precision, and picking. No renderer behavior or
default changed in this follow-up.

### Validation

- `COPC_BENCHMARK_HARDWARE=1 npm --prefix apps/dev-viewer run benchmark:three-renderer` — passed, four profile runs.
- `npm run test:pack:three` — passed against the built tarball with render, real pick, ranged-source and ownership/cleanup assertions.
- `npm run test:pack` — passed; root-production, Cesium-production and Vite-dev packed-consumer modes each reported 13 passed and one pre-existing live-USGS test skipped.
- `git diff --check` — passed.

# Issues #324 and #326: ECEF cache layout measurement report

## Task 3 measurement run — 2026-10-23

### Recommendation

**DEFER default adoption; keep A as the production default.** E retains 32
coordinate bytes per point instead of A's 72, and the measured outputs preserve
height and color values. On one million synthetic points, that saves 55.6% of
coordinate storage and 49.4% of retained typed-array bytes after the same
attributes are included. Warm elevation styling is effectively tied with A.

Under the production 256 MiB / 48-entry replay, A and E had the same hits,
misses, and evictions because the entry limit bound first. A separate
byte-budget sensitivity trace shows E can retain more selected nodes and hit
more points on a revisit under a shared budget, but this remains a deterministic
hierarchy-bin proxy. The browser streaming run still uses A. The Rust/WASM
worker currently returns the full A coordinate result before the core
constructs E, so this run does not demonstrate lower worker transfer or
transient preparation memory for E. Those gaps prevent a safe default decision.

### Environment and method

| Setting | Value |
| --- | --- |
| Full measurement source revision | `e832bb653866964fac2984ece59d506893f5dd7c` (5 warm-ups, 15 samples) |
| Node benchmark harness SHA-256 (full measurement) | `cd38ce8add88b55c57f57c749ca0614f87826dc94a2beee082f8a48426a3d5f8` (`packages/scripts/cache-representation-performance-benchmark.mjs`) |
| Node harness SHA-256 (layout-specific metadata) | `7117b43670a93dbc7498153ebcc7e8be5bcb76e91cb82d7eade86eb853a63358` at `0c232496ab03689a6163d52608d5b95d84c2f502`; metadata smoke check used 0 warm-ups and 1 sample |
| Browser benchmark harness SHA-256 | `d85362ae194068d603ea29faeebfbd91d1a0ae456d0e05cfcb9ddd671e0585f0` (`apps/dev-viewer/src/rendererPerformanceBenchmark.ts`) |
| Node runtime | Node.js `v26.12.1`, V8 `14.6.202.34-node.40`, macOS `25.6.0`, arm64 |
| Machine | Apple M2, 8 logical CPUs, 8 GiB RAM |
| Rust/WASM | rustc `1.92.0`; COPC adapter WASM 850,535 bytes; laz-perf WASM 214,351 bytes |
| Node command | `COPC_CACHE_BENCHMARK_SOFI=1 npm --prefix packages run benchmark:cache-representations` |
| Node repetitions | 5 warm-ups, then 15 measured samples; p95 is nearest-rank; tables include SD and CV where useful |
| Requested data | Position, intensity, classification, RGB; SoFi has no RGB field |
| Transform | Same forward transform result per comparison; no height offset or geoid grid |
| Samples | Autzen: 81,123,042 bytes, SHA-256 `db2d56cdfa058bffccdc5d6019dae2fc9c6a551df10a5523c06c76a3e25a27fa`; SoFi: 2,029,696,615 bytes, SHA-256 `fd6848a0eaee3e21f7ce3a91af44ed3ae06ae8439b7f65828b4a5d956685f699` |
| Browser | Playwright Headless Chrome 155, DPR 1, 1280×720, 8 reported logical CPUs; Apple M2 host; hardware-GL mode requested; WebGL renderer query unavailable |
| Browser repetitions | Synthetic renderer comparison: 2 warm-ups and 5 measured runs; first-visible: 5 cold and 5 warm measured runs after one unreported warm-up |

The Node benchmark reuses PR #329's runner and report. A/B/D/E candidates use
the same transformed positions and requested attributes. D is only a research
baseline. Candidate materialization measures the copies or buffers retained
after transformation; it does not repeat the CRS transform. E is made by the
existing compact-E builder: its ECEF buffer aliases the transformed result and
it allocates one Float64 height per point. The CPU renderer benchmark is run in
the browser with synthetic 100k-point data. First-visible streaming is an A
baseline because no browser layer currently selects E. One-node cache timing
samples execute candidate layouts sequentially so their forced-GC and timing
windows do not overlap.

The full numeric measurements above used the `e832bb6` harness revision. A
follow-up metadata-only correction makes the JSON materialization and point
inspection method descriptions layout-specific. E records zero copied
coordinate buffers, a Float64 height allocation derived from Geographic Z,
aliases to the prepared ECEF buffer, and scalar ECEF inversion for
longitude/latitude with cached height. That output was smoke-checked at
`0c23249`; the change does not alter measured operations or the reported
full-run values.

For the cache-policy replay, the benchmark traverses each real hierarchy and
uses deterministic hierarchy-bin regions with a 24-node / 250k-point selection
proxy. The production-budget trace uses the 256 MiB budget and 48-entry limit.
A second trace visits regions 0 and 1, then revisits region 0; its per-dataset
byte budget is midway between the estimated A and E footprints for those two
regions, and its entry limit is raised to 256 to isolate byte pressure. Both
are policy simulations, not live camera/NodeSelector traces. Timing percentiles
with 15 samples are descriptive, not confidence intervals. Process snapshots
do not isolate allocation-time peaks, worker residency, or WASM linear memory.

### A/B/D/E storage comparison

Coordinate storage excludes requested attributes. Synthetic fixtures add 9
attribute bytes per point, shared across candidates and counted once.

| Layout | Coordinate bytes/point | Coordinate buffers |
| --- | ---: | --- |
| A | 72 | Source F64 + Geographic F64 + ECEF F64 |
| B | 48 | Geographic F64 + ECEF F64 |
| D | 28 | ECEF F64 + Height F32; research only |
| E | 32 | ECEF F64 + Height F64 |

| Synthetic points | A retained total | B retained total | D retained total | E retained total |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | 810,000 B | 570,000 B | 370,000 B | 410,000 B |
| 100,000 | 8,100,000 B | 5,700,000 B | 3,700,000 B | 4,100,000 B |
| 250,000 | 20,250,000 B | 14,250,000 B | 9,250,000 B | 10,250,000 B |
| 1,000,000 | 81,000,000 B | 57,000,000 B | 37,000,000 B | 41,000,000 B |

| Real root node | Points | A retained | B retained | D retained | E retained | E saving vs A |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Autzen | 61,201 | 4,957,281 B | 3,488,457 B | 2,264,437 B | 2,509,241 B | 49.4% |
| SoFi | 52,296 | 3,922,200 B | 2,667,096 B | 1,621,176 B | 1,830,360 B | 53.3% |

Totals count each retained ArrayBuffer backing store once, including the shared
attributes. A aliases such as `coordinates` to `geographic` add no bytes. E's
`ecef` aliases the transformed world buffer; E's Float64 height is a separate
8-byte-per-point allocation.

### Node timing measurements

The following one-million-point CPU RGBA pass timings are milliseconds. Each
row is `p50 / p95 / SD / CV`, with 15 measured samples. p95 uses nearest rank.

| Layout | Warm elevation styling | Five-mode style toggle cycle |
| --- | ---: | ---: |
| A | 41.042 / 42.625 / 0.776 / 0.019 | 157.774 / 166.976 / 3.471 / 0.022 |
| B | 41.885 / 60.554 / 5.256 / 0.120 | 163.290 / 270.963 / 28.632 / 0.166 |
| D | 38.973 / 41.498 / 0.735 / 0.019 | 153.712 / 164.284 / 3.264 / 0.021 |
| E | 39.465 / 41.382 / 0.741 / 0.019 | 154.466 / 159.402 / 2.311 / 0.015 |

E is 3.8% faster than A at warm elevation p50 in this run; p95 was 41.382 ms
for E and 42.625 ms for A. The five-mode cycle p50 differs by 2.1%. These
CPU-only differences do not establish a material end-to-end speedup.

| Operation, 1M points | A p50 / p95 | E p50 / p95 | Notes |
| --- | ---: | ---: | --- |
| Representation materialization | 3.740 / 4.889 ms | 1.107 / 1.465 ms | A copies three coordinate arrays; E aliases ECEF and copies height |
| Production LRU one-node load + accounting | 0.063 / 0.128 ms | 0.052 / 0.138 ms | Already-materialized node; includes byte estimation and diagnostics, excludes decode/transform/allocation |

The one-node cache insertion values are milliseconds, p50 / p95, n=15. Their
standard deviation / CV were A 0.021 / 0.297 and E 0.026 / 0.420; this very
short operation is noisy and shows no reliable insertion-time advantage. The
1M materialization standard deviation / CV were A 0.429 ms / 0.109 and E
0.102 ms / 0.088.

Root materialization timings vary by backend; values below are p50 / p95 ms,
n=15. They do not support a stable cross-dataset speed claim:

| Dataset / backend | A | E |
| --- | ---: | ---: |
| Autzen / copc-js + TypeScript | 0.248 / 0.515 | 1.879 / 2.372 |
| Autzen / Rust/WASM | 0.252 / 1.576 | 0.131 / 2.210 |
| SoFi / copc-js + TypeScript | 0.210 / 0.657 | 0.096 / 0.198 |
| SoFi / Rust/WASM | 0.211 / 0.506 | 0.085 / 0.097 |

The existing direct-backend warm preparation measurement, which includes
opening/reusing the source node and producing the A-shaped prepared result, was:

| Dataset / backend | Total load + prepare p50 / p95 | Point preparation p50 / p95 |
| --- | ---: | ---: |
| Autzen / copc-js + TypeScript | 97.137 / 104.586 ms | 49.283 / 52.846 ms |
| Autzen / Rust/WASM | 81.700 / 100.571 ms | 50.600 / 60.625 ms |
| SoFi / copc-js + TypeScript | 71.343 / 78.910 ms | 32.338 / 39.077 ms |
| SoFi / Rust/WASM | 33.800 / 35.164 ms | 14.462 / 15.566 ms |

Those transformation timings are shared inputs, not E-only worker preparation
timings. E's measured height allocation adds 8,000,000 ArrayBuffer bytes per
one-million-point materialization; the source and Geographic buffers from the
input PreparedPointData are present until the compact entry is built and the
input becomes collectible. The benchmark records stage-boundary memory
snapshots, not a per-layout allocation-time peak. Forced GC runs before timed
operations, so GC pause cost is excluded from the operation timing.

### Accuracy, color, and backend parity

Across all candidates, the requested attribute arrays are shared unchanged.
E height equalled prepared Geographic height exactly for both backends, both
real root nodes, all four synthetic sizes, and all six coordinate fixtures.
The 11-point geographic fixture includes negative heights, near-pole points,
the international date line, and heights through 42,000,001.25 m. E's maximum
ECEF round-trip error in that fixture was 0.93 nm; its root-node maximum was
3.42 nm for SoFi. These are software consistency checks, not surveyed accuracy.

E matched A's Float32 RGBA output exactly for fixed, elevation, RGB, intensity,
and classification styling: zero float-channel delta and zero 8-bit color
mismatches on both real roots and all synthetic sizes. Engineered palette
checks at normalized boundaries 0.25, 0.50, and 0.75 across 10 m, 100 m, and
1000 m spans also had zero E mismatches. D had 40,000–40,750 8-bit channel
mismatches in the 100k-point samples exactly at the 0.75 boundary; D remains a
research baseline and is not proposed for production.

Rust/WASM and JavaScript preparation had identical requested attributes. The
largest ECEF component difference between backends was 4.66 nm on both files;
the largest geographic component difference was below `3.6e-14` degrees. E
does not change this backend parity result because it carries the buffers from
the same prepared transform result.

### Cache budget and reuse

| Dataset / layout | Current bytes after replay | Cached nodes | Hits / misses / evictions | Bound by 48-node limit? |
| --- | ---: | ---: | ---: | --- |
| Autzen A | 108,612,738 | 48 | 8 / 54 / 6 | Yes |
| Autzen E | 54,976,818 | 48 | 8 / 54 / 6 | Yes |
| SoFi A | 28,503,900 | 48 | 0 / 160 / 112 | Yes |
| SoFi E | 13,301,820 | 48 | 0 / 160 / 112 | Yes |

All layouts stayed below the 256 MiB byte budget. In this production-policy
trace, the 48-entry cap bound first and A/E had identical reuse. The separate
byte-bound sensitivity trace used a shared budget between the estimated A and
E size for two visited regions, then revisited the first region:

| Dataset | Shared byte budget | Layout | Revisit hits | Final nodes | Final retained bytes | Total hits / misses / evictions |
| --- | ---: | --- | ---: | ---: | ---: | ---: |
| Autzen | 30,336,520 B | A | 5 | 20 | 30,097,899 B | 5 / 30 / 10 |
| Autzen | 30,336,520 B | E | 11 | 24 | 20,390,120 B | 11 / 24 / 0 |
| SoFi | 20,302,865 B | A | 2 | 36 | 18,230,850 B | 2 / 70 / 34 |
| SoFi | 20,302,865 B | E | 24 | 48 | 12,920,005 B | 24 / 48 / 0 |

This sensitivity case demonstrates that E's smaller buffers can increase
revisit hits under a byte-bound policy trace. It is not evidence of universal
camera-cache improvement because the trace is synthetic and uses selected
hierarchy bins rather than production camera/NodeSelector behavior.

### Browser measurements

The browser synthetic comparison used five measured runs after two warm-ups;
`median` is p50 and `max` is the empirical nearest-rank p95 for n=5. These are
synchronous CPU preparation timings. The renderer creates objects and buffers
but does not keep them alive for a GPU draw, so this comparison has no frame,
upload, or GPU-memory result.

| Renderer, 100k points | Layout | Representation materialization p50 / max | Renderer preparation p50 / max | Main conversion or style p50 / max |
| --- | --- | ---: | ---: | ---: |
| Cesium point primitive | A | 0 / 0 ms | 25.2 / 28.1 ms | ECEF-to-Cartesian 2.4 / 3.6 ms; style 4.4 / 6.5 ms |
| Cesium point primitive | E | 0.3 / 0.6 ms | 22.5 / 26.1 ms | ECEF-to-Cartesian 2.0 / 2.7 ms; style 4.3 / 6.6 ms |
| Cesium batched geometry | A | 0 / 0 ms | 3.1 / 3.6 ms | ECEF-to-Cartesian 0.9 / 1.0 ms; style 2.0 / 2.4 ms |
| Cesium batched geometry | E | 0.1 / 0.3 ms | 3.4 / 3.9 ms | ECEF-to-Cartesian 0.9 / 0.9 ms; style 2.3 / 2.7 ms |
| Three.js geometry preparation | A | 0 / 0 ms | 6.9 / 7.0 ms | World-to-local 1.0 / 1.0 ms; geometry 3.5 / 3.7 ms |
| Three.js geometry preparation | E | 0.1 / 0.3 ms | 6.8 / 7.3 ms | World-to-local 0.9 / 1.0 ms; geometry 3.6 / 3.9 ms |

The independent first-visible hardware run uses the existing A streaming layer,
Rust/WASM workers, and Autzen. It is a baseline, not an A/E comparison. Browser
conditions were 40 ms RTT, 50 Mbit/s download, 10 Mbit/s upload, local HTTP 206
Range responses, five cold runs, and five warm reloads after one unreported
warm-up.

The Three.js A/E sample order was counterbalanced per repetition as A→E, E→A,
then alternating for all seven warm-up and measured pairs. Its updated results
are effectively tied; the earlier all-A-then-all-E timing order is superseded.

| A browser first-visible metric | Cold p50 / p95 | Warm p50 / p95 |
| --- | ---: | ---: |
| First point draw from first Range | 943.5 / 981.3 ms | 703.7 / 719.8 ms |
| Target quality | 1,657.2 / 2,172.7 ms | 1,464.3 / 1,938.3 ms |
| Range bytes to first point | 1,349,753 / 1,349,753 B | 1,349,753 / 1,349,753 B |
| Range bytes / requests to target quality (p50 / p95) | 2,160,773 / 3,613,793 B; 11 / 16 | 2,160,773 / 3,613,793 B; 11 / 16 |
| Sampled steady-frame p95 | 16.7 / 16.7 ms | 16.7 / 16.8 ms |
| Long-task count p50 / p95; duration-p95 p50 / p95 across runs | 0 / 1; 0 / 55 ms | 0 / 0; 0 / 0 ms |
| Peak page JS heap p50 / p95 | 213,736,925 / 339,993,440 B | 216,506,357 / 337,990,840 B |
| Peak Chromium process RSS p50 / p95 | 1,301,561,344 / 1,363,410,944 B | 1,266,728,960 / 1,350,025,216 B |
| Decoded point-cache bytes p50 / p95 | 15,838,578 / 26,633,205 B | 15,838,578 / 26,633,205 B |
| GL upload bytes before first draw p50 / p95 | 5,956,948 / 5,956,996 B | 5,956,276 / 6,051,288 B |
| GL upload API time p50 / p95 | 1.0 / 1.4 ms | 0.9 / 1.6 ms |

Across five measured runs in each group, worker transfer instrumentation
observed the following total unique buffer bytes. `postMessage` timing is the
synchronous call only; it excludes worker execution and response delivery.

| Direction / message | Cold events / bytes | Warm events / bytes | postMessage p95, cold / warm |
| --- | ---: | ---: | ---: |
| Main → worker initialization | 20 / 17,045,420 B | 20 / 17,045,420 B | 0.1 / 0.2 ms |
| Main → worker prepare | 35 / 12,193,170 B | 40 / 13,646,190 B | 0.1 / 0.1 ms |
| Worker → main result | 35 / 89,987,517 B | 40 / 100,782,144 B | n/a |

These A-path result transfers carry Source, Geographic, ECEF, and requested
attribute buffers. No browser E worker transfer, E first-visible timing,
streaming revisit, LAZ re-decode count, or E GPU upload measurement is
available from this run.

### Compatibility risks and remaining evidence

- The production default remains A and public synchronous
  `PreparedPointData`, Source, and Geographic getters remain unchanged.
- E has no complete synchronous Source-coordinate contract unless Source is
  explicitly retained; this benchmark did not inverse-transform ECEF to invent
  Source coordinates.
- Current Rust/WASM worker results are A-shaped. Compacting in the core can
  lower retained LRU bytes, but does not lower the existing worker response
  transfer. A future performance decision needs E emitted from preparation and
  a matched A/E browser streaming run.
- Browser E results cover synthetic renderer preparation only. Real camera
  paths, cache residency/reuse, browser heap, GPU upload, and renderer cleanup
  have not been measured for E.
- Node memory sampling does not isolate transient peaks or GC pauses; no
  remote Range latency was measured. The LRU camera-region sequence is a
  deterministic policy proxy, not actual view selection.

The smallest safe next performance step is to preserve A as the default and
add a browser-only internal selection that exercises E from the worker result
through streaming, picking, and renderer lifecycle while retaining A for exact
synchronous legacy coordinate getters. Re-run cold/warm camera paths and
transfer accounting before considering any default switch.

### Task 3 validation

- `npm --prefix packages run typecheck` and `npm --prefix apps/dev-viewer run typecheck` passed.
- `npm --prefix packages run test:raw -- --skip-integration`: 532 passed, 0 failed, 5 skipped.
- Focused Rust/JavaScript backend conformance test: 10 passed, 0 failed.
- Dev-viewer production build and production-mode benchmark build passed.
- Synthetic Cesium/Three A/E renderer benchmark: 1 browser test passed with counterbalanced Three A/E order; A-only first-visible benchmark: 1 browser test passed (5 cold + 5 warm measured runs).
- Final Node benchmark rerun passed with sequential cache-timing samples and the added byte-bound sensitivity replay.
- `npm run test:pack` passed its packed root and Cesium consumer suites; `npm run test:pack:three` passed the packed Three consumer build.
- Rust/WASM release builds completed through the package build and packed-consumer workflows.
- Raw benchmark JSON was captured in temporary local output and is not added as a new artifact. The committed existing report records the environment, sample counts, p50/p95 and variability; rerunning the existing script prints the machine-readable samples.
- `git diff --check` passed.

## PR #329 historical comparison recommendation

### Historical recommendation

**Keep layout A as the default and defer a default cache change.** The local
Node results show a real memory reduction for every alternative, but the
trade-offs are not yet sufficient to change the default. At one million
synthetic points, B retains 24 MB fewer coordinate bytes than A (33.3% less)
and its warm elevation pass is 5.7% faster at p50; C retains 48 MB fewer
coordinate bytes but its warm elevation pass is 6.17× slower at p50; D retains
44 MB fewer coordinate bytes and has the fastest color pass, but its Float32
height has no product acceptance threshold and produces large errors at
extreme heights and engineered palette boundaries. The browser run is an A-only
baseline, not a four-layout comparison under a shared LRU byte budget. No
public `PreparedPointData` contract, default cache layout, or renderer behavior
is changed here.

Use the B memory result to inform #326's separate evaluation of internal cache
storage and public source-coordinate access. Do not treat this report as
approval to remove source coordinates from the public API or to adopt C/D.

| Candidate | 1M coordinate buffers | 1M retained ArrayBuffers, including attributes | Warm elevation p50 / p95 | Direction |
| --- | ---: | ---: | ---: | --- |
| A | 72 MB | 81 MB | 45.249 / 64.857 ms | Keep as production default |
| B | 48 MB | 57 MB | 42.671 / 45.091 ms | Evaluate separately; exact source XYZ requires re-read |
| C | 24 MB | 33 MB | 279.013 / 319.553 ms | Defer; inverse styling cost is too high |
| D | 28 MB | 37 MB | 41.828 / 46.312 ms | Defer until height and palette accuracy has an approved threshold |

## PR #329 historical reproducibility

The benchmark used five warm-ups followed by 15 measured runs per operation.
All reported p95 values use nearest-rank percentiles; timing tables show the
sample count, median, p95, and, for the main synthetic timings, the observed
range, mean, standard deviation, and coefficient of variation. With only 15
samples, p95 is descriptive rather than a confidence interval; it is often the
maximum observation. Per-run machine-readable Node samples are not included in
this PR, so the report carries the aggregate evidence and its limitations.

| Setting | Value |
| --- | --- |
| Source revision | `a212486ccd7df4f275fb95539f6514d5dcb0b800`; branch `mors119/perf-p2-4-ecef`; worktree dirty during measurement |
| Node command | `COPC_CACHE_BENCHMARK_SOFI=1 npm run benchmark:cache-representations --prefix packages` |
| Benchmark harness minimum | Node.js 22+; requires `fs.openAsBlob` to avoid buffering the full COPC input |
| Node script SHA-256 | `1c4f8a781e2cede2667e36b12b59bf6d72bfb8f8a615e1cbfb18ab3b92e87870` for the measured run at `4e80198`; `d00be7472ec7831e95bfc199d842d0187d77e1bafc50370b592f1728e2ffec07` for corrected stage reporting at `64c5341`; `17a2205fa24e7c894b0220f4b6d824746d99fd64cc0bf81379bec058e816e194` for the current file-backed benchmark at `8b8321e` |
| Runtime / machine | Node 26.7.0, V8 14.6, macOS 25.6 arm64, Apple M2, 8 logical CPUs, 8 GiB RAM |
| Rust / WASM | rustc 1.92.0; copc-adapter WASM 850,535 bytes (SHA-256 `4122c633138bc5907da054f43482d1ed2277b2035de7c37337ca23b5b3c44251`); laz-perf WASM 214,351 bytes (SHA-256 `9c1802bc31b567dd4aa1ce9ab010e7e51e095dc42af8379b474ae6f221a9327f`) |
| Runtime packages | copc 0.0.9; proj4 2.22.0; TypeScript 7.0.2; tsx 4.23.15; laz-perf 0.0.7 |
| Repetitions | 5 warm-ups and 15 measured samples; summaries include p50, nearest-rank p95, min/max, mean, variance, standard deviation, and coefficient of variation |
| Synthetic counts | 10k, 100k, 250k, 1M; 1M is benchmark-only and exceeds typical production point budgets |
| Requested attributes | Position, intensity, classification, RGB; SoFi has no RGB dimension |
| Real source mode | Local file-backed Blob; one root node per source; no HTTP or browser Worker timings in the Node run |
| Transform settings | No geoid grid and no manual height offset |

Autzen was 81,123,042 bytes, SHA-256
`db2d56cdfa058bffccdc5d6019dae2fc9c6a551df10a5523c06c76a3e25a27fa`, with
61,201 points in the measured root. SoFi was 2,029,696,615 bytes, SHA-256
`fd6848a0eaee3e21f7ce3a91af44ed3ae06ae8439b7f65828b4a5d956685f699`, with
52,296 points in the measured root. The SoFi file size is not the amount
decoded or retained by this one-root comparison.

The candidates share the same completed coordinate transformation, point
identities, attributes, and statistics. Representation materialization copies
the selected buffers; it does not repeat CRS transforms. Memory figures count
retained ArrayBuffer backing stores and deduplicate aliases/shared stores.
JavaScript object overhead is engine-specific. Transient allocation peak,
isolated Worker memory, and WASM linear memory are not measurable by this Node
harness and are reported as unavailable in this measurement.

The JS/TypeScript and Rust/WASM paths were explicitly selected and measured
separately against the same local root node and requested fields. The Node
runner does not invoke browser Workers, does not instantiate the production
streaming LRU, and does not impose a cache byte or node budget. Each timing is
an operation-level stopwatch, not a process-wide total. The source revision was
`a212486ccd7df4f275fb95539f6514d5dcb0b800`; the worktree was dirty only for the
listed benchmark implementation, production inverse/cache accounting changes,
and regression tests. The Stage summaries were corrected to exclude the five
warm-ups; every listed stage sample count below is 15.

## PR #329 historical Node measurements

### Synthetic sizes and timings

All synthetic points use deterministic WGS84 outputs around Autzen. Attribute
backing stores are shared across candidates and account for 9 bytes per point.
The following totals count each retained ArrayBuffer once; coordinate bytes
alone are 72 / 48 / 24 / 28 bytes per point for A / B / C / D.

| Points | Attributes | A retained total | B retained total | C retained total | D retained total |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 10,000 | 90,000 | 810,000 | 570,000 | 330,000 | 370,000 |
| 100,000 | 900,000 | 8,100,000 | 5,700,000 | 3,300,000 | 3,700,000 |
| 250,000 | 2,250,000 | 20,250,000 | 14,250,000 | 8,250,000 | 9,250,000 |
| 1,000,000 | 9,000,000 | 81,000,000 | 57,000,000 | 33,000,000 | 37,000,000 |

Each cell below is `p50 / p95` milliseconds (`n=15`). Materialization copies
already-computed transformed buffers into each candidate; it does not include
CRS transformation time. Elevation styling builds a CPU Float32 RGBA buffer;
the warm path reuses its output buffer.

| Points | A materialize | B materialize | C materialize | D materialize |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | 0.053 / 0.169 | 0.042 / 0.089 | 0.024 / 0.037 | 0.042 / 0.279 |
| 100,000 | 0.356 / 1.241 | 0.213 / 0.647 | 0.121 / 0.347 | 0.247 / 1.768 |
| 250,000 | 2.422 / 5.692 | 0.738 / 6.063 | 0.343 / 12.637 | 1.167 / 5.193 |
| 1,000,000 | 10.222 / 275.705 | 5.403 / 32.650 | 1.429 / 5.682 | 3.493 / 12.884 |

| Points | A warm elevation | B warm elevation | C warm elevation | D warm elevation |
| ---: | ---: | ---: | ---: | ---: |
| 10,000 | 0.490 / 1.439 | 0.321 / 0.686 | 2.456 / 6.840 | 0.289 / 0.792 |
| 100,000 | 4.074 / 8.008 | 4.418 / 9.773 | 31.462 / 77.831 | 5.209 / 17.997 |
| 250,000 | 18.140 / 27.237 | 17.016 / 26.960 | 96.030 / 145.442 | 14.574 / 26.212 |
| 1,000,000 | 45.249 / 64.857 | 42.671 / 45.091 | 279.013 / 319.553 | 41.828 / 46.312 |

The 1M-point materialization distribution shows substantial timing noise for
copy-heavy operations. Values are `p50 / p95 / min / max / mean / SD / CV`, in
milliseconds except CV (unitless):

| Layout | p50 | p95 | Min | Max | Mean | SD | CV |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A materialization | 10.222 | 275.705 | 4.433 | 275.705 | 37.228 | 69.924 | 1.878 |
| B materialization | 5.403 | 32.650 | 3.147 | 32.650 | 8.720 | 8.910 | 1.022 |
| C materialization | 1.429 | 5.682 | 1.169 | 5.682 | 1.860 | 1.205 | 0.648 |
| D materialization | 3.493 | 12.884 | 3.130 | 12.884 | 4.141 | 2.430 | 0.587 |

For example, A had a 10.222 ms median but a 275.705 ms maximum. These copies
are measured after the input transformation is complete; the outlier does not
represent a repeatable CRS or renderer cost. The empirical p95 is the maximum
for these 15 samples.

### One million synthetic points

Decimal bytes. The attribute arrays are 9,000,000 bytes for every candidate;
the retained total includes those arrays. Object/scalar overhead is excluded.

| Layout | Retained coordinates / height | Attributes | Retained ArrayBuffers total |
| --- | ---: | ---: | ---: |
| A: Source F64 + Geographic F64 + ECEF F64 | 72,000,000 | 9,000,000 | 81,000,000 |
| B: Geographic F64 + ECEF F64 | 48,000,000 | 9,000,000 | 57,000,000 |
| C: ECEF F64 | 24,000,000 | 9,000,000 | 33,000,000 |
| D: ECEF F64 + height F32 | 28,000,000 | 9,000,000 | 37,000,000 |

The process-level memory checkpoint taken while retaining all four 1M-point
candidate representations is below. It is a combined live-set snapshot after
GC, not a per-candidate peak. RSS is resident process memory; `external` and
`arrayBuffers` are Node's process counters.

| Metric | Before candidate representations | After all four + GC | Delta |
| --- | ---: | ---: | ---: |
| RSS | 229,867,520 | 356,073,472 | +126,205,952 |
| Heap used | 69,972,136 | 55,431,080 | -14,541,056 |
| External | 90,065,462 | 290,065,462 | +200,000,000 |
| ArrayBuffers | 86,919,036 | 286,919,036 | +200,000,000 |

The process high-water RSS at that checkpoint was 356,073,472 bytes; the
high-water RSS across the complete Node run was 389,152,768 bytes. These
figures include runtime and shared benchmark state. The harness does not sample
each allocation, so it cannot attribute transient peak memory to a single
candidate. It also cannot isolate Worker residency or WASM linear memory.
The typed attribute backing stores total 9,000,000 bytes at one million points;
typed-array statistics backing stores were zero in this fixture. JavaScript
object/string/number overhead is not represented by these byte totals.

The following CPU RGBA color-buffer construction timings are in milliseconds.
“Cold” means a fresh output buffer for the measured pass, not a fresh Node
process; “warm” reuses its output buffer while repeating the elevation style.
These are Node microbenchmarks, not renderer frame times. Values are `p50 /
p95 / min / max / mean / SD / CV`, with `n=15` for every row.

| Layout / pass | p50 | p95 | Min | Max | Mean | SD | CV |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| A cold | 42.523 | 55.438 | 39.844 | 55.438 | 44.060 | 4.300 | 0.098 |
| A warm | 45.249 | 64.857 | 42.617 | 64.857 | 47.807 | 6.573 | 0.137 |
| B cold | 42.808 | 124.489 | 41.793 | 124.489 | 48.681 | 21.019 | 0.432 |
| B warm | 42.671 | 45.091 | 39.658 | 45.091 | 42.751 | 1.257 | 0.029 |
| C cold | 289.832 | 416.829 | 275.365 | 416.829 | 306.601 | 39.367 | 0.128 |
| C warm | 279.013 | 319.553 | 264.657 | 319.553 | 282.173 | 14.579 | 0.052 |
| D cold | 41.811 | 67.301 | 39.125 | 67.301 | 44.500 | 7.577 | 0.170 |
| D warm | 41.828 | 46.312 | 39.552 | 46.312 | 41.990 | 1.540 | 0.037 |

The five-mode fixed/RGB/elevation/intensity/classification toggle cycle had
`p50 / p95` times of A 199.033 / 395.003 ms, B 190.199 / 204.413 ms, C
415.021 / 479.217 ms, and D 185.579 / 200.451 ms. A full elevation change
requires 0 / 0 / 1,000,000 / 0 inverse transforms for A / B / C / D;
non-elevation styles require no inverse transforms. The mode outputs matched
the A reference for fixed, RGB, intensity, and classification; the measured
palette sensitivity for D is reported below.

For the same million points, the batch ECEF-to-geographic conversion used by C
included input-length validation and a finite-value scan. The output buffer is
24,000,000 bytes. Values below are milliseconds (`p50 / p95 / min / max / mean
/ SD`, `n=15`):

| Output | p50 | p95 | Min | Max | Mean | SD |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Allocate output | 264.431 | 342.108 | 249.180 | 342.108 | 273.907 | 24.649 |
| Reuse caller output | 253.566 | 305.514 | 243.220 | 305.514 | 262.801 | 19.845 |

This cost explains the repeated elevation-style penalty for C; RGB, intensity,
and classification styling do not need the inverse transform.

### Real root nodes

| Source | A coordinates | B coordinates | C coordinates | D coordinates | A retained total | B retained total | C retained total | D retained total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Autzen, 61,201 points | 4,406,472 | 2,937,648 | 1,468,824 | 1,713,628 | 4,957,281 | 3,488,457 | 2,019,633 | 2,264,437 |
| SoFi, 52,296 points | 3,765,312 | 2,510,208 | 1,255,104 | 1,464,288 | 3,922,200 | 2,667,096 | 1,411,992 | 1,621,176 |

Bytes are decimal, and totals include requested typed attribute arrays. A's
`coordinates`, `sourceCoordinates`, and `worldCoordinates` aliases add no
backing-store bytes. The following operation timings are `p50 / p95`
milliseconds (`n=15`). JS/TypeScript and Rust/WASM are independent direct
backend runs; Rust/WASM here is not executed in a browser Worker.

Fresh open-path timings include local source open, hierarchy access, root
decode, and candidate A point preparation. The stage table shows the measured
range fetch, decode, and combined point-preparation stopwatches. CRS transform,
geoid interpolation, ECEF creation, and statistics are inside point preparation
and were not timed as separate sub-stages. All values are `p50 / p95` ms
(`n=15`):

| Source / backend | Open + hierarchy + decode + prepare | Range fetch | Decode | Point preparation |
| --- | ---: | ---: | ---: | ---: |
| Autzen / copc-js + TypeScript | 107.075 / 121.993 | 0.365 / 0.553 | 41.757 / 51.231 | 53.465 / 61.016 |
| Autzen / Rust/WASM | 80.317 / 86.446 | 0.320 / 0.826 | 24.961 / 28.869 | 49.977 / 53.165 |
| SoFi / copc-js + TypeScript | 80.985 / 87.505 | 0.377 / 1.031 | 33.449 / 35.683 | 34.251 / 37.017 |
| SoFi / Rust/WASM | 37.497 / 39.581 | 0.305 / 0.694 | 15.885 / 17.498 | 14.944 / 15.643 |

On an already-open backend, total load-and-preparation p50/p95 was 101.188 /
108.850 ms for Autzen TypeScript, 82.662 / 283.191 ms for Autzen Rust/WASM,
85.023 / 133.849 ms for SoFi TypeScript, and 37.482 / 144.280 ms for SoFi
Rust/WASM. The high p95 values reflect individual outliers across 15 runs;
reusing an open backend did not make every sample faster. The exact-source
re-read path is a separate operation and is summarized below.

| Source / backend | A materialize | B materialize | C materialize | D materialize |
| --- | ---: | ---: | ---: | ---: |
| Autzen / copc-js + TypeScript | 0.249 / 0.529 | 0.171 / 0.330 | 0.096 / 0.172 | 0.193 / 0.674 |
| Autzen / Rust/WASM | 0.245 / 0.751 | 0.160 / 0.192 | 0.089 / 0.159 | 0.240 / 0.342 |
| SoFi / copc-js + TypeScript | 0.224 / 2.580 | 0.140 / 0.264 | 0.077 / 0.789 | 0.149 / 0.224 |
| SoFi / Rust/WASM | 0.217 / 0.469 | 0.151 / 0.395 | 0.083 / 0.255 | 0.146 / 0.339 |

| Source / backend | A cold elevation | B cold elevation | C cold elevation | D cold elevation |
| --- | ---: | ---: | ---: | ---: |
| Autzen / copc-js + TypeScript | 1.598 / 2.163 | 1.653 / 3.878 | 14.001 / 14.817 | 1.644 / 2.539 |
| Autzen / Rust/WASM | 2.380 / 37.617 | 2.268 / 5.628 | 15.777 / 95.875 | 2.007 / 28.892 |
| SoFi / copc-js + TypeScript | 1.645 / 9.028 | 1.673 / 2.484 | 12.861 / 76.784 | 1.662 / 3.167 |
| SoFi / Rust/WASM | 1.689 / 2.113 | 1.730 / 2.794 | 13.366 / 15.040 | 1.653 / 3.762 |

| Source / backend | A warm elevation | B warm elevation | C warm elevation | D warm elevation |
| --- | ---: | ---: | ---: | ---: |
| Autzen / copc-js + TypeScript | 1.781 / 2.268 | 1.719 / 2.226 | 13.833 / 14.599 | 1.712 / 1.870 |
| Autzen / Rust/WASM | 2.029 / 5.725 | 2.067 / 8.621 | 16.556 / 61.805 | 1.940 / 2.280 |
| SoFi / copc-js + TypeScript | 1.687 / 3.590 | 1.704 / 3.665 | 12.633 / 14.264 | 1.634 / 2.467 |
| SoFi / Rust/WASM | 1.729 / 2.170 | 1.684 / 1.936 | 12.350 / 14.598 | 1.574 / 1.932 |

The JS/TypeScript and explicit Rust/WASM direct-backend paths returned equal
requested attributes on both files. Maximum ECEF component differences were
4.66 nm for Autzen and 5.85 nm for SoFi. These are backend parity results, not
survey accuracy evidence. The SoFi root has no RGB dimension in either result.

Candidate C/D point inspection reconstructed geographic display coordinates
in memory. On the 1M synthetic input, a single pick took 0.0047 / 0.0080,
0.0047 / 0.0111, 0.0070 / 0.0079, and 0.0064 / 0.0078 ms for A / B / C / D
(`p50 / p95`, n=15). One hundred picks took 0.029 / 0.036 ms for A, 0.031 /
0.034 ms for B, 0.065 / 0.110 ms for C, and 0.064 / 0.073 ms for D.

Real-root single-pick timings are `p50 / p95` milliseconds (`n=15`):

| Source / backend | A | B | C | D |
| --- | ---: | ---: | ---: | ---: |
| Autzen / copc-js + TypeScript | 0.0048 / 0.0131 | 0.0032 / 0.0090 | 0.0050 / 0.0064 | 0.0053 / 0.0081 |
| Autzen / Rust/WASM | 0.0043 / 0.0063 | 0.0035 / 0.0110 | 0.0064 / 0.0083 | 0.0058 / 0.0082 |
| SoFi / copc-js + TypeScript | 0.0035 / 0.0055 | 0.0036 / 0.0075 | 0.0052 / 0.0244 | 0.0060 / 0.0172 |
| SoFi / Rust/WASM | 0.0043 / 0.0060 | 0.0035 / 0.0094 | 0.0055 / 0.0077 | 0.0057 / 0.0087 |

Real-root 100-pick timings are also `p50 / p95` milliseconds (`n=15`):

| Source / backend | A | B | C | D |
| --- | ---: | ---: | ---: | ---: |
| Autzen / copc-js + TypeScript | 0.029 / 0.036 | 0.031 / 0.034 | 0.065 / 0.110 | 0.064 / 0.073 |
| Autzen / Rust/WASM | 0.025 / 0.035 | 0.020 / 0.035 | 0.049 / 0.053 | 0.039 / 0.054 |
| SoFi / copc-js + TypeScript | 0.027 / 0.029 | 0.025 / 0.046 | 0.052 / 0.056 | 0.052 / 0.285 |
| SoFi / Rust/WASM | 0.028 / 0.056 | 0.016 / 0.057 | 0.053 / 0.071 | 0.040 / 4.482 |

The SoFi/Rust/D p95 includes a 4.482 ms outlier (median 0.040 ms); it is not
treated as a typical per-pick cost. Re-reading exact source XYZ for B/C/D
required a whole-root local decode. Operation totals are `p50 / p95` ms
(`n=15`) and are shown for both backends:

| Source / backend | Whole-root re-read |
| --- | ---: |
| Autzen / copc-js + TypeScript | 43.415 / 47.167 |
| Autzen / Rust/WASM | 16.264 / 16.954 |
| SoFi / copc-js + TypeScript | 40.385 / 51.445 |
| SoFi / Rust/WASM | 14.832 / 18.915 |

These are local Blob timings; they do not measure remote HTTP, file
replacement, access failure, or offline behavior.

The batch ECEF-to-geographic inverse (`p50 / p95`, milliseconds, n=15) was:

| Source / backend | Allocate output | Reuse caller output |
| --- | ---: | ---: |
| Autzen / copc-js + TypeScript | 13.189 / 14.228 | 13.167 / 17.221 |
| Autzen / Rust/WASM | 13.164 / 68.031 | 13.213 / 243.499 |
| SoFi / copc-js + TypeScript | 11.266 / 15.023 | 11.274 / 14.852 |
| SoFi / Rust/WASM | 11.436 / 12.426 | 11.147 / 12.915 |

The Rust/WASM caller-output p95 outlier on Autzen is visible in the 15-run
spread and is why the median and full synthetic distribution are also reported.

The exact source-point recovery path re-read the source root. Its stage timings
below are `p50 / p95` milliseconds, n=15 measured events per backend and stage.
Warm-up events are excluded. These are distinct from the fresh open-path
measurements above.

| Source / backend | Range fetch | Decode |
| --- | ---: | ---: |
| Autzen / copc-js + TypeScript | 0.944 / 2.035 | 38.582 / 41.968 |
| Autzen / Rust/WASM | 0.873 / 1.904 | 14.945 / 15.330 |
| SoFi / copc-js + TypeScript | 0.886 / 2.876 | 33.693 / 45.174 |
| SoFi / Rust/WASM | 0.888 / 2.575 | 13.331 / 17.383 |

## Accuracy and semantics

The existing scalar `ecefToGeographic()` is reused; no duplicate scalar
implementation was added. Its inverse is iterative and reports WGS84
ellipsoidal height. It cannot recover source-CRS coordinates or undo a geoid
correction already represented in ECEF. No geoid grid was part of this run.
Float64 round-trip regression bounds were set to 1e-10° longitude/latitude,
1 µm ellipsoidal height, and 1 µm 3D ECEF distance, matching the existing
software regression fixture. These are numerical regression bounds, not
independent surveying requirements. C's measured inverse errors fit within
them; D has no independent product/survey threshold, so the results below do not
claim that D is acceptable.

Longitude error was zero in the listed fixtures after longitude wrapping and
pole normalization. A and B retain the geographic coordinates and introduce no
candidate reconstruction error. The table reports inverse/quantization error
for C and D; values are maximum / RMS, with latitude in degrees and height/ECEF
in metres. These deterministic software fixtures are not surveyed control
points.

| Fixture | Points | Candidate | Latitude max / RMS (°) | Height max / RMS (m) | ECEF 3D max / RMS (m) |
| --- | ---: | --- | ---: | ---: | ---: |
| Geographic boundary positions | 11 | C | 1.421e-14 / 7.146e-15 | 7.451e-9 / 2.333e-9 | 7.451e-9 / 2.381e-9 |
| Geographic boundary positions | 11 | D | 1.421e-14 / 7.146e-15 | 1.25 / 0.3769 | 1.25 / 0.3769 |
| Autzen WKT1 compound LCC | 4 | C | 7.105e-15 / 5.024e-15 | 1.287e-9 / 7.471e-10 | 1.397e-9 / 9.878e-10 |
| Autzen WKT1 compound LCC | 4 | D | 7.105e-15 / 5.024e-15 | 6.852e-6 / 4.213e-6 | 6.853e-6 / 4.213e-6 |
| SoFi WKT1 compound UTM11 | 4 | C | 7.105e-15 / 5.024e-15 | 1.647e-9 / 1.297e-9 | 3.158e-9 / 1.877e-9 |
| SoFi WKT1 compound UTM11 | 4 | D | 7.105e-15 / 5.024e-15 | 1.904e-5 / 9.802e-6 | 1.904e-5 / 9.802e-6 |
| WGS84 geographic WKT1 | 4 | C | 7.105e-15 / 3.553e-15 | 9.313e-10 / 6.585e-10 | 9.600e-10 / 5.821e-10 |
| WGS84 geographic WKT1 | 4 | D | 7.105e-15 / 3.553e-15 | 0 / 0 | 1.048e-9 / 5.239e-10 |
| UTM11 WKT2 PROJCRS | 4 | C | 7.105e-15 / 5.024e-15 | 1.647e-9 / 1.297e-9 | 3.158e-9 / 1.877e-9 |
| UTM11 WKT2 PROJCRS | 4 | D | 7.105e-15 / 5.024e-15 | 1.904e-5 / 9.802e-6 | 1.904e-5 / 9.802e-6 |
| Korean EPSG:5186 | 2 | C | 7.105e-15 / 5.024e-15 | 7.451e-10 / 5.268e-10 | 1.141e-9 / 8.065e-10 |
| Korean EPSG:5186 | 2 | D | 7.105e-15 / 5.024e-15 | 3.052e-6 / 2.158e-6 | 3.052e-6 / 2.158e-6 |
| 1M deterministic synthetic | 1,000,000 | C | 2.132e-14 / 7.091e-15 | 3.166e-9 / 8.168e-10 | 3.516e-9 / 9.472e-10 |
| 1M deterministic synthetic | 1,000,000 | D | 2.132e-14 / 7.091e-15 | 3.052e-6 / 1.449e-6 | 3.054e-6 / 1.449e-6 |

The geographic boundary fixture includes equator/prime meridian, Korean and
US points, both hemispheres, near-polar and dateline positions, negative
ellipsoidal heights, and high altitude (approximately 42,000 km). D's 1.25 m
error occurs in that extreme-height fixture. Ordinary-range synthetic height
quantization is about 3.05 µm maximum and 1.45 µm RMS, but the repository has
no independent surveying threshold with which to accept D.

Manual height-offset handling was measured separately on each real root and
backend. Applying +25 m or -25 m preserved the source buffer by reference and
preserved longitude/latitude exactly; the observed display-height error was
zero across all root points. Preparation timings are `p50 / p95` ms (`n=15`):

| Source / backend | +25 m | -25 m |
| --- | ---: | ---: |
| Autzen / copc-js + TypeScript | 4.999 / 6.169 | 4.852 / 5.766 |
| Autzen / Rust/WASM | 4.875 / 5.900 | 4.969 / 5.769 |
| SoFi / copc-js + TypeScript | 4.187 / 5.111 | 4.315 / 5.665 |
| SoFi / Rust/WASM | 4.160 / 6.253 | 4.067 / 5.405 |

A sequential +25 m then -50 m plan produced the expected net -25 m offset;
maximum display-height error was 1.42e-14 m for Autzen and 7.11e-15 m for
SoFi. No compatible geoid grid was available, so these runs do not measure
geoid interpolation or establish behavior for a changed geoid/CRS transform
plan.

Actual Autzen and SoFi height ranges produced no 8-bit channel mismatches in
the measured palette comparison. The engineered test places samples at
normalized palette boundaries; it is a sensitivity test, not a production
style. Counts are mismatches out of 100,000 samples for each boundary/span:

| Palette boundary | 10 m span | 100 m span | 1,000 m span |
| ---: | ---: | ---: | ---: |
| 25% | 0 | 0 | 0 |
| 50% | 0 | 0 | 0 |
| 75% | 40,750 | 40,000 | 40,000 |

The report retains fixture maxima/RMS and selected palette outcomes; the full
per-run distributions are omitted with the raw JSON artifacts.

## Browser baseline and remaining evidence

The opt-in first-visible test ran five cold and five warm Autzen repetitions
through a local HTTP 206 server with 40 ms emulated RTT, 50 Mbit/s down, and
10 Mbit/s up. It measured the current A path only. The browser was headless
Playwright Chromium at 1280×720 with SwiftShader; the timing origin is the first
COPC HTTP Range request. Values are p50 / nearest-rank p95 over five runs:

| Browser metric | Cold | Warm |
| --- | ---: | ---: |
| Page start → first Range request (ms) | 8,389.8 / 8,586.1 | 6,821.7 / 6,859.5 |
| First Range request → first-point draw (ms) | 2,073.9 / 2,322.8 | 1,189.8 / 1,358.8 |
| Page start → first-point draw (ms) | 10,629.3 / 10,716.9 | 8,011.5 / 8,195.8 |
| Camera usable (ms) | 7,189.9 / 7,487.7 | 6,025.1 / 6,772.3 |
| Target quality (ms) | 15,420.5 / 15,771.8 | 16,501.3 / 18,264.3 |
| Target-quality point count | 233,383 / 233,383 | 233,383 / 233,383 |
| Bytes fetched by first-point draw | 1,349,753 / 1,349,753 | 1,349,753 / 1,349,753 |
| Bytes fetched by target quality | 3,613,793 / 3,613,793 | 3,613,793 / 3,613,793 |
| Range requests by target quality | 16 / 16 | 16 / 16 |
| Decoded point-cache bytes at peak | 26,633,205 / 26,633,205 | 26,633,205 / 26,633,205 |

| Browser responsiveness / memory metric | Cold p50 / p95 | Warm p50 / p95 |
| --- | ---: | ---: |
| Sampled steady-frame p95 (ms) | 266.8 / 350.0 | 350.0 / 416.7 |
| Long-task count per run | 56 / 58 | 54 / 55 |
| Long-task duration p95 (ms) | 385 / 512 | 390 / 401 |
| Long-task maximum (ms) | 541 / 619 | 571 / 622 |
| Peak JS heap (bytes) | 384,144,192 / 420,955,236 | 400,248,383 / 403,000,351 |
| Peak Chromium process RSS (bytes) | 1,460,027,392 / 1,559,183,360 | 1,437,106,176 / 1,483,177,984 |

Only four to five frame intervals were captured per run. The reported frame
percentiles are therefore unstable summaries of a very short sample and must
not be read as production GPU FPS. Browser raw per-run logs are not included in
this PR; the table is the aggregate A-only baseline, not an A/B/C/D comparison.

The existing browser cache-pressure run used its current 1 MiB budget and
reported 6 hits, 6 misses, 6 evictions, and 9 Range requests. It is also an A
baseline, not an A/B/C/D comparison. Three.js lifecycle soak passed, but it
does not measure cross-layout Three.js frame performance. The pressure run did
not provide equivalent cache-byte/node/hit/miss/eviction measurements for each
candidate under a shared budget, so it cannot answer the LRU adoption question.

Still required before adopting a new default: same-byte-budget browser LRU and
camera-revisit comparisons; Cesium and Three layout comparisons; Worker
transport/isolated memory; packed-consumer behavior; repeated browser elevation
styles and point picks; and explicit source/transform-plan invalidation and
re-read failure coverage. The first-visible run also showed long main-thread
tasks and software-rendered frame intervals, so its renderer timings are only
environment-specific baseline observations.

The issue asks for a machine-readable per-run artifact. The raw Node and browser
JSON outputs are not present in this PR's final file tree; this report provides
the summarized measurements instead. That specific artifact requirement is
therefore not met by the current PR. The remaining browser A/B/C/D comparison,
same-budget LRU behavior, isolated Worker/WASM memory, and full renderer/picking
comparisons are also open work rather than conclusions from these measurements.

## Validation

- Package tests: 518 passed, 0 failed, 0 skipped.
- Package and dev-viewer typechecks passed.
- Default browser streaming benchmark: 3 passed, 1 opt-in test skipped; the
  opt-in first-visible benchmark passed separately (5 cold + 5 warm runs).
- Three.js lifecycle soak passed for 20 repetitions.
- `git diff --check` passed.

The large SoFi input was downloaded only for the measurement and removed after
the run. No dataset is included in this change.

# Issue #324: ECEF cache layout measurement report

## Recommendation

**Keep layout A as the default and defer a default cache change.** The local
Node run shows that B reduces retained arrays with little difference in the
measured CPU color pass, while C makes repeated elevation styling much slower.
D has a small ordinary-range height error, but its high-altitude and palette
boundary results need a product accuracy threshold before adoption. The
browser run is an A-only baseline; it does not compare the four layouts under
the same LRU byte budget. No public `PreparedPointData` contract, default cache
layout, or renderer behavior is changed here.

Use the B memory result to inform #326's separate evaluation of internal cache
storage and public source-coordinate access. Do not treat this report as
approval to remove source coordinates from the public API or to adopt C/D.

## Reproducibility

The report summarizes five warm-up and 15 measured runs. Source re-read stage
summaries use only the 15 measured runs, excluding warm-ups; the corrected
stage-reporting code is identified by its SHA-256 below. Per-run machine-readable
Node samples are not included in this PR; the report presents aggregate timing
statistics and selected accuracy results.

| Setting | Value |
| --- | --- |
| Source revision | `a212486ccd7df4f275fb95539f6514d5dcb0b800`; branch `mors119/perf-p2-4-ecef`; worktree dirty during measurement |
| Node command | `COPC_CACHE_BENCHMARK_SOFI=1 npm run benchmark:cache-representations --prefix packages` |
| Node script SHA-256 | `1c4f8a781e2cede2667e36b12b59bf6d72bfb8f8a615e1cbfb18ab3b92e87870` for the measured run; `d00be7472ec7831e95bfc199d842d0187d77e1bafc50370b592f1728e2ffec07` for the corrected stage-reporting code |
| Runtime / machine | Node 26.7.0, V8 14.6, macOS 25.6 arm64, Apple M2, 8 logical CPUs, 8 GiB RAM |
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

## Node measurements

### One million synthetic points

Decimal bytes. The attribute arrays are 9,000,000 bytes for every candidate;
the retained total includes those arrays. Object/scalar overhead is excluded.

| Layout | Retained coordinates / height | Attributes | Retained ArrayBuffers total |
| --- | ---: | ---: | ---: |
| A: Source F64 + Geographic F64 + ECEF F64 | 72,000,000 | 9,000,000 | 81,000,000 |
| B: Geographic F64 + ECEF F64 | 48,000,000 | 9,000,000 | 57,000,000 |
| C: ECEF F64 | 24,000,000 | 9,000,000 | 33,000,000 |
| D: ECEF F64 + height F32 | 28,000,000 | 9,000,000 | 37,000,000 |

The following are CPU RGBA color-buffer construction timings in milliseconds
(`p50 / p95`, n=15). “Cold” allocates a new output buffer; “warm” reuses an
output buffer while repeating the style. These are Node microbenchmarks, not
renderer frame times.

| Layout | Elevation color, cold first build | Elevation color, warm repeat |
| --- | ---: | ---: |
| A | 42.523 / 55.438 | 45.249 / 64.857 |
| B | 42.808 / 124.489 | 42.671 / 45.091 |
| C | 289.832 / 416.829 | 279.013 / 319.553 |
| D | 41.811 / 67.301 | 41.828 / 46.312 |

For the same million points, the batch ECEF-to-geographic conversion used by C
took 264.431 / 342.108 ms when allocating output and 253.566 / 305.514 ms with
caller-provided output (`p50 / p95`, n=15; validation and finite-value scan
included). This cost explains the repeated elevation-style penalty; RGB,
intensity, and classification styling do not need the inverse transform.

### Real root nodes

| Source | A coordinates | B coordinates | C coordinates | D coordinates | A retained total | B retained total | C retained total | D retained total |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Autzen, 61,201 points | 4,406,472 | 2,937,648 | 1,468,824 | 1,713,628 | 4,957,281 | 3,488,457 | 2,019,633 | 2,264,437 |
| SoFi, 52,296 points | 3,765,312 | 2,510,208 | 1,255,104 | 1,464,288 | 3,922,200 | 2,667,096 | 1,411,992 | 1,621,176 |

Bytes are decimal, and totals include requested typed attribute arrays. A's
`coordinates`, `sourceCoordinates`, and `worldCoordinates` aliases add no
backing-store bytes. Warm elevation color timings (`p50 / p95`, milliseconds,
n=15) were:

| Source | A | B | C | D |
| --- | ---: | ---: | ---: | ---: |
| Autzen | 1.781 / 2.268 | 1.719 / 2.226 | 13.833 / 14.599 | 1.712 / 1.870 |
| SoFi | 1.687 / 3.590 | 1.704 / 3.665 | 12.634 / 14.265 | 1.634 / 2.467 |

The JS/TypeScript and explicit Rust/WASM direct-backend paths returned equal
requested attributes on both files. Maximum ECEF component differences were
4.66 nm for Autzen and 5.85 nm for SoFi. These are backend parity results, not
survey accuracy evidence. The SoFi root has no RGB dimension in either result.

Candidate C/D point inspection reconstructed geographic display coordinates
in memory. At 100 repeated picks on the 1M synthetic input, the CPU microbench
was 0.029 / 0.036 ms for A, 0.031 / 0.034 ms for B, 0.065 / 0.110 ms for C,
and 0.064 / 0.073 ms for D (`p50 / p95`, n=15). Re-reading exact source XYZ for
B/C/D required a whole-root local decode: 43.415 / 47.167 ms for Autzen and
40.385 / 51.445 ms for SoFi (`p50 / p95`, n=15). This does not measure remote
HTTP, file replacement, access failure, or offline behavior.

The corrected source re-read stage timings below are `p50 / p95` milliseconds,
n=15 measured events per backend and stage. Warm-up events are excluded.

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

The checked-in accuracy fixtures cover equatorial, Korean and US, hemisphere,
polar, dateline, negative-height, and high-altitude cases. For the 1M
Autzen-like synthetic fixture, candidate C had maximum latitude error
`2.14e-14°`, height error `3.17e-9 m`, and 3D ECEF error `3.52e-9 m`. D's
ordinary-range synthetic F32 height quantization had maximum error about
`3.05 µm` and RMS about `1.45 µm`. In the 11-point extreme-height fixture
(including approximately 42,000 km altitude), D's maximum height error was
`1.25 m` (RMS `0.377 m`). The repository has no independent surveying
acceptance threshold for D; none is inferred here.

Actual Autzen and SoFi height ranges produced no 8-bit channel mismatches in
the measured palette comparison. An engineered palette-boundary stress test
did produce mismatches: up to 40,750 of 100,000 samples at the 75% palette
boundary with a 10 m range span. That scenario is a sensitivity test, not an
assertion about a particular production style. Full per-run error distributions
are not included in this PR.

## Browser baseline and remaining evidence

The opt-in first-visible test ran five cold and five warm Autzen repetitions
through a local HTTP 206 server with 40 ms emulated RTT, 50 Mbit/s down, and
10 Mbit/s up. It measured the current A path only. From the first COPC Range
request to first-point draw, p50/p95 was 2,073.9 / 2,322.8 ms cold and 1,189.8
/ 1,358.8 ms warm. In headless Chromium with SwiftShader, sampled steady-state
frame p95 summaries were 266.8 / 350 ms cold and 350 / 416.7 ms warm. Only
about four to five frame intervals were captured per run; these numbers must
not be read as production GPU FPS.

The existing browser cache-pressure run used its current 1 MiB budget and
reported 6 hits, 6 misses, 6 evictions, and 9 Range requests. It is also an A
baseline, not an A/B/C/D comparison. Three.js lifecycle soak passed, but it
does not measure cross-layout Three.js frame performance.

Still required before adopting a new default: same-byte-budget browser LRU and
camera-revisit comparisons; Cesium and Three layout comparisons; Worker
transport/isolated memory; packed-consumer behavior; repeated browser elevation
styles and point picks; and explicit source/transform-plan invalidation and
re-read failure coverage. The first-visible run also showed long main-thread
tasks and software-rendered frame intervals, so its renderer timings are only
environment-specific baseline observations.

## Validation

- Package tests: 518 passed, 0 failed, 0 skipped.
- Package and dev-viewer typechecks passed.
- Default browser streaming benchmark: 3 passed, 1 opt-in test skipped; the
  opt-in first-visible benchmark passed separately (5 cold + 5 warm runs).
- Three.js lifecycle soak passed for 20 repetitions.
- `git diff --check` passed.

The large SoFi input was downloaded only for the measurement and removed after
the run. No dataset is included in this change.

# Issue #324: ECEF cache layout measurement report

## Recommendation

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

## Reproducibility

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
| Node script SHA-256 | `1c4f8a781e2cede2667e36b12b59bf6d72bfb8f8a615e1cbfb18ab3b92e87870` for the measured run; `d00be7472ec7831e95bfc199d842d0187d77e1bafc50370b592f1728e2ffec07` for the corrected stage-reporting code |
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

## Node measurements

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
required a whole-root local decode: 43.415 / 47.167 ms for Autzen and 40.385 /
51.445 ms for SoFi (`p50 / p95`, n=15). This does not measure remote HTTP,
file replacement, access failure, or offline behavior.

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

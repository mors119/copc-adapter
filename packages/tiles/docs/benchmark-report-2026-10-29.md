# Performance and package report — 2026-10-29

## Environment and method

- macOS `darwin/arm64`, Apple M2, 8 logical CPUs, 8 GiB RAM.
- Node `v26.12.1` for the local microbenchmark; the unit suite also passed on
  Node `v18.20.8` and `v22.23.4`.
- Playwright `1.64.1`, Chromium `156.0.8078.4`, headless SwiftShader at
  `640×480`.
- CesiumJS `1.146.0`; Three.js `0.186.1`; `3d-tiles-renderer` `0.5.3`.
- Both source names are listed in the
  [COPC specification's example data](https://copc.io/); the Autzen byte size
  is the local file measurement and the SoFi byte size is the test's HTTP
  HEAD result.
- Real browser observations were repeated on the same sampled node(s): Autzen
  `n=2`, SoFi `n=3`. The table reports median and nearest-rank p95 for these
  small samples. They are local test-run timings, not production latency
  guarantees. The engine microbenchmark reports its own sample counts.

## Real COPC observations

| Source | Observed COPC work | Rendered primary content | Placement / precision | One-run timing |
| --- | --- | --- | --- | --- |
| Autzen, local file served through a bounded Range test server; 81,123,042 bytes, SHA-256 `db2d56cdfa058bffccdc5d6019dae2fc9c6a551df10a5523c06c76a3e25a27fa` | Public Adapter 0.6.0 copc-js. Selected node `4-11-2-0`, 5,122 points, 6 Range GETs / 164,880 bytes. No full-object transfer. All requested fields available: position, RGB, intensity, classification. | Cesium: 5,122 visible points, 9,812 / 9,497 initial / moved non-background pixels. Three: 5,122 points, 4,640 / 4,606 pixels. | Cesium camera location `-123.062693°, 44.051994°`. Tile bounds center error `0 m`; first-point Three world error `0.0000014947356675 m`; encoder max error `0.0000019626224569 m`. CRS is unverified; vertical datum unknown. | Source-open through primary GLB: median `85.3 ms`, p95 `96.9 ms` (`n=2`; observed `73.7`, `96.9`). Cesium load/render: median `1,478.3 ms`, p95 `1,833.4 ms` (`n=2`). Three: median `218.8 ms`, p95 `270.4 ms` (`n=2`). |
| SoFi Stadium, public S3 object; HEAD length 2,029,696,615 bytes | Public Adapter 0.6.0 copc-js. First hierarchy response contained 2,599 node records across levels 0–7 and 111 child-page references. Three populated nodes at levels 2, 3 and 4 were requested; each loaded and encoded point count exactly matched hierarchy metadata. 8 ranged GETs / 422,669 bytes including test-harness repeated reads; unique requested byte ranges total 320,877 bytes. No full-object GET. Position, intensity and classification available; RGB was absent. | The renderer resource wrapper contains the primary 1,131-point node. Cesium: 1,131 visible points, 2,702 / 2,624 initial / moved pixels. Three: 1,131 points, 1,094 / 1,090 pixels. The other two nodes were decoded and encoded but were not placed in a multilevel tileset or rendered. | Cesium camera location `-118.334131710723°, 33.950121310556°`. Primary-node encoder max error `0.0000041748075762 m`; Three first-point world error `0.0000023887571673 m`. CRS is unverified; vertical datum unknown. | Source-open through primary GLB while reading three nodes: median `3,007.0 ms`, p95 `3,230.6 ms` (`n=3`; observed `3,007.0`, `2,744.2`, `3,230.6`). Cesium load/render: median `1,104.0 ms`, p95 `1,723.1 ms` (`n=3`). Three: median `164.2 ms`, p95 `225.2 ms` (`n=3`). |

The SoFi browser could read Range response status and `Content-Length`, but not
`Content-Range`. The integration therefore exercised Adapter's existing
`head-fallback` policy and observed its HEAD request. Some Range requests repeat
because the test independently samples a public point view and then asks the
Tiles reader to load the requested nodes. These bytes are evidence of bounded
access, not an optimized production-transfer measurement.

Both real-source checks generated real GLB and explicit one-node wrapper
tilesets; Khronos glTF and CesiumGS 3D Tiles validators reported zero errors
and zero warnings for those artifacts. Cesium and Three loaded the same
standard GLB URL. The SoFi test recorded SHA-256
`a2bea3325ba76deb4901b1d175b4859196c12baf53389638306b77f3076221b5` for the
same bytes fetched by both renderers.

These are bounded node and renderer-consumption checks, not complete
on-demand COPC-to-Tiles streaming. The test builds bounds from decoded points,
prepares the wrapper before requesting it through renderers, and does not
compare against Direct COPC rendering. The values above are not Direct-versus-
Tiles latency or point-density comparisons.

The real-source driver exposes preparation stages separately. These are
medians / nearest-rank p95 across the same repeats; the SoFi node-preparation
stage reads three nodes, while its GLB stage times only the primary GLB. The
additional two SoFi GLB encodes were correctness checks and were not timed
separately.

| Stage (ms) | Autzen `n=2` median / p95 | SoFi `n=3` median / p95 |
| --- | ---: | ---: |
| Source open and metadata | 7.8 / 8.7 | 1,429.2 / 1,453.3 |
| Hierarchy discovery | 9.6 / 9.8 | 449.5 / 473.7 |
| Public Adapter point-view sampling | 26.0 / 30.9 | 270.5 / 322.7 |
| Tiles node read/decode/preparation | 36.9 / 43.5 | 816.4 / 1,030.7 |
| Primary GLB encode | 5.1 / 5.8 | 3.6 / 4.9 |
| GLB base64 transfer conversion | 3.1 / 3.8 | 0.6 / 0.6 |

The preliminary point-view sample and subsequent Tiles read overlap in source
data and create repeated requests; the stage table describes test work rather
than an optimized application schedule.

## 2026-10-30 browser revalidation sample

The packed-candidate real-source browser gates were rerun in Chromium on the
same development machine. These are individual observations, not new medians
or a production multi-node Tiles benchmark. The driver also sums the backing
buffers retained by the selected `TilePointView` objects and counts the GLB
bytes generated for the selected nodes. It does not include Adapter cache
retention, browser/GPU allocations, or peak temporary memory.

| Source / backend | Hierarchy pages and decoded nodes | Node preparation | GLB encode time | Retained point-view buffers | Generated GLB bytes | Browser `totalThroughBase64` | Renderer load/render |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| Autzen / `copc-js` | 1 page, 1 node, 5,122 points | 16.9 ms | 3.1 ms | 169,026 B | 119,292 B | 85.9 ms | Cesium 1,405.0 ms; Three 232.4 ms |
| Autzen / Rust/WASM | 1 page, 1 node, 5,122 points | 16.4 ms | 3.4 ms | 169,026 B | 119,292 B | 90.7 ms | Cesium 1,343.4 ms; Three 202.9 ms |
| SoFi / `copc-js` | 1 page, 3 nodes at levels 2–4, 15,796 points | 845.7 ms | 4.6 ms for primary GLB; two additional GLBs were generated outside this timer | 426,492 B across all three views | 240,816 B across all three generated GLBs | 3,182.8 ms | Cesium 1,096.7 ms; Three 152.7 ms for the primary node only |
| SoFi / Rust/WASM | 1 page, 3 nodes at levels 2–4, 15,796 points | 983.9 ms | 4.2 ms for primary GLB; two additional GLBs were generated outside this timer | 426,492 B across all three views | 240,816 B across all three generated GLBs | 3,281.8 ms | Cesium 1,071.6 ms; Three 148.3 ms for the primary node only |

The Autzen buffer total is the retained ECEF Float64 plus requested RGB,
intensity, and classification backing buffers for its single view. The SoFi
total covers the three simultaneously held ECEF, intensity, and classification
views. It excludes decoded LAZ intermediates and any Adapter-internal caches.
SoFi's 240,816-byte content total is generated output volume; only the
18,256-byte primary GLB is passed to the renderer in this wrapper. The
renderer figures include browser startup and local serving, not camera-driven
COPC refinement. No peak temporary memory or total retained browser memory was
measured, so these figures do not satisfy a full multi-node memory/performance
benchmark.

## A versus experimental E

Command: `npm run bench:engine` (synthetic ECEF node, 100,000 points, Node
26.12.1, Apple M2). A and E encoded byte-identical 2,301,416-byte GLBs.

| Operation | A median / p95 | E median / p95 | Samples |
| --- | ---: | ---: | ---: |
| View construction | 0.004 / 0.008 ms | 0.003 / 0.008 ms | 25 each |
| GLB encoding | 7.660 / 8.322 ms | 7.222 / 11.998 ms | 7 each |
| View construction + encoding | 5.576 / 9.627 ms | 5.678 / 6.142 ms | 7 each |
| Pre-aborted request detection | 0.012 / 0.029 ms | — | 50 |
| In-memory resource cold request | 1.346 / 30.290 ms | — | 7 |
| In-memory resource warm request | 0.493 / 1.438 ms | — | 50 |

The run records 7.2 MB of A coordinate inputs versus 3.2 MB of E coordinate
inputs and 0.9 MB of selected attributes. The selected A view retained 3.3 MB
of typed-array backing stores; E retained 4.1 MB because it also exposes the
prepared height buffer. The retained GLB was 2,301,416 bytes. Temporary
encoder allocations and source decode/preparation were not profiled. The
process RSS snapshot after the run was 230,904,584 bytes; it is not peak memory
for a COPC pipeline.

**Cache decision:** keep A as the connector baseline. This synthetic E path is
not a public Adapter E view, the small sample counts show no stable end-to-end
benefit, and the E view retained more selected typed-array bytes in this run.
No Direct Adapter cache default was changed.

## Packed installation and bundle measurements

The packed artifacts were installed from clean temporary consumers; `du -sk`
measured their `node_modules` directories. These are unpacked disk sizes and
exclude shared npm caches.

| Consumer | npm tarball, compressed / unpacked | Installed `node_modules` | Relevant dependency result |
| --- | ---: | ---: | --- |
| `@frillab/copc-adapter@0.6.0` only | 569,217 / 2,013,895 bytes | 6,428 KiB | No Tiles package. Adapter runtime dependencies: `copc`, `proj4`; Cesium and Three peers are optional. |
| `@frillab/copc-tiles@0.1.0` only | 73,876 / 275,582 bytes | 364 KiB | No Adapter, Cesium, Three, validator or renderer dependency. |
| Adapter + Tiles | separate tarballs | 6,788 KiB | Adapter 0.6.0 plus Tiles; no renderer peers. |
| Adapter + Tiles + Cesium 1.146.0 + Three 0.186.1 | separate tarballs | 169,964 KiB | Renderer peers account for most of the added installed footprint. |

`esbuild 0.28.2` production bundles were minified for browser ESM, with the
renderer peers external to model applications that install Cesium/Three as
separate packages:

| Entry | Minified JS bytes (gzip bytes) | Copied WASM | Bundle graph |
| --- | ---: | ---: | --- |
| Tiles root encoder + reader | 30,879 (9,173) | 0 | 11 Tiles inputs; no Adapter inputs. |
| Tiles optional copc-js connector | 15,208 (4,411) | 0 | Adapter `/cesium` remains an external dynamic import. |
| Adapter `/cesium` Direct entry | 440,486 (133,206) | 1,064,721 bytes | `cesium` is external; no Tiles inputs. |
| Adapter `/three` Direct entry | 434,130 (131,357) | 1,064,721 bytes | `three` is external; no Cesium or Tiles inputs. |
| Adapter `/cesium` + Tiles encoder/connector | 500,584 (151,253) | 1,064,721 bytes | `cesium` is external; 12 Tiles inputs. |

The Adapter WASM assets in that bundle are its 850,370-byte decoder and
214,351-byte LAZ asset. Tiles' source-neutral root adds no Adapter or WASM
input. The Direct-only consumer has no installed Tiles package and no Tiles
bundle input; this is package-graph and installation evidence, not tree-shaking
alone.

The final candidate pack was `73,876` compressed / `275,582` unpacked bytes
(45 files), installed at `364 KiB` in a clean Tiles-only consumer. A clean
Adapter-only consumer was `6,428 KiB`; adding Tiles produced `6,788 KiB`. The
renderer-combined clean install was measured at `169,964 KiB`. These numbers
are local disk usage from `du -sk node_modules`, not download sizes or shared
cache deltas. Two consecutive `npm pack` runs produced byte-identical
tarballs in this environment.

## Measurements not available

- Equivalent Direct COPC versus on-demand Tiles versus pre-generated Tiles
  camera trajectories, point density, style, transfer, time-to-first-visible,
  refinement or resource-cleanup benchmark.
- Full COPC pre-generated output benchmark; the real wrapper is a one-node
  test artifact, not a complete generated tileset.
- Network-cold versus cache-cold versus remote warm medians/p95; the measured
  cold/warm resource timings above use an in-memory provider.
- Peak browser CPU memory, retained browser tile-cache memory over movement,
  worker activity, active cancellation latency, dropped requests, decode
  allocation, temporary encoder allocation and GPU frame-time distributions.
- Real Adapter E input, Rust backend, File/Blob source, validated vertical
  datum, named extra dimensions, or independent point-by-point CRS reference.

Do not use these missing measurements to infer equivalent performance or full
T12 completion. See [`implementation-status.md`](implementation-status.md) and
[`release-checklist.md`](release-checklist.md).

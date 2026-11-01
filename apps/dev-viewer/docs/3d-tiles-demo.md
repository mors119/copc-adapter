# Projected COPC in the experimental 3D Tiles viewer

This runbook uses the existing public Adapter Core connector and local
`@frillab/copc-tiles` workspace. It keeps Direct COPC as the default and offers
two Tiles bounds strategies with different coverage claims:

| Strategy | What the bound contains | Point reads before Tileset | Projected input |
| --- | --- | --- | --- |
| `conservative-source-cell` (default) | The complete source cell and its descendants, only when Core returns a supported certified result | None | Unsupported until a metadata-only projected proof is implemented |
| `decoded-content` (explicit experimental opt-in) | Every prepared ECEF point in every content-bearing node of the completely scanned hierarchy, plus GLB reconstruction padding | Every point, sequentially, after complete traversal and budget preflight | Can display finite Core-prepared points; this does not prove source-cell coverage or survey-grade height |

`getConservativeNodeEcefBounds()` is unchanged. Projected source-cell bounds
remain unsupported by that method and the original metadata-only full-cell
proof remains **BLOCKED**. Decoded-content output records
`sourceCellCoverage: false`; it never impersonates a conservative bounds
result. A successful ECEF content envelope says only that the listed prepared
positions and their generated GLB reconstruction are enclosed. It does not by
itself validate the source datum or vertical placement.

## Reproduce the projected fixture

Use Node 22.14.0, install normally (including lifecycle scripts), and install
the Dev Viewer dependencies. PDAL must include COPC reader/writer support.
From the repository root:

```sh
nvm use 22.14.0
npm ci
npm ci --prefix apps/dev-viewer --workspaces=false
npm --prefix apps/dev-viewer run demo:projected-fixture
npm --prefix apps/dev-viewer run demo:projected-ellipsoidal-fixture
npm --prefix apps/dev-viewer run dev -- --host 127.0.0.1 --port 4177 --strictPort
```

Open `http://127.0.0.1:4177/?source=/samples/demo-projected.copc.laz&renderer=cesium`.
The generated `samples/local/demo-projected.copc.laz` is a reproducible
synthetic COPC fixture with projected EPSG:32611 east/north metre coordinates.
Its WKT declares the horizontal CRS only; it has no authoritative vertical CRS.
The fixture is not a real survey, terrain dataset, or verified-height source.

The viewer initially opens in Direct COPC. Select **Bounded decoded-content
bounds (experimental)**, select **3D Tiles (Experimental)**, then press
**Apply Settings**. Wait for the Health panel to show:

- bounds strategy `decoded-content`, coverage `rendered-content-only`, and geometry bounds `complete-decoded-content`;
- source CRS `EPSG:32611` and source-to-ECEF `prepared-by-core`;
- vertical placement `unverified` (the fixture has no vertical CRS);
- all declared content points scanned, multiple content nodes and GLB requests,
  visible tiles and visible points greater than zero;
- a nonzero observed Range byte count, peak decoded ECEF buffer, and scan time.

The diagnostic `boundsSupport: supported` refers to generated geometry bounds
for all scanned content. It does not change Core's unsupported
`unsupported-horizontal-crs` full-cell result. The screen discloses that
distinction and keeps the placement warning visible. Use **Far**, **Near**, and
**Overview** to move the camera. Switch to Direct COPC and back to Tiles to
exercise source-generation replacement and pipeline recreation.

For Three.js, open the same URL with `renderer=three` and repeat the selector,
Health, camera, and switching steps.

The second generated file,
`samples/local/demo-projected-ellipsoidal.copc.laz`, uses the same synthetic
EPSG:32611 east/north metre coordinates and WKT2 with a WGS 84 EPSG:4979 base
plus a declared ellipsoidal-height UP axis in metres. Use
`http://127.0.0.1:4177/?source=/samples/demo-projected-ellipsoidal.copc.laz&renderer=three`
to begin in Direct mode. In decoded-content Tiles mode, Health reports an
explicit WGS 84 ellipsoidal-height reference with an identity vertical
operation. The source uses the WGS 84 ensemble (stated 2 m ensemble accuracy)
and has no coordinate epoch, so this metadata check is not a survey-grade
accuracy claim. This is a reproducible synthetic fixture, not a real survey.

The full focused Chromium command regenerates the three ignored fixture files
and tests the WGS 84 conservative path, projected decoded-content in Cesium and
Three.js, and the explicit projected ellipsoidal-height diagnostic:

```sh
npm --prefix apps/dev-viewer run test:e2e:tiles
```

The projected browser fixture is synthetic. Its successful render is not a
real projected survey demonstration. It is a real COPC file generated from
projected source coordinates and exercises the complete hierarchy, multiple
GLB resources, camera movement, visible geometry, and Direct/Tiles switching.

## Real source status and limits

| Source | Current result | Vertical placement |
| --- | --- | --- |
| Generated EPSG:32611 fixture | Full decoded-content scan is browser-tested in Cesium and Three.js | **Unverified**; horizontal-only WKT |
| Generated EPSG:32611 3D fixture | Full decoded-content path and explicit height provenance are browser-tested in Three.js | WGS 84 EPSG:4979 base and ellipsoidal metre UP axis are explicit. The ensemble's stated 2 m accuracy and missing coordinate epoch prevent a survey-grade claim. |
| Autzen, EPSG:2992 / EPSG:6360 | Full decoded-content scan completed: 278/278 hierarchy nodes, 10,653,336/10,653,336 points, three on-demand GLBs. This is point-content coverage only; selected real-source content is separately browser-rendered. | **Unverified**; NAVD88 height uses US survey feet and no compatible authoritative correction/epoch operation is configured |
| SoFi, EPSG:32611 | Public source declares 364,384,576 points, exceeding the 20,000,000 API hard limit. It fails preflight and is not a complete decoded-content Tileset. | **Unverified**; source vertical authority is absent/unknown |
| EPSG:5186 fixture | Existing fixture has horizontal/ECEF controls but no authoritative vertical CRS or source-Z unit | **Unverified** |

Download local Autzen and reproduce its full bounded content scan plus three
on-demand GLB requests with:

```sh
npm run download-samples -- autzen
npm --prefix apps/dev-viewer run test:e2e:autzen-content-scan
```

This optional Chromium/Rust-WASM validation explicitly authorizes the existing
20,000,000 hard point budget (Autzen has 10,653,336 points), serializes node
reads, preflights hierarchy and byte limits, and fails on any incomplete scan.
It produces a complete content-only Tileset and requests three GLBs; it does
not render all real Autzen tiles through a camera-driven Cesium/Three session
or prove source-cell coverage. If the local sample is absent, this test reports
an explicit skip. The default Dev Viewer budget remains 4,000,000 points.

Its coordinates use international feet horizontally and US survey feet
vertically. A selected-node content render is useful for checking Core point
preparation and GLB display; do not call it a complete-source scan or
authoritative terrain placement. NOAA GEOID18 must not be applied by name alone:
it is defined for NAD83(2011), epoch 2010.00, while this source does not provide
matching epoch evidence. Use a validated NAVD88 operation and grid coverage
before claiming survey-grade height placement.

The existing selected-node browser check is optional and accepts an external
SoFi URL:

```sh
COPC_TILES_BROWSER_PORT=4175 \
COPC_TILES_AUTZEN="$(pwd)/samples/local/autzen.copc.laz" \
COPC_TILES_SOFI_URL="https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz" \
npm --prefix packages/tiles run test:browser
```

It renders selected real nodes in Cesium and Three.js. It does **not** prove
complete hierarchy coverage or metadata-only cell bounds. Omit the SoFi
variable when network access or CORS is unavailable; those tests report an
explicit skip. The decoded-content provider itself fails closed for hierarchy
incompleteness, cancellation/source replacement, non-finite data and any node,
point, compressed-byte or prepared-ECEF byte budget exceeded. Its defaults are
4,000,000 total points and 2,000,000 points per node; the hard total-point
ceiling is 20,000,000. It reads one prepared point view at a time and retains
only hierarchy records, per-node envelopes, and provenance. The diagnostic
peak buffer is the largest returned ECEF position buffer; it is not a process
RSS or total decoder-heap measurement.

On Node 22.14.0 / Chromium 156.0.8078.74, the optional real-source browser run
passed 8 tests and skipped 8 fixture-gated WGS84/conservative cases. Autzen's
selected node `4-11-2-0` contained 5,122 points and produced a 119,292-byte
GLB. Both `copc-js` and Rust/WASM displayed the same content in Cesium and
Three.js after camera movement (Cesium: 9,812/9,497 initial/moved non-black
pixels; Three: 4,640/4,606). Adapter source-to-ECEF plus GLB reconstruction
error was below 0.000002 m in this sample. This is a one-node renderer check;
the separate full scan above accounts for all Autzen nodes and points.

The real 2.03 GB SoFi source (`EPSG:32611`) returned the selected three-level
chain `2-3-0-0` / `3-0-5-0` / `4-0-10-1` (1,131 / 7,690 / 6,975 points).
The browser run fetched 8 ranges / 422,669 source bytes for `copc-js` and 9
ranges / 359,053 bytes for Rust/WASM, encoded three GLBs totaling 240,816
bytes, and displayed the leaf node in Cesium and Three.js after camera
movement. Cesium rendered 2,702/2,624 initial/moved non-black pixels; Three
rendered 1,094/1,090. Startup through source and GLB preparation was about
3.0–3.1 seconds. This exercises actual source reads and renderer consumption;
it is not a complete SoFi scan or a complete-content Tileset. Its
364,384,576-point total exceeds the 20,000,000-point hard limit. The source's
vertical authority is unknown, so the visible position is not survey-grade.

Actual source facts and remaining claims:

- SoFi: EPSG:32611; projected metre axes. Vertical authority is `0`, so Core
  reports unknown vertical provenance. Its full hierarchy cannot fit the
  decoded-content hard point limit.
- Autzen: EPSG:2992 horizontal coordinates and EPSG:6360 NAVD88 height. The
  source's vertical units are US survey feet; do not reinterpret them as
  ellipsoidal metres. A visible diagnostic placement is not terrain alignment.
- EPSG:5186: no vertical definition is available in the current conformance
  fixture, so no complete 3D source claim is made.
- `conservative-source-cell` still supports the validated EPSG:4326/4979 path
  and returns unsupported projected results. No corners-only bounds, invented
  datum conversions, or global fallback boxes are used.

## Autzen scan measurements

The full local Autzen scan ran in Chromium using the Rust/WASM Adapter backend
on Node 22.14.0, macOS arm64, Apple M2, 8 logical CPUs, 8 GiB RAM, PDAL 2.10.2,
Playwright 1.64.1, and Chromium 156.0.8078.74. The scan read one hierarchy page, discovered 278 nodes
(all 278 with content), and inspected 10,653,336 points. The sum of declared
point-data ranges was 81,111,042 bytes; prepared ECEF output totaled
255,680,064 bytes, while the largest returned Float64 ECEF node view was
1,849,488 bytes. The latest full browser rerun took 13,608 ms for preprocessing
and 13,638 ms end to end including three GLB requests. Earlier repeats took
14,966 ms and 47,981 ms for preprocessing (15,004 ms and 48,185 ms end to end),
showing substantial one-machine runtime variation. The observed source Range
total was 81,119,938
bytes before GLB reads and 81,123,529 bytes after 282 calls. Requested GLBs
were node `5-16-3-1` (47 points, 1,108 bytes), `5-17-2-1` (64 points,
1,312 bytes), and `5-8-6-1` (76 points, 1,448 bytes).

An external process monitor observed a peak Chrome-process RSS sum near 1,002
MiB. It sums per-process RSS and can count shared pages more than once; treat it
as a process-group observation, not physical peak working-set memory. The
provider's 1,849,488-byte maximum ECEF view is an exact returned typed-array
size, not a claim about decoder or browser heap usage. These are one-machine
measurements, not a reusable cross-version performance baseline.

## 30–45 second presentation recording

Record the generated projected fixture at 1440×900 in Chromium. Keep the Health
panel open so the coverage and height distinction remain visible:

1. **0–6 seconds:** show Direct COPC and the projected source label.
2. **6–12 seconds:** select decoded-content bounds, choose 3D Tiles, and apply.
3. **12–22 seconds:** show scan progress moving to complete, then point/node
   accounting, GLB requests, visible tiles, visible points, and the explicit
   `unverified` vertical placement.
4. **22–36 seconds:** use Near, orbit briefly, then Overview to show the
   rendered surface and camera response.
5. **36–45 seconds:** switch to Direct COPC and back to Tiles. End with the
   Health diagnostics showing `rendered-content-only` coverage.

For a Three.js take, use `renderer=three`. Caption the scene as a synthetic
projected fixture with diagnostic, unverified height. Do not label it Autzen,
SoFi, terrain-aligned, or survey-accurate.

## Release-track readiness

This behavior is implemented in the independent, currently unpublished
`@frillab/copc-tiles` workspace and uses the public Adapter Core 0.7.1
prepared-node/bounds contract. The same branch prepares Adapter 0.8.0 with a
narrow WKT2 projected ellipsoidal-height diagnostic and keeps the public
declaration shape unchanged. Tiles keeps 0.7.1 as its exact development
baseline, accepts the optional peer range `^0.7.1 || ^0.8.0`, and is packed
against both package versions. Do not publish either package from this branch.
The public npm Playground stays pinned to Adapter 0.7.1 and does not enable
unpublished Tiles functionality. The original projected metadata-only
full-cell proof stays **BLOCKED** and must not be described as completed.

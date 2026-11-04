# Node-based COPC streaming in the 3D Tiles viewer

This runbook uses the public Adapter Core connector and independent local
`@frillab/copc-tiles` workspace. Direct COPC remains the default. The renderer
selects visible Tiles, each requested content URI reads one COPC node, and that
prepared ECEF node is encoded as a GLB on demand.

| Strategy | What the bound contains | Point reads before Tileset | Projected input |
| --- | --- | --- | --- |
| `conservative-source-cell` | The complete source cell and descendants, only when Core returns its existing certified result | None; requested tile nodes decode on demand | Unsupported until a metadata-only projected proof exists |
| `indexed-decoded-content` | Reusable per-node observed-content bounds and the union of descendant bounds, with GLB reconstruction allowances | None after the index exists; requested tile nodes decode on demand | Supported only with a current, complete index bound to a strong-ETag source fingerprint and transform plan |
| `decoded-content` (explicit preprocessing) | Every prepared point in every content-bearing node, plus GLB reconstruction padding; never source-cell certification | Every point before Tileset creation; default 4,000,000-point limit, configurable to 20,000,000 | Generates the reusable index where immutable HTTP identity is available |

Dev Viewer selects a safe path automatically: certified source-cell bounds,
then a matching content-bounds index. If neither is available, it reads only
metadata to estimate the full scan and waits for an explicit **Prepare and
render** approval before requesting any point payload. The estimate includes
hierarchy point count, declared point-data bytes, and prepared ECEF bytes. An
approved scan raises an older aggregate point cap only to the exact complete
hierarchy count; the 20-million-point hard limit and independent node, byte,
decoded-memory, concurrency, and GLB limits still apply. The completed index
is saved when a strong-ETag identity is available and is used immediately for
indexed streaming when every node fits the indexed stream's independent
per-node limits. If a node exceeds one of those limits, the viewer keeps the
approved decoded-content provider for the current session instead of opening
an indexed stream that would reject its GLB request. The verified index is
still saved when possible; a later session may ask for preparation again.
Without a reusable strong-ETag identity, bounds remain session scoped and
must be prepared again in a later session.

`getConservativeNodeEcefBounds()` is unchanged. Projected source-cell bounds
remain unsupported by that method and the original metadata-only full-cell
proof remains **BLOCKED**. Decoded-content output records
`sourceCellCoverage: false`; it never impersonates a conservative bounds
result. A successful ECEF content envelope says only that the listed prepared
positions and their generated GLB reconstruction are enclosed. It does not by
itself validate the source datum or vertical placement.

Each Tileset currently performs a complete bounded hierarchy metadata scan
before its first render. This initial release does not lazily discover
hierarchy pages or subtrees. Point payloads remain on demand: the metadata scan
does not decode every point in the streaming strategies. Index generation is a
separate, explicit complete point scan. Dev Viewer stores only index metadata
in IndexedDB, for up to four source fingerprints; it never stores point buffers
or GLBs. Indexed reuse requires a readable strong HTTP ETag and content length,
and Adapter pins later Range responses to that ETag. Local files and remote
sources without that immutable identity can still use certified source-cell
streaming, but cannot use this reusable-index path.

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

The viewer initially opens in Direct COPC. Select **3D Tiles (Experimental)**
and press **Load / Prepare Tiles**. Certified bounds and a valid saved index
start immediately. If neither is available, review the source point count and
expected scan work, then select **Prepare and render** to continue. Wait for
the Health panel to show:

- bounds strategy `decoded-content`, coverage `rendered-content-only`, and geometry bounds `complete-decoded-content`;
- source CRS `EPSG:32611` and source-to-ECEF `prepared-by-core`;
- vertical placement `unverified` (the fixture has no vertical CRS);
- all declared content points scanned, multiple content nodes and GLB requests,
  visible tiles and visible points greater than zero;
- a nonzero observed Range byte count, peak decoded ECEF buffer, and scan time.

If the HTTP server exposes a strong ETag and content length, the scan stores an
index and switches to indexed streaming automatically when the hierarchy fits
its per-node streaming limits. A larger node keeps the bounded decoded-content
provider active for the current session. Without a strong ETag, the prompt
explains that preparation is session-only. The
diagnostic `boundsSupport: supported` refers to generated geometry bounds
for all scanned content. It does not change Core's unsupported
`unsupported-horizontal-crs` full-cell result. The screen discloses that
distinction and keeps the placement warning visible. Use **Far**, **Near**, and
**Overview** to move the camera. Switch to Direct COPC and back to Tiles to
exercise source-generation replacement and pipeline recreation.

For Three.js, open the same URL with `renderer=three` and repeat the load,
approval, Health, camera, and switching steps.

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
In the latest Node 22.14.0 / Chromium run, Cesium preprocessing took 2,566 ms
and Three.js took 976 ms for 131,072 points and five tileset nodes. Each run
observed 1,844,492 source Range bytes, a 655,008-byte peak returned ECEF buffer,
and five GLB requests totaling 2,625,168 bytes. These are one-machine
measurements; repeated browser runs varied and are not a cross-version
benchmark.

## Stream a real source above four million points

Autzen is a real 10,653,336-point COPC source. Its public HTTP endpoint
currently supports byte ranges and exposes a strong ETag. The first pass below
is an explicit preprocessing step required to create an index for this
projected source. The later indexed sessions start without a complete point
scan:

1. Open the Dev Viewer on the same origin where you will keep the index. Select
   **Autzen · public HTTP** and **3D Tiles (Experimental)**, then press
   **Load / Prepare Tiles**. Review the 10,653,336-point estimate and approve
   **Prepare and render**. Health should show `stored` after the complete scan.
2. Load Autzen again. The saved matching index is checked automatically;
   Health should show `indexed-decoded-content`, a valid index, zero points
   scanned in this session, loaded and visible nodes, and nonzero GLB requests.
   This session reads hierarchy metadata and only the point payloads selected
   by the renderer.
3. Use **Near** and **Overview**. Watch distinct GLB requests, source Range
   bytes, requested and visible point counts, active and cancelled loads, and
   cache use change in Health. The resource server holds at most 64 entries or
   32 MiB and evicts least-recently-used entries when those limits are reached.
4. Reload the same source as Three.js with
   `&pipeline=tiles&renderer=three` in the URL. The same-origin IndexedDB index
   remains available. Compare camera movement, loaded nodes, visible points,
   first-visible time, and GLB requests.

The first explicit scan decodes every Autzen point; it is not cold-start
streaming. The indexed sessions demonstrate camera-driven loading. A new
browser profile must generate its own index. A changed strong ETag invalidates
the fingerprint. If the index is missing or rejected, the viewer offers a
complete preparation scan and never treats content bounds as certified
source-cell bounds. Autzen's vertical NAVD88 evidence remains unverified for
authoritative placement.

The ordinary `test:e2e:tiles` suite includes generated-index reuse through both
renderers. To run the optional real 10.6-million-point workflow, set
`COPC_RUN_AUTZEN_INDEX_E2E=1` before the same Playwright command. Its synthetic
hierarchy regression declares exactly 4,004,078 points without committing a
large binary: a full scan without approval remains capped by its configured
limit, while source-cell streaming creates a Tileset and reads only the
requested node. A separate regression approves a 4,038,903-point hierarchy
despite its previous 4,004,078-point cap and verifies that preflight reaches
the point reader only after approval. A generated hierarchy above 20 million
points checks that streaming does not reject by source total.

## Real source status and limits

| Source | Current result | Vertical placement |
| --- | --- | --- |
| Generated EPSG:32611 fixture | Full decoded-content scan is browser-tested in Cesium and Three.js | **Unverified**; horizontal-only WKT |
| Generated EPSG:32611 3D fixture | Full decoded-content path and explicit height provenance are browser-tested in Three.js | WGS 84 EPSG:4979 base and ellipsoidal metre UP axis are explicit. The ensemble's stated 2 m accuracy and missing coordinate epoch prevent a survey-grade claim. |
| Autzen, EPSG:2992 / EPSG:6360 | Full decoded-content scan completed for index generation, followed by camera-driven indexed sessions in Cesium and Three. Each renderer requested distinct node GLBs and rendered selected points without another full point scan. | **Unverified**; NAVD88 height uses US survey feet and no compatible authoritative correction/epoch operation is configured |
| SoFi, EPSG:32611 | Explicit full preprocessing exceeds the 20,000,000 point hard limit; without certified source-cell bounds or a valid index, this projected source is unsupported for Tileset streaming. Selected-node renderer checks remain separate. | **Unverified**; source vertical authority is absent/unknown |
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
an explicit skip. The explicit Dev Viewer budget defaults to 4,000,000 points
and can be raised to 20,000,000 for complete preprocessing. Normal
node-streaming strategies do not apply that global total-point limit.

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

## 30–45 second generated-fixture bounds presentation

Record the generated projected fixture at 1440×900 in Chromium. Keep the Health
panel open so the coverage and height distinction remain visible:

1. **0–6 seconds:** show Direct COPC and the projected source label.
2. **6–12 seconds:** choose 3D Tiles and select **Load / Prepare Tiles**.
   Approve the displayed estimate to start the scan.
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

## 30–45 second large-source streaming presentation

Before recording, generate and store an Autzen index using the runbook above.
Then start a fresh session with the default automatic strategy, for example
`?pipeline=tiles&renderer=cesium`:

1. **0–8 seconds:** show the source total above ten million points, a valid
   index, zero points scanned this session, and the metadata-node total.
2. **8–20 seconds:** show visible points and GLB requests, then move to Near
   and point out newly requested node resources.
3. **20–32 seconds:** orbit and return to Overview. Show source Range bytes,
   requested versus rendered points, active/cancelled requests, and cache use.
4. **32–45 seconds:** reload the same source and index as Three.js. Compare
   visible points, additional GLB requests, and first-visible measurements.

The index preparation pass is not part of this recording. Health should show
`indexed-decoded-content` and zero complete-scan points for both renderer
sessions. Keep the NAVD88 unverified-placement note visible.

### Measured real Autzen indexed sessions

On Node 22.14.0 / Chromium 156.0.8078.74, the optional browser test used the
verified 81,123,042-byte public Autzen object through a local HTTP range
response harness. Index generation took 121,206 ms and observed 81,187,270
source bytes across the full point scan. The indexed Cesium session initialized
in 23,881 ms and showed its first points after 28,052 ms: 199,177 points were
decoded, 2,444,803 source bytes and 5,289,158 Tiles resource bytes had been
read, and 131,060 points were visible. It requested 28 GLBs (6,937,036 bytes),
reached four active loads, and retained 12 cache entries (8,237,450 bytes)
without eviction. Moving Near triggered additional distinct node GLBs.

The indexed Three session initialized in 36 ms and showed its first points
after 595 ms: 199,218 points were decoded, 2,405,133 source bytes and
5,289,238 Tiles resource bytes had been read, and 119,687 points were visible.
It requested 31 GLBs (5,125,972 bytes), reached four active loads, and retained
nine cache entries (6,426,386 bytes) without eviction. Moving Near triggered
additional distinct node GLBs. These one-machine measurements use the real
survey bytes but a local range harness; they are not live-network latency or a
cross-version benchmark. The first index generation is a full preprocessing
pass, not part of either indexed session. Each indexed initialization
separately read one 8,896-byte COPC hierarchy page containing all 278 metadata
nodes; that traversal is distinct from the 2.4 MB of source ranges before first
visibility. Autzen's NAVD88 placement remains unverified.

## Release-track readiness

This behavior is implemented in the independent, currently unpublished
`@frillab/copc-tiles` workspace and uses the public Adapter Core 0.8.x
prepared-node/bounds contract. Adapter adds strong-ETag range pinning and
aggregate returned-byte diagnostics for immutable index identity; existing
public APIs remain available. Tiles keeps its optional peer range
`^0.7.1 || ^0.8.0` and is packed against both package versions. Do not publish
either package from this branch.
The public npm Playground stays pinned to Adapter 0.8.0 and does not enable
unpublished Tiles functionality. The original projected metadata-only
full-cell proof stays **BLOCKED** and must not be described as completed.

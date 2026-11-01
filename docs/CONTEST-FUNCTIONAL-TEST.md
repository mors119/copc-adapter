# Cesium contest functional-test runbook

This CesiumJS walkthrough uses the repository's current development Viewer and records the proof to collect for each row. It is Cesium-only. The added controls validate this source checkout; they do not change or describe the published `@frillab/copc-adapter` package.

## Reproducibility record

The final run for this freeze used:

| Item | Value |
| --- | --- |
| Operating system / architecture | macOS 26.6.2 / Darwin arm64 |
| Node.js / npm | v26.7.0 / 11.19.0 |
| Browser | Google Chrome 154.0.8037.98, headless Chromium for automated checks |
| CesiumJS | 1.145.0 (resolved by the checked-in lockfile) |
| Browser automation | Playwright 1.63.0 |
| Sample source | `https://s3.amazonaws.com/hobu-lidar/autzen-classified.copc.laz` |
| Local sample path | `samples/local/autzen.copc.laz` |
| Browser sample URL | `http://127.0.0.1:4177/samples/autzen.copc.laz` |
| Default run URL / backend | `http://127.0.0.1:4177/` / `copc-js` |

Record the exact checked-out revision with `git rev-parse HEAD` alongside any new rehearsal evidence. The final validation revision and command results for this freeze are also recorded in the linked issue-213 pull request.

Autzen is a local, same-origin sample, so CORS is not involved in the main demo. The browser must still receive `206 Partial Content` and a `Content-Range` whose interval matches each `Range` request and whose total is the sample size. Cross-origin sources must additionally allow the page origin and expose `Content-Range` to browser JavaScript. The public SoFi source currently omits that exposed-header permission; see the limitation under row 13 and [the SoFi validation report](benchmarks/issue-212-sofi-multigb-streaming.md).

## Clean setup and launch

Use Node.js 22 or newer and an installed Rust toolchain. Setup adds the
`wasm32-unknown-unknown` target, installs root and viewer dependencies,
prepares the existing WASM assets and Chromium, and downloads Autzen after
validating its configured byte size and SHA-256. The sample stays in ignored
local paths and is served directly by the Vite Range middleware.

```bash
npm run setup
npm run dev
```

Open the default page at <http://127.0.0.1:4177/>. The default source is Autzen and the default backend is `copc-js`; no scenario, backend, or point-budget query parameters are needed for the eight-step walkthrough. The camera controls preserve the current longitude and latitude while changing camera height. The style controls call the current `getStyle()` / `setStyle(CopcCesiumPointStyleUpdate)` API.

The focused browser validation and the existing full viewer regression suite use separate Playwright runs. Both start their own Vite server; the full-suite port and browser configuration remain unchanged.

```bash
npm run test:functional
npm run typecheck -w @frillab/copc-adapter
npm test -w @frillab/copc-adapter
npm run build -w @frillab/copc-adapter
npm --prefix apps/dev-viewer run test:e2e
npm run test:pack
```

The viewer browser suite starts its own strict-port Vite server on 4173; it does not attach to an arbitrary existing server. If 4173 is occupied, choose another free port, for example `PLAYWRIGHT_TEST_PORT=4178 npm --prefix apps/dev-viewer run test:e2e`. Existing-server reuse is available only as an explicit local opt-in with `PLAYWRIGHT_REUSE_SERVER=1`, and should be used only after confirming that server is this viewer app. The live demo uses 4177 to avoid port conflicts; stop it before starting automated browser suites so they do not compete for WebGL/CPU resources. The viewer browser suite uses headless Chrome/WebGL with SwiftShader and one worker; it includes deterministic coverage-transition and Range-cancellation checks plus the SoFi multi-GB scenario. `npm run test:pack` exercises the packed external Cesium consumer and Worker path on ports 4174–4176. The viewer unit suite covers EPSG:5186 conformance. The SoFi test forwards real ranged bytes through a test route that exposes `Content-Range`; it does not remove the public source's CORS limitation.

## Before each live run

1. Start from a fresh page load at the default URL above and wait for the debug panel to say `Ready` and for points to appear. The manual viewer uses port 4177; leave the Playwright port 4173 and packed-consumer ports 4174–4176 free unless you set `PLAYWRIGHT_TEST_PORT`.
2. Keep the `COPC runtime debug panel` visible. Point inspection appears beside the selected point after a canvas click. If the debug panel was hidden, press `Shift+D` or reload the run URL.
3. Open DevTools Network, enable **Preserve log**, and filter requests by `autzen.copc.laz`. Clear the log before starting the demo sequence.
4. For visual proof, keep the canvas and both panels in frame. For diagnostic proof, use DevTools Console expressions below and save their output with the revision from `git rev-parse HEAD`.
5. Treat the displayed decoded-cache bytes as CPU typed-array accounting. They do not measure total browser, Cesium, WebGL, or GPU memory.

## Frozen demo and evidence matrix

| # | Exact action | Observable result | Supporting evidence | Fallback / recovery | Proof |
| --- | --- | --- | --- | --- | --- |
| 1. Direct COPC load | Open the default page after setup. | Cesium shows Autzen directly from the COPC file; the panel reaches `Ready` and reports its metadata. | Network reads from `autzen.copc.laz`; the panel reports reachability, Range support, COPC detection, and point format. | If the URL is 404, run `npm run download-samples -- autzen` and reload. | Visual + diagnostic |
| 2. Partial HTTP reads | In Network, inspect a request for the sample. | The request has `Range: bytes=…`; the response is `206` and `Content-Range` matches the requested interval. | Browser request/response headers, functional Playwright response assertions, and panel `HTTP Range requests` counters. | A `200` response or mismatched `Content-Range` fails this source check; verify the downloaded sample and Vite response before continuing. | Browser + diagnostic |
| 3. Camera-driven node selection | Record selected node keys, then click `Far` or rotate the Cesium view. | Camera movement triggers a streaming update and changes selected nodes, visible levels, or hierarchy activity. | Selected/rendered node keys, hierarchy request/cache counters, and `streamingUpdateCount`. | Click `Overview` to return to the dataset view. | Visual + diagnostic |
| 4. Overview and close LoD | Click `Overview`, wait for the view to settle, then click `Near`. | The close view selects a different node set or visible level range. | Compare selected node keys, visible levels, rendered point count, and streaming update count. | Repeat the two presets after pending Range and node work settles. | Visual + diagnostic |
| 5. Coarse-to-fine refinement | Move from `Overview` to `Near`; optionally enable **Slow 3G** to inspect work in progress. | The viewer accepts finer nodes, renders a finer visible level, and settles with no active replacement groups. During a pending replacement, coarse coverage remains visible. | `acceptedRefinementCount`, visible level range, and live `activeReplacementGroupCount` / `coarseNodesRetainedForCoverageCount`; coverage-safe regressions in `apps/dev-viewer/e2e/copc-viewer.spec.ts` and `apps/dev-viewer/e2e/streaming-performance.spec.ts`. | If the active transition settles before inspection, repeat under Slow 3G; the automated coverage regression also exercises the replacement boundary. | Visual + diagnostic / automated |
| 6. Bounded work and cache | Read the panel's point budget, active points, node load slots, and decoded CPU point cache after the close view settles. | Rendered/active points stay at or below the configured cap; active node loads do not exceed their load slots; active Workers do not exceed the pool size; cache bytes stay at or below its reported cap. | `getState().performance`, `.pointCache`, `.worker`, and the matching panel sections. Check `activeRenderedPointCount <= configuredPointBudget` and `currentCacheBytes <= cacheByteBudget`. | Wait for active work to settle and compare again; budgets apply to the adapter's reported point/cache accounting, not browser or GPU memory. | Diagnostic |
| 7. RGB, elevation, intensity, classification | Click `RGB`, `Elevation`, `Intensity`, and `Classification` in the panel. | Point colors use the selected mode while the loaded layer stays visible. The controls update `colorMode` and preserve any current classification filter. | Active color mode in the panel and `getStyle()`; range and point-cache miss counters remain unchanged for style updates. | Select another mode; use the existing `setStyle({colorMode:'rgb', classificationFilter:null})` API to clear a filter if needed. | Visual + diagnostic |
| 8. Point picking and inspection | Click a visible rendered point in the canvas. | An anchored popover shows the selected point's node, index, position, height, and available intensity/classification/RGB values. | The point popover and `window.__COPC_DEBUG__.getState().selectedPoint`. | Click a point near the center of the cloud; clear a style filter if no points are currently visible. | Visual + diagnostic |
| 9. Worker-isolated decode | Keep `backend=rust`; move between overview and close view while nodes are processed. Expand `Rust decode workers` in the panel. | Worker job counters advance while the Cesium camera and rendering remain interactive. Decode/preparation runs in Workers when available; camera control and Cesium primitive submission remain on the main thread. | Worker count, active/queued/completed counters; `npm run test:pack` exercises `tests/environments/cesium-vite/e2e/packed-consumer.spec.js`. | If no job is active when inspected, change views during loading or run the packed-consumer test. A Worker failure is an error, not a silent backend switch. | Diagnostic + automated |
| 10. Superseded Range cancellation | Enable **Slow 3G**, start a close-view request, then immediately move back to overview while a sample Range request is pending. | Network marks the obsolete request as cancelled; `Aborted by view changes` increases and the new view can settle. | Network request status and `rangeRequests.abortedSuperseded`; deterministic held-response proof in `apps/dev-viewer/e2e/streaming-performance.spec.ts` and `apps/dev-viewer/e2e/sofi-multigb-validation.spec.ts`. | If the request completes before the move, repeat under Slow 3G. Use the automated held-Range scenario for a controlled reproduction. | DevTools + diagnostic / automated |
| 11. Runtime classification filter and style | Click a point and note its classification in the anchored point popover. In Console, apply `window.__COPC_DEBUG__.setStyle({colorMode:'classification',classificationFilter:{include:[N]}})` with `N` replaced by that value. Then clear it with `window.__COPC_DEBUG__.setStyle({colorMode:'rgb',classificationFilter:null})`. | Only matching classifications remain visible; clearing the filter restores the unfiltered points. | Before/after `getState()` snapshots: `rangeRequests.requested`, `pointCache.misses`, and `pointCache.currentCacheBytes` do not increase/change because of the style mutation. Browser regression in `apps/dev-viewer/e2e/copc-viewer.spec.ts`; API-level regression in `packages/adapter/test/cesium/layer.test.mjs`. | If no points remain, clear the filter and use a classification value read from another picked point. | Visual + diagnostic / automated |
| 12. EPSG:5186 handling and Cesium placement | Run the complete adapter unit suite from the clean setup. | The checked-in authoritative EPSG:5186 controls match expected WGS84/ECEF coordinates and the Cesium placement smoke places the result in the Korean region. Autzen itself is not an EPSG:5186 dataset. | `packages/adapter/test/core/coordinates/crs/epsg-5186.test.mjs` and `packages/adapter/test/core/coordinates/crs/audit.test.mjs` output. | Rerun `npm test -w @frillab/copc-adapter`; do not claim the Autzen view proves EPSG:5186. | Automated conformance |
| 13. SoFi multi-GB source | Run `npm --prefix apps/dev-viewer run test:e2e`; the `sofi-multigb-validation.spec.ts` scenario exercises overview/close/oblique views, a second area and return, and a held obsolete Range. | Only validated partial ranges are read; the reported point/cache budgets hold and returning to a cached area avoids another point read. | Playwright output and [issue-212 report](benchmarks/issue-212-sofi-multigb-streaming.md), including exact source size and Range totals. | The report is **LIMITED**: the public source does not expose `Content-Range` to browser JavaScript. The test route adds the missing `Access-Control-Expose-Headers` for observation; this is not proof that an unmodified browser can use that endpoint. | Automated / DevTools |

Rows 12 and 13 are linked automated evidence, not claims that the Autzen live scene is an EPSG:5186 or multi-GB dataset. Keep the live walkthrough in the same Cesium page and use the linked checks for those source-specific conditions.

## Frozen scope

Keep this contest demonstration focused on Cesium COPC loading, Range streaming, camera-driven hierarchy/LoD, bounded work, styling, picking, and the applicable validation evidence above. Do not add Three.js, LAS/LAZ-to-COPC conversion, Playground, Focus Lens, predictive prefetch, package splitting, EDL, measurements, profiles, clipping, or annotations to this runbook.

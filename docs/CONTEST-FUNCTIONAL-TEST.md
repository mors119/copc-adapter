# Cesium contest functional-test runbook

This is the frozen CesiumJS demonstration path for [issue #213](https://github.com/mors119/copc-adapter/issues/213). It exercises the submitted COPC streaming functions in one repeatable order and records the proof to collect for each row. The runbook is Cesium-only.

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
| Local sample path | `samples/local/autzen.copc.laz`, staged as `apps/viewer-web/public/samples/autzen.copc.laz` |
| Browser sample URL | `http://127.0.0.1:4177/samples/autzen.copc.laz` |
| Run URL / backend / scenario | `http://127.0.0.1:4177/?scenario=issue68&backend=rust&budget=250000` |

Record the exact checked-out revision with `git rev-parse HEAD` alongside any new rehearsal evidence. The final validation revision and command results for this freeze are also recorded in the linked issue-213 pull request.

Autzen is a local, same-origin sample, so CORS is not involved in the main demo. The browser must still receive `206 Partial Content` and a `Content-Range` whose interval matches each `Range` request and whose total is the sample size. Cross-origin sources must additionally allow the page origin and expose `Content-Range` to browser JavaScript. The public SoFi source currently omits that exposed-header permission; see the limitation under row 13 and [the SoFi validation report](benchmarks/issue-212-sofi-multigb-streaming.md).

## Clean setup and launch

Run these commands from a fresh checkout. The sample stays in ignored local paths and is not added to Git.

```bash
npm ci
npm ci --prefix apps/viewer-web
npm run download-samples -- autzen
mkdir -p apps/viewer-web/public/samples
cp samples/local/autzen.copc.laz apps/viewer-web/public/samples/autzen.copc.laz
```

Start the Cesium app in one terminal:

```bash
npm --prefix apps/viewer-web run dev -- --host 127.0.0.1 --port 4177 --strictPort
```

Open `http://127.0.0.1:4177/?scenario=issue68&backend=rust&budget=250000`. This selects the Rust backend, the bounded issue-68 streaming scenario, and a 250,000 rendered-point cap. It loads the COPC file directly; the demo does not convert it to 3D Tiles. The development-only `window.__COPC_DEBUG__` adapter supplies repeatable camera and style actions in DevTools without editing source files.

For the complete automated rehearsal, use another terminal:

```bash
npm --prefix apps/viewer-web run typecheck
npm --prefix apps/viewer-web test
npm --prefix apps/viewer-web run build
npm --prefix apps/viewer-web run test:e2e
npm run test:pack
```

The viewer browser suite starts its own strict-port Vite server on 4173; it does not attach to an arbitrary existing server. If 4173 is occupied, choose another free port, for example `PLAYWRIGHT_TEST_PORT=4178 npm --prefix apps/viewer-web run test:e2e`. Existing-server reuse is available only as an explicit local opt-in with `PLAYWRIGHT_REUSE_SERVER=1`, and should be used only after confirming that server is this viewer app. The live demo uses 4177 so it can remain open during the test run. The viewer browser suite uses headless Chrome/WebGL with SwiftShader and one worker; it includes deterministic coverage-transition and Range-cancellation checks plus the SoFi multi-GB scenario. `npm run test:pack` exercises the packed external Cesium consumer and Worker path on ports 4174–4176. The viewer unit suite covers EPSG:5186 conformance. The SoFi test forwards real ranged bytes through a test route that exposes `Content-Range`; it does not remove the public source's CORS limitation.

## Before each live run

1. Start from a fresh page load at the run URL above and wait for the debug panel to say `Ready` and for points to appear. The runbook uses port 4177; leave the Playwright port 4173 and packed-consumer ports 4174–4176 free unless you set `PLAYWRIGHT_TEST_PORT`.
2. Keep the `COPC runtime debug panel` and `COPC point inspector` visible. If the debug panel was hidden, press `Shift+D` or reload the run URL.
3. Open DevTools Network, enable **Preserve log**, and filter requests by `autzen.copc.laz`. Clear the log before starting the demo sequence.
4. For visual proof, keep the canvas and both panels in frame. For diagnostic proof, use DevTools Console expressions below and save their output with the revision from `git rev-parse HEAD`.
5. Treat the displayed decoded-cache bytes as CPU typed-array accounting. They do not measure total browser, Cesium, WebGL, or GPU memory.

## Frozen demo and evidence matrix

| # | Exact action | Observable result | Supporting evidence | Fallback / recovery | Proof |
| --- | --- | --- | --- | --- | --- |
| 1. Direct COPC load | Open the run URL without preprocessing the sample. | Cesium shows the Autzen point cloud; the panel reaches `Ready` and reports its metadata. | Network shows reads from `autzen.copc.laz`; the panel reports reachability, Range support, COPC detection, and point format. | If the URL is 404, repeat the sample download and copy commands, then reload. | Visual + diagnostic |
| 2. Partial HTTP reads | In Network, open a sample request and inspect request and response headers. | The request has `Range: bytes=…`; the response is `206` and `Content-Range: bytes start-end/total` matches the requested interval. No whole sample is fetched. | Network request/response headers; debug panel `HTTP Range requests` counters. | A `200` response or unreadable `Content-Range` is a failed source prerequisite; check the local sample path and server response before continuing. | DevTools |
| 3. Camera-driven node selection | Save `window.__COPC_DEBUG__.getState().selectedNodeKeys` in Console. Drag/rotate the Cesium view or run `window.__COPC_DEBUG__.setCameraHeading(90)`, then read the selected keys again. | Camera position/direction and the selected node set update; hierarchy pages may load as the view changes. | Debug panel selected-node keys, camera direction, hierarchy counters, and `streamingUpdateCount`. | Return to a useful view with `window.__COPC_DEBUG__.setCameraHeight(1000)`; the helper preserves the current camera longitude and latitude. | Visual + diagnostic |
| 4. Overview and close LoD | Run `window.__COPC_DEBUG__.setCameraHeight(100000)`, wait for the view to settle, then run `window.__COPC_DEBUG__.setCameraHeight(1000)` and wait again. | Overview uses coarser/fewer visible nodes; the close view refines to a different selection and visible level range. | Compare `selectedNodeKeys`, `visibleLevelRange`, `renderedPointCount`, and `streamingUpdateCount` from `getState()`. | Repeat the two height calls; allow pending Range and Worker work to settle before comparing. | Visual + diagnostic |
| 5. Coarse coverage during refinement | With DevTools Network throttling set to **Slow 3G**, move from overview to the close view and inspect `window.__COPC_DEBUG__.getState().transition` while requests are pending. | Existing coarse points remain visible while replacement detail is prepared; after completion, the replacement group settles. | `coarseNodesRetainedForCoverageCount` and `activeReplacementGroupCount` in `transition`; screenshot of the cloud during refinement. | If the request finishes before inspection, repeat with Slow 3G. The deterministic browser regression is `apps/viewer-web/e2e/copc-viewer.spec.ts` and the transition capture is in `apps/viewer-web/e2e/streaming-performance.spec.ts`. | Visual + diagnostic / automated |
| 6. Bounded work and cache | Read the panel's point budget, active points, node load slots, and decoded CPU point cache after the close view settles. | Rendered/active points stay at or below the configured cap; active node loads do not exceed their load slots; active Workers do not exceed the pool size; cache bytes stay at or below its reported cap. | `getState().performance`, `.pointCache`, `.worker`, and the matching panel sections. Check `activeRenderedPointCount <= configuredPointBudget` and `currentCacheBytes <= cacheByteBudget`. | Wait for active work to settle and compare again; budgets apply to the adapter's reported point/cache accounting, not browser or GPU memory. | Diagnostic |
| 7. RGB, elevation, intensity, classification | In Console, run `window.__COPC_DEBUG__.setStyle({colorMode:'rgb'})`, then repeat with `'elevation'`, `'intensity'`, and `'classification'`. Read the active mode with `window.__COPC_DEBUG__.getStyle()`. | Point colors change according to the selected attribute when that attribute is present in the sample. | Canvas color change; `getStyle()` mode; click a point to see its source values in the inspector. | Return to `rgb` with `window.__COPC_DEBUG__.setStyle({colorMode:'rgb',classificationFilter:null})`. | Visual + diagnostic |
| 8. Point picking and inspection | Click a visible rendered point in the canvas. | The inspector changes from `Click a rendered point` to the selected point's node, index, position, height, and available intensity/classification/RGB values. | `COPC point inspector` and `window.__COPC_DEBUG__.getState().selectedPoint`. | Click a point near the center of the cloud; clear a style filter if no points are currently visible. | Visual + diagnostic |
| 9. Worker-isolated decode | Keep `backend=rust`; move between overview and close view while nodes are processed. Expand `Rust decode workers` in the panel. | Worker job counters advance while the Cesium camera and rendering remain interactive. Decode/preparation runs in Workers when available; camera control and Cesium primitive submission remain on the main thread. | Worker count, active/queued/completed counters; `npm run test:pack` exercises `tests/environments/cesium-vite/e2e/packed-consumer.spec.js`. | If no job is active when inspected, change views during loading or run the packed-consumer test. A Worker failure is an error, not a silent backend switch. | Diagnostic + automated |
| 10. Superseded Range cancellation | Enable **Slow 3G**, start a close-view request, then immediately move back to overview while a sample Range request is pending. | Network marks the obsolete request as cancelled; `Aborted by view changes` increases and the new view can settle. | Network request status and `rangeRequests.abortedSuperseded`; deterministic held-response proof in `apps/viewer-web/e2e/streaming-performance.spec.ts` and `apps/viewer-web/e2e/sofi-multigb-validation.spec.ts`. | If the request completes before the move, repeat under Slow 3G. Use the automated held-Range scenario for a controlled reproduction. | DevTools + diagnostic / automated |
| 11. Runtime classification filter and style | Click a point and note its classification in the inspector. In Console, apply `window.__COPC_DEBUG__.setStyle({colorMode:'classification',classificationFilter:{include:[N]}})` with `N` replaced by that value. Then clear it with `window.__COPC_DEBUG__.setStyle({colorMode:'rgb',classificationFilter:null})`. | Only matching classifications remain visible; clearing the filter restores the unfiltered points. | Before/after `getState()` snapshots: `rangeRequests.requested`, `pointCache.misses`, and `pointCache.currentCacheBytes` do not increase/change because of the style mutation. Browser regression in `apps/viewer-web/e2e/copc-viewer.spec.ts`; API-level regression in `apps/viewer-web/test/copc-viewer.test.mjs`. | If no points remain, clear the filter and use a classification value read from another picked point. | Visual + diagnostic / automated |
| 12. EPSG:5186 handling and Cesium placement | Run the complete viewer unit suite from the clean setup. | The checked-in authoritative EPSG:5186 controls match expected WGS84/ECEF coordinates and the Cesium placement smoke places the result in the Korean region. Autzen itself is not an EPSG:5186 dataset. | `apps/viewer-web/test/epsg-5186-conformance.test.mjs` and `apps/viewer-web/test/crs-audit.test.mjs` output. | Rerun `npm --prefix apps/viewer-web test`; do not claim the Autzen view proves EPSG:5186. | Automated conformance |
| 13. SoFi multi-GB source | Run `npm --prefix apps/viewer-web run test:e2e`; the `sofi-multigb-validation.spec.ts` scenario exercises overview/close/oblique views, a second area and return, and a held obsolete Range. | Only validated partial ranges are read; the reported point/cache budgets hold and returning to a cached area avoids another point read. | Playwright output and [issue-212 report](benchmarks/issue-212-sofi-multigb-streaming.md), including exact source size and Range totals. | The report is **LIMITED**: the public source does not expose `Content-Range` to browser JavaScript. The test route adds the missing `Access-Control-Expose-Headers` for observation; this is not proof that an unmodified browser can use that endpoint. | Automated / DevTools |

Rows 12 and 13 are linked automated evidence, not claims that the Autzen live scene is an EPSG:5186 or multi-GB dataset. Keep the live walkthrough in the same Cesium page and use the linked checks for those source-specific conditions.

## Frozen scope

Keep this contest demonstration focused on Cesium COPC loading, Range streaming, camera-driven hierarchy/LoD, bounded work, styling, picking, and the applicable validation evidence above. Do not add Three.js, LAS/LAZ-to-COPC conversion, Playground, Focus Lens, predictive prefetch, package splitting, EDL, measurements, profiles, clipping, or annotations to this runbook.

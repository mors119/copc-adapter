# Issue 212: SoFi multi-GB browser streaming validation

This record covers the final browser validation requested by [issue #212](https://github.com/mors119/copc-adapter/issues/212). Measurements were captured on 2026-10-07 against source commit `53944880c1f912f3ceaddf91e8c501056e86019c`.

## Result

**LIMITED.** The Rust/Cesium path streamed the 2,029,696,615-byte [SoFi COPC source](https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz) through validated partial ranges, stayed within the configured point and decoded-cache budgets, reused data when returning to an earlier area, and cancelled a held obsolete range. The source endpoint itself still lacks the CORS response header that exposes `Content-Range` to browser JavaScript, so an unmodified browser cannot use the endpoint directly. The browser measurements below used a Playwright route that forwarded each real Range request upstream and added the missing CORS exposure header to the response for the test page.

The endpoint returned `206 Partial Content`, exact `Content-Range`, and `Access-Control-Allow-Origin: *` for an origin-bearing probe. It did not return `Access-Control-Expose-Headers`. A direct browser run failed while creating the COPC source context. The test shim added `Access-Control-Expose-Headers: Accept-Ranges, Content-Length, Content-Range`; it did not replace or synthesize the source bytes. The source deployment must expose `Content-Range` for direct browser use.

## Environment and configuration

| Item | Value |
| --- | --- |
| Source size / points | 2,029,696,615 bytes / 364,384,576 points |
| OS / architecture | macOS 26.6.2 / Darwin arm64 |
| Browser | Chrome 154.0.8037.98, headless, 1280 × 720 |
| WebGL | SwiftShader |
| Node.js | v26.7.0 |
| Backend / styling | Rust / elevation |
| Streaming settings | 32 max nodes, depth 6, SSE 8, 20,000 m render distance |
| Rendered-point budget | 250,000 |
| Decoded CPU point-cache cap | 268,435,456 bytes (256 MiB) |

These are one-machine measurements, not browser-wide latency, frame-rate, or memory guarantees. The decoded-cache values are project-owned CPU typed-array accounting; they do not represent total browser, Cesium, or GPU memory.

## SoFi browser run

The first useful rendered point appeared 73,679 ms after navigation. The initial view rendered 247,960 points in 15 selected/rendered nodes. Its streaming update reported 3,386,421 point-range bytes; hierarchy loading requested 112 pages and read 424,928 hierarchy bytes across 13,279 entries.

| Camera scenario | Selected / rendered nodes | Rendered points | Update range bytes | Decoded cache bytes after view |
| --- | ---: | ---: | ---: | ---: |
| Initial view | 15 / 15 | 247,960 | 3,386,421 | 18,597,000 |
| Close downward, 1.5 km | 13 / 13 | 245,390 | 1,636,629 | 28,459,200 |
| Medium overview, 20 km | 13 / 13 | 245,390 | 0 | 28,459,200 |
| High overview, 100 km | 0 / 0 | 0 | 0 | 28,459,200 |
| Oblique view toward the stadium | 10 / 10 | 239,592 | 1,380,390 | 36,497,850 |
| Area A | 1 / 1 | 5,156 | 64,476 | 36,884,550 |
| Area B | 1 / 1 | 10,924 | 138,461 | 37,703,850 |
| Return to area A | 1 / 1 | 5,156 | 0 | 37,703,850 |

The high overview selected no nodes at 100 km, beyond the configured 20 km render distance. Returning from area B to area A increased decoded-cache hits from 20 to 21 and made no additional Range request. The observed cache maximum was 37,703,850 bytes, below the 256 MiB cap, with no eviction in this run.

Per-view one-second `requestAnimationFrame` samples contained 4–10 intervals; sampled p95 intervals ranged from about 133 to 317 ms across views. The maximum browser Long Task during the run was 542 ms. These headless SwiftShader observations vary by run and are not a fixed FPS target.

Across the complete camera path, the browser received 144 Range responses, all `206`, totaling 6,695,017 bytes (0.330% of the object). The largest response was 476,747 bytes. Every response's returned interval matched its requested interval and reported the same 2,029,696,615-byte object total. No whole-object request was allowed by the test harness. Reader diagnostics ended at 145 requests: 144 completed, 1 superseded, 0 failed, and 0 active.

The initial hierarchy counters were 112 page requests, 1 cache hit, 424,928 bytes, and 13,279 loaded entries. Repeated views raised hierarchy page-cache hits to 787. The Rust Worker pool was configured for 4 workers, reached 4 active and 1 queued at peak, and reported 0 failed jobs. The selected scheduler queue peaked at 8 in the medium overview snapshot, within the 32-node policy; the final snapshot had 0 active and 0 queued work. This one run does not attribute the observed browser Long Task to a specific subsystem.

For cancellation, the test held one real point Range response while moving to a 100 km overview. The obsolete read was superseded; final reader counters recorded 1 superseded request, 0 active requests, 0 failures, and 0 fatal layer errors.

## Autzen regression

The existing [issue #68 Rust streaming scenario](issue-68-streaming.md) also passed against the local 81,123,042-byte Autzen sample. At the 1 km near view it rendered 233,908 points in 8 selected nodes and fetched 1,873,542 point-range bytes; first visible update after the camera move was 450 ms. Returning to the near view rendered 233,383 points, fetched 535,427 bytes, and increased decoded-cache hits from 2 to 8. Rotation rendered 195,538 points in 6 nodes without another point-range read. The final rapid stale-work sequence stayed under the 250,000-point budget and ended with no active requests or workers.

## Reproduction

The full E2E run includes the SoFi scenario and the existing Autzen streaming regression:

```bash
npm ci
npm ci --prefix apps/viewer-web
npm run download-samples -- autzen
mkdir -p apps/viewer-web/public/samples
cp samples/local/autzen.copc.laz apps/viewer-web/public/samples/autzen.copc.laz
npm --prefix apps/viewer-web run typecheck
npm --prefix apps/viewer-web test
npm --prefix apps/viewer-web run build
npm --prefix apps/viewer-web run test:e2e
```

The SoFi test is `apps/viewer-web/e2e/sofi-multigb-validation.spec.ts`. It blocks any SoFi request without a `Range` header, verifies every returned range interval, exercises initial/close/medium/high/oblique views, visits two areas and returns to the first, and supersedes a deliberately held point-range response. No SoFi dataset copy is downloaded or stored in the repository. The Autzen sample remains ignored local test data.

## Validation and decision

On the recorded tree, TypeScript typecheck passed, all 310 viewer unit tests passed, the production viewer build passed, and all 12 Playwright E2E tests passed in 4.6 minutes, including SoFi and Autzen. The renderer build emitted the existing browser-externalization notices for Node built-ins and completed successfully.

The multi-GB streaming, camera-driven LoD, point/cache bounds, cache reuse, cancellation, and Autzen regression passed. The overall result remains **LIMITED** until the SoFi source exposes `Content-Range` to browser JavaScript; the shimmed measurement must not be read as proof that the public endpoint is directly browser-ready.

### Independent revalidation on the merged tree

The same checks were rerun on merge commit `8e43a4ecec77a8c8ccc77d39989b64b3c9c308c0` on 2026-10-07. Typecheck passed, all 310 viewer unit tests passed, the production build passed, and all 12 Playwright E2E tests passed in 4.0 minutes, including the SoFi scenario and Autzen streaming regression.

The SoFi rerun reached its first visible points after 60,855 ms and rendered 247,960 points in 15 nodes. It received 144 validated `206` Range responses totaling 6,695,017 bytes (0.330% of the 2,029,696,615-byte object). The point cache peaked at 37,703,850 bytes under the 268,435,456-byte cap; returning to area A reused cached data without another Range request. The controlled cancellation ended with one superseded request, zero failures, and zero active requests. As in the initial run, the Playwright route added the missing `Content-Range` exposure header, so this rerun confirms partial-range streaming and workload bounds while retaining the source CORS limitation above.

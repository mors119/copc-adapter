# Issue 191: Adaptive view distance

## Method

The Cesium browser runs used the Rust backend, a 20,000 m hard distance cap,
32 selected nodes, depth 6, an 8 px screen-space error target, and the existing
250,000-point budget. SoFi used a 256 MiB decoded-point cache. Browser tests
waited for the core's view-distance update counter before recording each camera
state.

The reported prior distance is calculated from the former Cesium rule,
`max(camera height × 6, 2,000 m)`, then limited by the configured hard cap.
It is a formula comparison; the browser runs did not replay a separate
pre-change build.

## View distances

| Dataset and camera | Visible footprint | Adaptive distance | Former heuristic | Change |
| --- | ---: | ---: | ---: | ---: |
| Autzen, 1,000 m downward | 1,229 m | 1,844 m | 6,000 m | 69.3% lower |
| SoFi, 1,500 m downward | 1,840 m | 2,760 m | 9,000 m | 69.3% lower |
| SoFi, 500 m oblique | 995 m | 1,493 m | 3,000 m | 50.2% lower |
| SoFi, 20,000 m overview | reaches the horizon | 20,000 m | 20,000 m capped | hard cap retained |
| SoFi, 100,000 m overview | reaches the horizon | 20,000 m | 20,000 m capped | hard cap retained |

The 20,000 m overview used the cap because the camera frustum reached the
local horizon. The same cap applied to high views, and no selected SoFi nodes
were returned from the high overview.

## Browser workload observations

The Autzen near view selected 8 nodes and rendered 233,908 points. SoFi's
1,500 m downward view selected 13 nodes and rendered 245,390 points; its 500 m
oblique view selected 10 nodes and rendered 239,592 points. These states
produced visible points without changing the point budget.

SoFi's initial load fetched 112 hierarchy pages (424,928 hierarchy bytes and
13,279 entries). Later camera views reused those pages: the page request count
stayed at 112 while the page-cache hit count rose to 674 by the area-A return.
The SoFi route observed 61 successful `206` point/hierarchy responses totaling
6,695,017 bytes, about 0.33% of the 2,029,696,615-byte object. Since the pages
were cached, this run does not establish a before/after page-count reduction;
the measured reduction is in the effective current-view envelope and the
resulting truncated query distance.

The small repeated SoFi area-A/area-B adjustments held the effective distance
at about 8,600 m while the footprint estimate varied by less than 1 m. The
return to area A kept the same range. A material increase expanded the range,
and a material decrease shrank it. Existing replacement, point-budget, cache,
and stale-range checks passed in the same runs.

## Environment and commands

Runs used macOS arm64, Node 26.7.0, Chromium 155.0.8059.79, a 1280 × 720
viewport, and SwiftShader WebGL. Browser timing is specific to this software
renderer and network session.

```sh
cd apps/dev-viewer
PLAYWRIGHT_TEST_PORT=4177 npx playwright test e2e/streaming-performance.spec.ts \
  --grep "records the Autzen Far/Near" --reporter=line

PLAYWRIGHT_TEST_PORT=4176 npx playwright test e2e/sofi-multigb-validation.spec.ts \
  --reporter=line
```

The deterministic view test also verifies that an edge ray's ground-plane
intersection remains inside the generated query bounds after overscan.

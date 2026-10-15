# Issue #254: bounded hierarchy page concurrency

This record evaluates the hierarchy-page serialization identified in [issue
#254](https://github.com/mors119/copc-adapter/issues/254). It compares the
existing serial traversal with a source-local limit of four independent page
loads. The package manifest remains at `0.5.1`; this is a branch validation,
not a release or publish.

## Method

| Setting | Value |
| --- | --- |
| Source | `https://s3.amazonaws.com/hobu-lidar/sofi.copc.laz` |
| Object size / points | 2,029,696,615 bytes / 364,384,576 points |
| Base revision / package | `ce10215` / `@frillab/copc-adapter@0.5.1` |
| Platform | macOS Darwin arm64; Node.js 26.7.0 |
| Browser | Chrome 155.0.8059.79, headless, 1280 × 720, SwiftShader |
| Backend / renderer / style | Rust/WASM / Cesium / elevation |
| Streaming settings | 32 nodes, depth 6, SSE 8, 20,000 m render distance |
| Point / CPU decoded-cache budgets | 250,000 points / 256 MiB |
| Range policy | Strict `206` and `Content-Range` validation; default four active source ranges |

Each measurement used a new Playwright browser context and the same initial
camera path in `e2e/sofi-multigb-validation.spec.ts`. The test route forwarded
real upstream Range requests and added only the missing
`Access-Control-Expose-Headers` needed by browser JavaScript; it did not modify
or synthesize response bytes. Browser state started empty for every run. S3 or
CDN cache state was not controlled, so these are repeated fresh-client runs,
not proof of cold-origin timing. The serial and four-request settings were
measured sequentially, not in randomized pairs.

The only changed variable was the hierarchy page-load concurrency (one versus
four). The same query bounds, source, backend, camera, byte limits, worker pool,
render budgets, and page cache were used. The serial reference uses the same
loader with its internal concurrency set to one, matching the former serial
page-await behavior.

## SoFi results

Four runs were recorded for each setting. Values below are minimum / median /
maximum. Times are wall-clock milliseconds from the initial view request,
except first-visible points, which are measured from navigation start.

| Stage | Serial, limit 1 | Bounded, limit 4 | Median change |
| --- | ---: | ---: | ---: |
| First visible points | 58,280 / 67,171 / 75,150 | 20,441 / 23,374 / 27,999 | 65.2% faster |
| Hierarchy query | 51,514 / 59,250 / 68,372 | 13,495 / 14,518 / 18,364 | 75.5% faster |
| Initial view update settled | 60,227 / 68,618 / 77,260 | 21,063 / 23,652 / 30,130 | 65.5% faster |

The median first high-priority node start moved from 59.29 s to 14.56 s. Its
median ready time moved from 61.96 s to 17.31 s. Query selection remained small
(about 2 ms), decode remained about 0.1–0.2 s, and the root page took about
0.8–1.6 s. These stage boundaries locate most of the observed first-view delay
inside the serial hierarchy query.

The final fully instrumented pair showed:

| Stage | Serial, limit 1 | Bounded, limit 4 |
| --- | ---: | ---: |
| Source open | 1,714 ms | 2,490 ms |
| Metadata load | 1.4 ms | 1.7 ms |
| Root hierarchy page | 1,057 ms | 777 ms |
| Initial hierarchy query | 68,372 ms | 13,495 ms |
| First high-priority node ready | 70,914 ms | 15,724 ms |
| First visible points from navigation | 75,150 ms | 20,441 ms |

The first view had the same settled result in every run: 112 hierarchy page
requests, 424,928 hierarchy bytes, 13,279 loaded entries, and 247,960 points in
15 rendered nodes. The four-request runs reached a measured peak of four
active hierarchy loads. No hierarchy page was omitted.

Across the full SoFi camera path, the test validated every returned upstream
`206` interval and transferred 6,695,017 bytes (0.330% of the object) in both
settings. The byte source coalesced adjacent ranges more often with parallel
page discovery: the route observed 144 responses in the serial runs and 61 in
the four-request runs. This changed request grouping, not the requested byte
set or validation policy. One deliberately held point range was superseded;
there were no failed or active requests at completion.

## Deterministic scheduler comparison

An in-memory hierarchy fixture contains 17 dependent pages, each delayed by
20 ms. Its settled tree is compared byte-for-byte across concurrency one, two,
and four. One recorded run measured 369 ms, 188 ms, and 105 ms respectively;
the measured active peaks were exactly 1, 2, and 4. It also verifies that each
level-two page starts only after its parent response reveals the page
reference. This fixture demonstrates scheduler behavior, not public-network
latency.

Additional hierarchy tests cover bounded and overlapping queries, query
bounds, `maxLevel`, sparse pages, incomplete-child semantics, duplicate page
cache keys, malformed references, traversal cycles, errors, and reset while
page reads are active or queued. Rust and `copc-js` hierarchy parity remains
covered by backend conformance tests.

## Autzen and browser checks

The Autzen browser coverage exercised Rust/Cesium, Rust streaming transitions,
and the `copc-js` constrained-view path. Eight of nine selected browser tests
passed on the first run. The Autzen Far-to-Near test timed out once while
waiting for an update duration; running that test alone immediately afterward
passed in 34.4 s. The separate Autzen streaming-performance gate also passed.
This transient is recorded because it affects repeatability evidence.

The final complete viewer unit run passed all 343 tests after the local
Autzen fixture was downloaded to ignored test-data directories. Focused
hierarchy/controller/debug/backend tests also passed after lifecycle queue
invalidation was added. No Rust or package export files changed.

## Conclusion and limits

The controlled SoFi runs identify hierarchy page serialization as a major
first-view barrier on this setup. A four-load cap materially reduced both
hierarchy query and first-visible-point medians while preserving the exact
settled hierarchy and point workload. Four matches the default per-source
HTTP Range limit, so the loader does not create more active source reads than
the existing Range budget.

This does not establish a universal startup time or a cold-S3 guarantee. The
measurements use one macOS/Chrome/SwiftShader machine, one public source, and an
uncontrolled upstream cache. The old direct-source CORS exposure limitation
also remains; the browser test shim does not remove it. Center-directed page
priority from [issue #189](https://github.com/mors119/copc-adapter/issues/189)
was not added or evaluated here; this change addresses avoidable page
serialization only. Progressive coarse-first rendering remains deferred.

The benchmark test can be rerun with:

```bash
node --import tsx --test --test-reporter=spec test/hierarchy-loader.test.mjs
```

The SoFi and Autzen browser runs use the commands in
[`issue-212-sofi-multigb-streaming.md`](issue-212-sofi-multigb-streaming.md),
with SoFi concurrency varied between one and four for this comparison.

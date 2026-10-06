# Issue 208: Worker-isolated LAZ and Cesium camera responsiveness

## Audit conclusion

The two production backends have different decode ownership:

| Work | `copc-js` | `rust` |
| --- | --- | --- |
| Metadata and hierarchy parsing | `Copc.create` and `Copc.loadHierarchyPage` run from the main-thread source adapter. | `RustCopcReader` calls Rust/WASM metadata and hierarchy parsing on the main thread. |
| HTTP Range I/O and view scheduling | Main thread. | Main thread. Workers receive already-fetched node bytes and do not own network I/O or view selection. |
| LAZ decode | `Copc.loadPointDataView` decodes on the main thread. The performance event reports `blocksMainThread: true`. | With browser `Worker` available, the bounded Rust/WASM Worker pool decodes each node. |
| Coordinate and point preparation | TypeScript runs on the main thread. | Rust/WASM fuses decode, CRS/ECEF preparation, requested-field extraction, and point statistics in the Worker job. |
| Cesium primitive preparation | Main thread. | Main thread after transferred Worker results arrive. |
| GPU rendering | Cesium/WebGL and the browser GPU pipeline. | Same. The adapter does not move camera control or Cesium rendering into a Worker. |

The Rust reader uses its Rust/WASM decode and preparation path on the main
thread when `Worker` is unavailable. A Worker failure is reported as an error;
the backend is not silently retried through `copc-js`.

The contest-supported path is the public Cesium entrypoint with an explicit
`backend: 'rust'` selection in a packed external consumer. This keeps
`copc-js` as the default and preserves both backend choices. See the detailed
[thread ownership audit](../ARCHITECTURE.md#browser-thread-ownership-for-the-production-backends).

## Browser evidence

The packed-consumer Playwright scenario uses the repository Autzen COPC sample
through real HTTP Range requests. It changes the camera from far to near, sends
browser wheel input to the Cesium canvas, and samples the Worker's configured,
active, queued, completed, and peak counters alongside Cesium frame durations
and Long Task API entries. It correlates real wheel input with the following
camera change within 200 ms, requires that camera change to observe an active
Worker, and checks that observed peak concurrency does not exceed the
configured pool size. Frame and Long Task values are recorded as evidence; the
project makes no fixed FPS promise.

The SoFi multi-gigabyte browser run was not part of this issue's measurement.
That broader dataset validation is tracked separately by issue #212.

### Captured run

Captured by `npm run test:pack` in the packed external consumer's explicit
`@frillab/copc-adapter/cesium` production build. The consumer used local headless
Chromium with SwiftShader on 2026-10-06; this is one machine-specific
observation.

| Observation | Result |
| --- | --- |
| Dataset / backend / package route | Autzen / Rust / packed `@frillab/copc-adapter/cesium` entrypoint |
| Worker configured / active / queued at sample | 4 / 1 / 0 |
| Peak active / peak queued | 4 / 1 |
| Jobs submitted / completed / failed / cancelled at sample | 15 / 14 / 0 / 0 |
| Real wheel inputs / wheel inputs during active Worker | 18 / 1 |
| Camera changes during active Worker / wheel-correlated changes during active Worker | 1 / 1 (within 200 ms of wheel input) |
| Cesium frame duration samples: count / median / p95 / max | 81 / 0.8 ms / 17.8 ms / 29.7 ms |
| Long Task API entries / longest observed task | 81 / 264 ms |

The run demonstrates a real wheel-driven camera change while the Worker
reported an active job, with observed active concurrency never above the
configured pool size. The same capture includes a 264 ms main-thread Long Task;
this measurement does not attribute its cause, and Worker isolation does not
cover Cesium primitive updates or other main-thread work. These values describe
one run, not a cross-device rendering guarantee or fixed FPS promise.

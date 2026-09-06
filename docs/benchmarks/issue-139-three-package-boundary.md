# Issue #139 Three.js package boundary

Validation date: 2026-09-06

## Decision

Use a renderer subpath export in the existing package:

```text
@frillab/copc-adapter       -> existing Cesium-compatible entrypoint
@frillab/copc-adapter/three -> renderer-neutral entrypoint for Three.js work
```

Do not split a second npm package at this stage. The repository already has a
validated renderer-neutral core, while the existing package owns the COPC
backends, coordinate transforms, Rust/WASM runtime, Worker factory, and LAZ
asset handling. A subpath keeps those implementation and release paths shared
and preserves the existing root import.

## Criteria

| Criterion | Result | Evidence |
| --- | --- | --- |
| Clean consumer ergonomics | PASS | `npm install @frillab/copc-adapter three`, then import `@frillab/copc-adapter/three` |
| No mandatory unused renderer | PASS | `cesium` and `three` are optional peers; the Three fixture installs no Cesium |
| No duplicated COPC core | PASS | `three.ts` references the existing backend, coordinate, and streaming modules; no Three-specific copy exists |
| Existing Cesium compatibility | PASS | Root `.` export and `CopcCesiumLayer` remain unchanged |
| Vite compatibility | PASS | Clean packed Three/Vite fixture builds using default dependency resolution |
| TypeScript declarations | PASS | Library build emits `dist/three.d.ts` and the export maps it from `./three` |
| Package-owned assets | PASS | The multi-entry build finalizes shared COPC WASM, LAZ WASM, and Worker assets once for both entries |
| Release maintenance | PASS | One package and one version remain; only the public export map and peer metadata expand |

## Public boundary

`src/three.ts` is deliberately independent from `src/index.ts`. The root
entrypoint statically imports Cesium integration to preserve the existing API;
re-exporting it from the Three entry would make Cesium part of the Three module
graph. The Three entry therefore exports only project-owned renderer-neutral
contracts and the shared COPC streaming implementation.

The provisional `CopcThreeLayerOptions` and `CopcThreeLayerSnapshot` names are
declaration-level aliases for the shared core contract. The concrete
`CopcThreeLayer` class belongs to the follow-up Three façade issue and is not
pretended to be implemented by this packaging change.

## Runtime assets

The existing library build is now multi-entry. Asset finalization searches the
whole generated JavaScript output for shared Vite asset imports rather than
assuming that `index.js` owns them. This preserves package-local resolution for
both public entries while retaining the existing stable filenames:

```text
dist/copc_wasm.wasm
dist/laz-perf.wasm
dist/copcWasmAsset.js
dist/lazPerfAsset.js
dist/rustCopcWorkerFactory.js
```

No Cesium asset configuration is used by the Three consumer.

## External consumer

`tests/environments/three-vite/` is copied into a disposable directory by
`npm run test:pack:three`. It installs the generated tarball by package name,
installs `three`, verifies that Cesium is absent, and builds an ordinary Vite
scene that imports only `@frillab/copc-adapter/three`. The fixture is
intentionally build-focused until the Three camera, renderer, styling, and
layer façade issues land.

Validation command:

```bash
npm run test:pack:three
```

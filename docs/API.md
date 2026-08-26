# Library API

`apps/viewer-web/src/index.ts` 가 source public entrypoint 이며, package
consumers should import the generated `@frillab/copc-adapter` package.

## Exported API

### `CopcCesiumLayer`

호출자가 소유한 Cesium `Viewer`에 COPC streaming primitives를 연결하는 public class.

주요 메서드:

- `load()`: URL에서 metadata / hierarchy 로딩
- `unload()`: loaded data와 rendered primitives 정리
- `reload()`: `unload()` 후 configured URL을 다시 로딩
- `attachTo(viewer)`: caller-owned Cesium viewer에 primitives와 camera listener 연결
- `detachFrom()`: Cesium viewer를 destroy하지 않고 primitives와 listener 분리
- `destroy()`: layer resource 와 listener 정리
- `getSnapshot()`: 현재 lifecycle, 선택 node, 렌더링 point 수 조회

`load()`와 `reload()`는 source/context 생성, metadata 및 CRS 검증,
hierarchy 로딩 실패를 각각 project-owned `CopcLoadError`로 reject한다.
`stage`는 `'source' | 'metadata' | 'hierarchy'`, `source`는 원본 configured
URL이며, 지원되는 runtime에서는 원래 오류가 `cause`에 보존된다. 표시용
`message`에서는 URL credential, query, fragment가 제거되므로 demo/debug
panel에 그대로 표시할 수 있다. `CopcSourceError`, `CopcMetadataError`,
`CopcHierarchyLoadError`도 public entrypoint에서 export된다.

### `CopcCesiumLayerOptions`

- `url`: HTTP range request를 지원하는 browser-readable COPC URL
- `pointSize`: Cesium point primitive 크기 (기본값 `3`)
- `colorMode`: `'fixed' | 'elevation' | 'rgb' | 'intensity' |
  'classification'` (기본값 `'fixed'`). `elevation`은 transformed dataset
  height, `rgb`는 source RGB, `intensity`는 node buffer의 intensity 범위,
  `classification`은 categorical palette를 사용한다. 필요한 attribute가
  없으면 fixed cyan으로 fallback한다.
- `debug`: lifecycle debug logging 활성화
- `streaming`: `maxNodes`, `maxDepth`, `refineDistanceMultiplier`,
  `maxRenderDistanceMeters` overrides
- `backend`: optional `CopcBackend`; defaults to `CopcJsBackend`
- `decoder`: optional `CopcPointDecoder`; defaults to the Rust/WASM decoder

### Point field selection

The public `CopcPointFieldSelection` is a `ReadonlySet` of project-owned
fields: `position`, `intensity`, `classification`, and `rgb`. Use
`getCopcPointFieldSelection(colorMode)` to obtain the minimum request for a
render mode. `CopcSource.loadPointDataView(node, fields)` accepts that request
without exposing `copc.js`, LAS, LAZ, or Cesium types.

The returned `CopcPointView.availableFields` reports fields that are both
requested and present in the source. Missing and unrequested fields are
unavailable, never zero-filled. Decode failures propagate as errors. Point
buffers validate that every present attribute array has exactly `pointCount`
values. RGB channel arrays retain source 16-bit precision until the rendering
layer normalizes them for Cesium.

## Quick Start

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from '@frillab/copc-adapter';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
  colorMode: 'rgb',
});

await layer.load();
layer.attachTo(viewer);
```

Install the package together with the Cesium version owned by the host app:

```bash
npm install @frillab/copc-adapter cesium
```

`cesium` is a peer dependency. `copc`, `proj4`, and the browser decoder
runtime are provided by the adapter package; its `npm pack` artifact includes
the Rust/WASM and LAZ decoder assets, so no `/wasm` or `/laz-perf.wasm` web-root
copy is required.

## Layer Lifecycle

```ts
const layer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
});

await layer.load();
layer.attachTo(viewer);

layer.detachFrom();
await layer.reload();
layer.attachTo(viewer);

layer.destroy();
```

## Decoder Boundary

The public entrypoint exports `CopcBackend`, `CopcSource`, `CopcJsBackend`, and
`CopcPointDecoder`. Applications normally use the defaults; alternative
backends and test doubles can be passed through layer options without changing
the controller or renderer.

Rust/WASM handles XYZ
interleaved-buffer conversion, while the TypeScript decoder preserves supported
LAS attributes exposed by the point view.

The public entrypoint also exports the backend-neutral `RandomAccessByteSource`,
`HttpRangeByteSource`, `InMemoryByteSource`, and `RangeSourceError` types for
the Rust/WASM reader boundary. `RustCopcReader` and `RustCopcParseError` are
also exported for callers that need to parse LAS/COPC metadata and the root
hierarchy through an injected random-access source. It does not decode point
chunks and does not replace `CopcJsBackend` as the default backend.

`CopcPointBuffer`와 `GeographicPointBuffer`는 optional `intensity`,
`classification`, `red`, `green`, `blue` typed arrays를 보존한다. source point
format에 없는 attribute는 생성하지 않는다. RGB/intensity/classification
style은 해당 typed arrays를 직접 사용하며, attribute 누락 시 fixed color로
fallback한다.

- `copc.js`: metadata, hierarchy, point view 로딩
- `copc-wasm`: X/Y/Z -> interleaved point buffer conversion
- `viewer-web` decoder: available LAS attributes -> optional typed arrays
- `viewer-web`: streaming selection, CRS transform, Cesium rendering

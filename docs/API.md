# Library API

`apps/viewer-web/src/index.ts` 가 현재 public entrypoint 이다.

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

### `CopcCesiumLayerOptions`

- `url`: HTTP range request를 지원하는 browser-readable COPC URL
- `pointSize`: Cesium point primitive 크기 (기본값 `3`)
- `debug`: lifecycle debug logging 활성화
- `streaming`: `maxNodes`, `maxDepth`, `refineDistanceMultiplier`,
  `maxRenderDistanceMeters` overrides

## Quick Start

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from 'viewer-web';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
});

await layer.load();
layer.attachTo(viewer);
```

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

현재 public API 는 renderer / viewer lifecycle 에 집중하고, 내부 decoder hot path 는 Rust + WASM 으로 교체되어 있다.

- `copc.js`: metadata, hierarchy, point view 로딩
- `copc-wasm`: X/Y/Z -> interleaved point buffer decode
- `viewer-web`: streaming selection, CRS transform, Cesium rendering

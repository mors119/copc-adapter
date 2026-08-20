# Examples

## Browser App Example

실행 가능한 최소 예제는
[`apps/viewer-web/src/main.ts`](../apps/viewer-web/src/main.ts) 이다.

동작 흐름:

1. Cesium `Viewer` 생성
2. `CopcCesiumLayer.load()` 호출
3. `attachTo(viewer)`로 layer 연결
4. camera 기반 streaming selection 시작
5. Rust + WASM point decoder 경유

## HTML Skeleton

```html
<div id="cesium-container"></div>
<script type="module" src="/src/main.ts"></script>
```

## Manual Integration Example

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from './src/index.ts';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
});

await layer.load();
layer.attachTo(viewer);

console.log(layer.getSnapshot());

layer.detachFrom();
layer.destroy();
```

## Build Note

`npm --prefix apps/viewer-web run dev`, `test`, and `build` prepare the
`copc-wasm` release asset. The default browser URL also requires the downloaded
Autzen sample at `apps/viewer-web/public/samples/autzen.copc.laz`; see the
[README](../README.md#run-the-local-demo) for the complete setup sequence.

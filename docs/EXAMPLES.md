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
import { CopcCesiumLayer } from '@mors119/copc-cesium';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
  colorMode: 'rgb',
});

await layer.load();
layer.attachTo(viewer);

console.log(layer.getSnapshot());

layer.detachFrom();
layer.destroy();
```

기존 cyan rendering을 유지하려면 `colorMode: 'fixed'`를 지정하거나
`colorMode`를 생략한다. 높이 차이를 시각화하려면 `colorMode: 'elevation'`을
사용한다. Elevation mode는 streaming node마다 색 범위가 바뀌지 않도록 COPC
metadata의 전체 Z 범위를 transformed Cesium height로 변환해 사용한다.
source RGB를 사용하려면 `rgb`, 반사 강도를 grayscale로 보려면 `intensity`,
LAS classification을 categorical palette로 보려면 `classification`을 사용한다.
필요한 source attribute가 없는 경우 기존 cyan으로 fallback한다. Intensity
범위는 각 streaming node의 loaded point buffer에서 계산한다.

## Build Note

`npm --prefix apps/viewer-web run dev`, `test`, and `build` prepare the
`copc-wasm` release asset. Library builds include the decoder assets in `dist`.
The default browser URL requires the downloaded Autzen sample at
`apps/viewer-web/public/samples/autzen.copc.laz`; see the
[consumer fixture](../tests/environments/cesium-vite/README.md) for packed
external-consumer validation.

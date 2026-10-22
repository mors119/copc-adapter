# Examples

## Browser App Example

실행 가능한 최소 예제는
[`apps/dev-viewer/src/main.ts`](https://github.com/mors119/copc-adapter/blob/main/apps/dev-viewer/src/main.ts) 이다.

동작 흐름:

1. Cesium `Viewer` 생성
2. `CopcCesiumLayer.load()` 호출
3. `attachTo(viewer)`로 layer 연결
4. camera 기반 streaming selection 시작
5. 선택한 backend의 project-owned point buffer 경유

## HTML Skeleton

```html
<div id="cesium-container"></div>
<script type="module" src="/src/main.ts"></script>
```

## Manual Integration Example

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from '@frillab/copc-adapter';

const viewer = new Cesium.Viewer('cesium-container');
const layer = new CopcCesiumLayer({
  url: '/samples/autzen.copc.laz',
  backend: 'rust',
  colorMode: 'rgb',
});

await layer.load();
layer.attachTo(viewer);

console.log(layer.getSnapshot());
console.log(layer.getSelectedPoint()); // undefined until a rendered point is picked

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

## User-Supplied Vertical Grid (CesiumJS)

The API guide has a complete offline `File` example for loading a documented
GTX grid, verifying its SHA-256, and enabling it through
`CopcCesiumLayerOptions.verticalTransform`. Supply only a grid whose source
vertical CRS, WGS 84 horizontal frame, `h - H` sign, units, NoData value,
coverage, and usage terms are documented. No EGM2008 or KNGeoid24 model is
bundled or automatically selected. See [Explicit vertical CRS grid
conversion](API.md#explicit-vertical-crs-grid-conversion).

## Opt-in Cesium Terrain Height Estimate

Terrain is independent from imagery and the ellipsoid. Configure an application
owned TerrainProvider before creating the Viewer; an unauthenticated local
quantized-mesh service can expose a `layer.json` endpoint under a service root:

```ts
const terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(
  'http://localhost:8080/terrain',
);
const viewer = new Cesium.Viewer('cesium-container', { terrainProvider });
```

After the layer is loaded and attached, explicitly pick a ground point and
request an estimate. The result is read-only. Present its heights, delta,
datum, provider label and warnings; after a separate approval, recreate the
layer from the same source using the returned effective `heightOffsetMeters`.
The adapter checks that the estimate still belongs to the selected point and
active TerrainProvider. See [Explicit Cesium Terrain residual estimate in the
API guide](API.md#explicit-cesium-terrain-residual-estimate) for the vertical
reference checks, error cases, cancellation semantics and composition with
`verticalTransform`.

In the Dev Viewer, enter the Terrain service root (the folder containing
`layer.json`), press **Apply Settings**, pick a COPC point, confirm ground
status when needed, then use **Estimate
residual** and review the preview. **Apply proposed correction** is enabled
only for a current, actionable estimate. The default remains ellipsoid-only.

## Build Note

The dev viewer prepares the `copc-adapter-wasm` asset before running. Package
unit tests use `packages`; library builds include the decoder
assets in `dist`.
The default browser URL requires the downloaded Autzen sample at
`apps/dev-viewer/public/samples/autzen.copc.laz`.

# API 빠른 참조

이 페이지는 CesiumJS에서 가장 자주 사용하는 public API만 한글로 빠르게 찾기 위한 문서입니다.

전체 타입과 세부 계약은 [영문 Public API](../API)를 기준으로 합니다.

## CopcCesiumLayer

```ts
import { CopcCesiumLayer } from '@frillab/copc-adapter/cesium';
```

### 생성

```ts
const layer = new CopcCesiumLayer({
  url,
});
```

표시 옵션을 생략하면 3픽셀 고정 cyan, `copc-js` backend와 현재 streaming 기본값을
사용합니다. `url`에는 HTTP(S) URL 외에 브라우저 `File` 또는 `Blob`도 전달할 수
있으며, 필요한 구간만 브라우저 안에서 읽습니다. 자세한 기본값과 precedence는
[Public API](../API)의 defaults matrix를 참고하세요.

`opacity`는 0부터 1까지의 layer 단위 alpha를 지정합니다. 생략하면 기존 renderer의
표시를 유지합니다. Cesium point primitive은 스타일 색의 alpha를 유지하고 batched
shader는 기존 불투명 alpha를 사용하며, Three.js material은 기존 기본값 `0.9`를
사용합니다. 값을 지정하면 color mode와 분류 색상에 상관없이 해당 값이 최종 alpha가
됩니다.

`maxRenderedPoints`는 새 코드에서 top-level 위치를 권장합니다. 기존
`streaming.maxRenderedPoints`도 사용할 수 있지만 top-level 값이 함께 지정되면 top-level
값이 우선합니다.

`rangeValidation`은 HTTP source의 `'strict' | 'head-fallback'` 정책이며
기본값은 `'head-fallback'`입니다. 두 모드 모두 `206`, 정확한 body 길이,
읽을 수 있는 잘못되거나 요청 범위와 다른 `Content-Range`의 거부를 요구합니다.
기본 모드에서 JavaScript가 `Content-Range`를 읽지 못하면 성공한 `HEAD`의
읽을 수 있는 `Content-Length`로 크기와 요청 범위를 확인하고 응답 body 길이도
정확히 검사합니다. 읽을 수 있는 validator와 감지 가능한 크기/validator 변경은
거부하지만 반환된 byte offset이나 같은 크기의 객체가 그대로 유지되는지는 증명하지
못합니다. fallback 검증이 성공한 첫 read에서 HTTP source instance마다 한 번 경고합니다.
`rangeValidation: 'strict'`는 읽을 수 있고 유효하며 요청 범위와 일치하는
`Content-Range`를 필수로 요구하고, `HEAD` fallback을 사용하지 않습니다. header를
읽을 수 없으면 거부합니다. strict도 body 길이, 알려진 크기, 읽을 수 있는 validator,
읽을 수 있는 비-identity content encoding을 확인합니다. 교차 출처 JavaScript는
`Content-Encoding`이 없거나 CORS에 숨겨진 경우를 구별할 수 없으므로 읽을 수 있는
비-identity 값만 거부할 수 있습니다. HTTP 검사에는 암호학적 무결성 검증이 포함되지
않으며, 일관된 metadata를 조작하는 악의적인 서버를 막지 못합니다. 이 옵션은 로컬
`File`/`Blob`과 사용자 제공 `RandomAccessByteSource`에는
영향을 주지 않습니다. Three.js layer와 streaming core에도 같은 HTTP 정책이 있습니다.

`maxRangeBytes`는 HTTP range 응답 하나의 최대 크기이며 기본값은 64 MiB입니다.
큰 metadata, hierarchy page 또는 point chunk를 읽어야 할 때 명시적으로 높일 수
있습니다. 양의 안전한 정수라면 고정 상한은 없습니다. 값을 높이면 메모리 사용량도
증가할 수 있습니다.

`maxConcurrentRangeRequests`는 source마다 동시에 실행할 HTTP range 요청 수이며
기본값은 4입니다. 작은 range가 여러 개일 때 병렬성을 높일 수 있도록 양의 안전한
정수로 설정할 수 있습니다. 두 설정의 조합이 동시에 진행되는 응답 buffer를
제한하며, 기본 설정에서 최대 약 256 MiB를 사용합니다. 둘 중 하나를 높이면 가능한
메모리 사용량도 늘어납니다.

### CRS metadata 진단

두 기본 backend의 `getMetadata()`는 원본 `wkt`와 버전이 지정된
`crsDiagnostic`을 제공합니다. 여기에는 수평/수직 CRS 이름과 식별자, 선언된 단위
(국제 foot과 미국 측량 foot 구분), 명시된 수평 축 순서, WKT1/WKT2 metadata 문법
지원 여부, evidence 출처와 안정된 reason code가 포함됩니다. `heightKind`는
`ellipsoidal`, `gravity-related/orthometric`, `local/unknown` 중 하나이며
확실성은 `explicit`, `inferred`, `unknown`으로 표시됩니다.
두 reader는 첫 WKT VLR을 선택하고, VLR WKT가 없을 때만 첫 WKT EVLR을 사용합니다.
여러 WKT record 내용이 다르면 `conflicting-source-wkt`를 보고하고 해당 precedence의
첫 값을 선택된 원본으로 유지합니다.

좌표 범위, 국가, 출력 좌표 라벨 또는 WGS84/ECEF 변환 결과로 CRS나 높이 기준을
추론하지 않습니다. 수직 의미를 증명할 수 없으면 `local/unknown`입니다. WKT 문법
인식은 metadata parsing을 뜻합니다. `transformSupport: "backend-dependent"`는
인식된 모든 정의를 변환할 수 있다는 보장이 아닙니다. 기존 렌더링 기본 동작과
원본 좌표는 바뀌지 않습니다. 정밀한 수직 datum 변환을 요청하는 앱은 source metadata가
부족하거나 호환되지 않을 때 실패하는 기존 명시적 변환 경로를 사용해야 합니다.

현재 명시적 그리드 변환은 지원되는 WKT1 `COMPD_CS`와 WKT2 `COMPOUNDCRS` 일부를
처리합니다. WKT2에서는 `VERTCRS`의 축 단위를 읽고, 명시된 동/서 및 북/남 축 순서를
투영 입력 순서로 정규화합니다. 이 지원 범위는 임의의 WKT2, 기준계 또는 epoch 변환을
포함하지 않습니다. Autzen의 EPSG:6360 NAVD88과 NOAA GEOID18은 source realization과
좌표 epoch가 확인되기 전까지 변환하지 않습니다. 자세한 근거는
[수직 CRS 및 GEOID18 검증 기록](../proposals/issue-244-vertical-crs-geoid-grid.md)을
참조하세요.

## Lifecycle

```ts
await layer.load();
layer.attachTo(viewer);

layer.detachFrom();
await layer.reload();
layer.unload();
layer.destroy();
```

### load

source metadata와 root hierarchy를 준비합니다. Viewer가 이미 연결되어 있으면
Cesium layer의 `load()`는 기존 동작대로 초기 streaming view도 기다립니다.

### attachTo

기존 Cesium Viewer에 연결합니다.

### detachFrom

Viewer에서 분리하지만 source 전체를 반드시 폐기하는 동작은 아닙니다.

### unload

현재 로드된 COPC data와 layer-owned 상태를 정리합니다.

### destroy

layer를 영구적으로 종료합니다.

`metadataReady` 이벤트는 metadata와 root hierarchy가 준비된 즉시 발생하므로
`load()` Promise의 완료와 별개입니다. 초기 이벤트를 받으려면 `load()`보다 먼저
listener를 등록하세요.

### Metadata bounds와 camera 이동

```ts
const sphere = layer.boundingSphere;
if (sphere) {
  const completed = await layer.zoomTo(
    new Cesium.HeadingPitchRange(0, -0.5, 0),
  );
}
```

`boundingSphere`는 현재 렌더링된 node가 아니라 COPC metadata 전체 bounds를 지원되는
CRS 경로로 WGS84 ECEF 미터 단위로 변환합니다. `heightOffsetMeters`는 한 번 적용되며
getter는 내부 값을 보호하는 clone을 반환합니다. 잘못된 bounds, 지원되지 않는 CRS,
제한 범위를 벗어난 projection은 `undefined`입니다. 현재 제한은 지원되는 WKT1
geographic/projected 변환과 root WKT2 `GEOGCRS` 변환, projected 축마다 최대 2,000 km,
수직 범위 최대 1,000 km입니다.
grid sampling과 padding을 사용하지만 임의 projection singularity에 대한 보편적인
수학적 보장을 뜻하지는 않습니다.

`zoomTo()`는 명시적인 호출에서만 Cesium bounding-sphere flight를 시작합니다. 완료는
`true`, 취소·대체·detach·unload·reload·destroy는 `false`이며, 시작할 수 없는 상태나
Cesium 오류는 reject됩니다. 기존 최초 자동 `flyToDataset()`은 유지됩니다.
`layer.zoomTo()`, 최초 자동 framing, native `viewer.zoomTo(...)`는 서로 별도 동작이며
`viewer.zoomTo(layer)`는 지원하지 않습니다.

### 명시적 Cesium Terrain 잔차 추정

이 기능은 선택한 지면 점 하나와 Cesium Terrain 높이를 비교하는 opt-in 진단입니다.
Imagery는 색상/텍스처이므로 높이를 제공하지 않습니다. 기본 ellipsoid의 높이 0도 실제
지면 측량값이 아닙니다. 3D Tiles에는 지붕, 벽, 식생이 포함될 수 있으므로 이 기능은
3D Tiles를 샘플링하지 않습니다.

애플리케이션이 직접 TerrainProvider를 만들어 Viewer에 전달합니다. 예를 들어 인증정보가
없는 로컬 quantized-mesh 서비스의 root URL을 사용할 수 있습니다. Cesium `fromUrl`이
해당 경로에서 `layer.json`을 찾습니다.

```ts
const terrainProvider = await Cesium.CesiumTerrainProvider.fromUrl(
  'http://localhost:8080/terrain',
);
const viewer = new Cesium.Viewer('cesium-container', { terrainProvider });
```

Adapter는 consumer-owned Viewer의 provider를 바꾸거나 파괴하지 않습니다. 실제 지면 점을
선택한 뒤 추정을 요청합니다.

```ts
const anchor = layer.getSelectedPoint();
if (!anchor) throw new Error('먼저 현재 layer의 점을 선택하세요');

const estimate = await layer.estimateTerrainHeightAlignment(anchor, {
  groundConfirmed: true, // class 2가 아니면 직접 확인한 경우에만 설정
  signal: abortController.signal,
});

if (estimate.status === 'ready' && estimate.actionable &&
    layer.isTerrainHeightAlignmentEstimateCurrent(estimate)) {
  // preview 후 사용자가 승인한 경우에만 기존 heightOffsetMeters로 재구성
  const approvedHeightOffsetMeters =
    estimate.effectiveProposedHeightOffsetMeters;
}
```

추정식은 `Terrain 높이 - 현재 표시 높이`입니다. `heightOffsetMeters` 값은 결과의
`existingHeightOffsetMeters`에 포함되고, 승인용 전체 값은
`effectiveProposedHeightOffsetMeters`입니다. 원본 source XYZ는 바뀌지 않습니다.
선택 점은 layer 소유여야 하며 좌표가 유한해야 합니다. LAS class 2는 ground로 확인된
분류로 받아들이고, 다른 분류나 분류 누락은 호출자가 지면임을 직접 확인해야 합니다.
선택, source generation, Viewer 또는 TerrainProvider가 바뀌면 결과는 stale 처리됩니다.

현재 표시 높이와 Terrain 높이는 모두 WGS 84 ellipsoidal-height 참조여야 합니다.
NAVD88 높이는 단위를 미터로 바꾸어도 orthometric height이므로 호환되지 않습니다.
유효한 #244 `verticalTransform`이 현재 source WKT와 일치하거나 source가 지원되는
ellipsoidal vertical reference를 명시해야 합니다. 불확실하면 결과는 `uncertain`이며
Apply할 수 없습니다. Terrain 잔차로 geoid 변환 누락을 숨기면 안 됩니다.

source가 ellipsoidal height를 직접 선언한 경우에는 root WKT2 `GEOGCRS`가 EPSG:4979이고,
직접 좌표계가 `ellipsoidal`, 3차원이며 `UP` 축을 포함할 때만 인식합니다. EPSG:4979는
독립 vertical CRS가 아니라 3D geographic CRS이므로 WKT1 `VERT_CS`에 이 코드를 붙인
선언은 신뢰하지 않습니다.

TerrainProvider의 tile availability가 없거나 coverage가 없고, 요청이 실패하거나 시간
제한을 넘으면 추정은 적용 불가입니다. Cesium sampler 자체는 AbortSignal을 받지 않으므로
취소는 결과를 버리며 이미 시작한 요청을 강제로 멈추지 못합니다. 한 Viewer에 동시에
한 번의 추정만 허용하고, 기본 대기 제한은 30초(최대 60초)입니다. Terrain LOD, 출처와
anchor 품질 때문에 survey-grade 위치를 보장하지 않습니다.

Dev Viewer에서는 `layer.json`이 들어 있는 Terrain 서비스 root URL을 입력하고
**Apply Settings**를 누릅니다. 끝에 `/layer.json`을 붙여도 됩니다. 이어서 COPC 점 선택 →
지면 상태 확인 → **Estimate residual** → preview 검토 → **Apply proposed correction** 순서로
진행합니다. 기본은 imagery가 있을 수 있는 ellipsoid-only 모드입니다. 승인하면 원본
COPC에서 layer를 재구성하므로 범위 읽기, LAZ 디코딩, Worker 준비, renderer 업로드 및
잠시 두 세션이 함께 존재하는 비용이 발생할 수 있습니다.

용어를 구분하면 #244는 검증된 수직 CRS/geoid 변환, #237 `heightOffsetMeters`는 수동의
균일 보정, #305 Terrain 잔차는 명시적으로 고른 지면 anchor에 대한 배치 제안입니다.
Terrain imagery와 arbitrary 3D Tiles는 서로 대체할 수 없습니다.

### Layer lifecycle events

```ts
layer.loadProgress.addEventListener(
  (queuedNodeCount, activeNodeCount, viewGeneration) => {
    console.log({ queuedNodeCount, activeNodeCount, viewGeneration });
  },
);
layer.metadataReady.addEventListener((metadata, loadGeneration) => {
  console.log({ metadata, loadGeneration });
});
layer.viewSettled.addEventListener((viewGeneration, selectedNodeKeys) => {
  console.log({ viewGeneration, selectedNodeKeys });
});
```

`loadProgress`는 scheduling 대기 중인 node 수와 현재 node 작업 수입니다. HTTP 요청 수나
byte progress가 아닙니다. `firstVisible`은 첫 nonempty node가 renderer에 commit된
시점이며 GPU frame이나 화면 pixel의 가시성을 보장하지 않습니다. layer를 숨겨도 이
renderer-commit milestone은 발생할 수 있습니다. `viewSettled`는 현재 view에서 선택된
작업이 적용된 시점이며 전체 COPC source의 다운로드 완료를 의미하지 않습니다.
`viewCancelled`는 active view가 무효화될 때만 `camera-change`, `detach`, `unload`,
`reload`, `destroy` 이유 중 하나로 발생합니다. `error`는 load와 background view 오류를
구분하며 기존 Promise rejection을 유지합니다.

Public `loadGeneration`과 `viewGeneration`은 서로 독립적으로 증가합니다. 한 active
view에는 `viewSettled`, `viewCancelled`, `error` 중 하나의 terminal outcome만 발생합니다.
Cesium은 native `Cesium.Event`를 사용하고, listener 예외는 `console.error`로 보고되어
streaming 상태를 중단하지 않습니다. `destroy()` 이후 해당 layer event는 더 전달되지
않습니다.

## CopcThreeLayer event 및 native bounds

Three.js layer는 `show`, `zoomTo()`, `flyTo()`를 추가하지 않습니다. visibility는
`layer.getRoot().visible`로 제어하고 앱은 기존 render loop에서 `layer.update()`를
호출합니다. 이벤트는 `progress`, `metadataready`, `firstvisible`, `viewsettled`,
`viewcancelled`, `error`를 지원합니다.

최소 생성과 연결 코드는 다음과 같습니다. 애플리케이션이 scene, camera, renderer 및
렌더 루프를 소유합니다.

```ts
import * as THREE from 'three';
import { CopcThreeLayer } from '@frillab/copc-adapter/three';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20_000);
const renderer = new THREE.WebGLRenderer();
const layer = new CopcThreeLayer({ url });

await layer.load();
layer.attachTo({ scene, camera, renderer });

function animate() {
  requestAnimationFrame(animate);
  void layer.update();
  renderer.render(scene, camera);
}
animate();
```

Three.js도 3픽셀 고정 cyan을 기본으로 사용하며 `url`에 로컬 `File`/`Blob`을 받을 수
있습니다. layer 생성 옵션의 `renderer`는 사용자 정의 point renderer이고,
`attachTo({ ..., renderer })`의 `renderer`는 viewport 크기를 읽기 위한
application-owned WebGL renderer입니다.

```ts
import * as THREE from 'three';
import {
  CopcThreeLayer,
  type CopcThreeLayerViewSettledEvent,
} from '@frillab/copc-adapter/three';

const layer = new CopcThreeLayer({ url });
const onSettled = (event: CopcThreeLayerViewSettledEvent) => {
  console.log(event.viewGeneration, event.selectedNodeKeys);
};
layer.addEventListener('viewsettled', onSettled);
layer.attachTo({ scene, camera, renderer });
await layer.load();
```

`layer.getRoot().updateWorldMatrix(true, true)` 후
`new THREE.Box3().setFromObject(layer.getRoot())`는 현재 instantiate된 root geometry의
world-space bounds를 반환합니다. 전체 COPC dataset extent는 아닙니다. Three layer는
Scene, Camera, Renderer 또는 application render loop를 소유하지 않습니다.

## Style

```ts
layer.setStyle({
  colorMode: 'elevation',
});
```

```ts
layer.setStyle({
  colorMode: 'classification',
  classificationFilter: {
    include: [2, 6],
  },
});
```

```ts
const style = layer.getStyle();
```

Cesium과 Three.js layer 모두 constructor의 `opacity`와 runtime
`setOpacity(opacity)`를 지원합니다. 변경은 현재 layer가 소유한 renderer resource와 이후
stream된 node에 적용되며 COPC point 데이터를 다시 읽거나 decode하지 않습니다. `0`은
해당 layer의 point picking을 막고 현재 선택을 지웁니다. 다른 layer, imagery, terrain 또는
application renderer의 전역 상태는 변경하지 않습니다.

```ts
const layer = new CopcThreeLayer({ url, opacity: 0.5 });
layer.setOpacity(0.25);
```

투명도는 각 renderer의 일반 blending 및 depth 동작을 따릅니다. adapter는 투명 point 정렬,
layer 사이 draw order 조정 또는 order-independent transparency를 구현하지 않으므로
겹치는 layer와 terrain의 합성 결과는 renderer와 scene 순서에 따라 달라질 수 있습니다.
사용자 정의 renderer에 opacity를 지정하려면 `setOpacity()`를 구현해야 합니다.

## Diagnostics

```ts
const snapshot = layer.getSnapshot();
const metadata = layer.getMetadata();
const hierarchy = layer.getHierarchyDiagnostics();
const pointCache = layer.getPointCacheDiagnostics();
const selected = layer.getSelectedPoint();
```

### getSnapshot()

현재 lifecycle, 선택된 node, 렌더링된 point, scheduling/Worker/Range 관련 diagnostic을 확인할 때 사용합니다.

### getHierarchyDiagnostics()

hierarchy page request와 cache 상태를 확인할 때 사용합니다.

### getPointCacheDiagnostics()

프로젝트가 보관하는 decoded CPU point buffer의 cache 통계를 확인합니다.

이 값은 **브라우저 전체 메모리나 GPU 메모리**가 아닙니다.

## Backend

기본 production backend는 `copc-js`입니다.

Rust/WASM 경로를 명시적으로 선택하려면:

```ts
const layer = new CopcCesiumLayer({
  url,
  backend: 'rust',
});
```

Rust backend는 브라우저 Worker를 사용할 수 있는 환경에서 bounded Worker pool을 통해 node decode와 point preparation을 수행합니다.

Rust backend가 실패했다고 해서 자동으로 `copc-js`로 조용히 바뀌지 않습니다.

## source probe

```ts
import { probeCopcSource } from '@frillab/copc-adapter';

const result = await probeCopcSource(url);
```

Range/CORS/COPC 형식을 먼저 점검하고 싶을 때 사용합니다.
레이어와 같은 기본 `head-fallback` 검증을 사용합니다. strict 정책을 진단하려면
`probeCopcSource(url, { rangeValidation: 'strict' })`를 호출합니다.
결과의 `validationLevel`은 `strict`, `compatibility-limited`, `incompatible`,
`unknown` 중 하나입니다.

## API를 변경할 때 볼 파일

- `packages/cesium/layer/CopcCesiumLayer.ts`
- `packages/cesium/layer/CesiumLayerController.ts`
- `packages/core/streaming/CopcStreamingController.ts`
- `packages/cesium/style/CesiumPointStyle.ts`

::: warning Public API 변경
새 메서드나 옵션을 추가할 때는 구현 편의보다 사용자가 실제로 필요로 하는 안정적인 계약인지 먼저 판단하세요. 내부 diagnostics나 renderer 세부 구현을 그대로 public API로 노출하지 않는 것이 좋습니다.
:::

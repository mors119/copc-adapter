# 색상 표현과 점 선택

COPC Adapter는 현재 다음 색상 모드를 지원합니다.

- `fixed`
- `rgb`
- `elevation`
- `intensity`
- `classification`

## 생성할 때 지정

```ts
const layer = new CopcCesiumLayer({
  url,
  colorMode: 'rgb',
  attributeLoading: 'required',
});
```

Cesium은 기본적으로 `attributeLoading: 'all'`로 동작하며 RGB, intensity,
classification을 cache에 유지합니다. `required`는 초기 `colorMode`에 필요한
standard LAS attribute만 유지합니다. `fixed`와 `elevation`은 추가 attribute가
필요하지 않습니다. 초기 classification filter를 사용한다면 색상 모드와 관계없이
classification도 유지합니다.

```ts
const layer = new CopcCesiumLayer({
  url,
  colorMode: 'rgb',
  attributeLoading: 'required',
  classificationFilter: { include: [2, 6] },
  pointFields: new Set(['intensity']),
});
```

`pointFields`는 초기 style에 더해 inspection용 standard attribute를 명시적으로
유지합니다. Extra LAS dimension을 요청하지는 않습니다.

## 실행 중 변경

Cesium layer는 현재 표시 중인 node의 cached decoded point buffer를 사용해 style을 변경할 수 있습니다.

```ts
layer.setStyle({
  colorMode: 'classification',
});
```

고도 색상은 prepared display height(WGS 84 타원체 높이, 미터)를 기준으로 합니다.
기본 범위는 vertical transform과 `heightOffsetMeters`를 반영한 전체 dataset 범위이며,
`elevationRange`로 직접 지정할 수 있습니다. `elevationStyle`은 정규화된 RGB(A)
palette와 `linear`/`step` 보간을 설정합니다.

```ts
layer.setStyle({
  colorMode: 'elevation',
  elevationRange: { min: 20, max: 120 },
  elevationStyle: {
    interpolation: 'step',
    palette: [
      { position: 0, color: { red: 0, green: 0, blue: 0.3 } },
      { position: 0.5, color: { red: 0, green: 0.8, blue: 0.3 } },
      { position: 1, color: { red: 1, green: 0, blue: 0 } },
    ],
  },
});
```

Three.js는 같은 설정을 `CopcThreeLayer` constructor에 전달합니다. 스타일을 바꿀 때는
layer를 새 설정으로 다시 만듭니다. 이 색상 의미는 absolute ellipsoidal display
height이며 dataset-relative 또는 terrain height above ground는 포함하지 않습니다.

현재 style 확인:

```ts
console.log(layer.getStyle());
```

## Classification 필터

특정 LAS classification만 표시:

```ts
layer.setStyle({
  classificationFilter: {
    include: [2, 6],
  },
});
```

특정 classification 제외:

```ts
layer.setStyle({
  classificationFilter: {
    exclude: [7, 18],
  },
});
```

필터 해제:

```ts
layer.setStyle({
  classificationFilter: null,
});
```

classification code는 `0`부터 `255`까지의 정수입니다.

## 중요한 성능 의미

필요한 attribute가 cache에 남아 있다면 `setStyle()`은 다음 작업을 다시 하지 않습니다.

- metadata reload
- hierarchy reload
- point chunk Range fetch
- LAZ decode

즉 **같은 점 데이터를 다시 다운로드하지 않고 표현만 변경**할 수 있습니다.

`required` 모드에서 초기 선택에 없는 attribute가 필요한 style/filter를 적용하면
동기식 오류가 발생하고 이전 style과 selection을 유지합니다. 해당 attribute를
초기 `colorMode` 또는 `classificationFilter`에서 요청하거나 `pointFields`에
추가하세요. 모든 style field가 필요하면 `attributeLoading: 'all'`을 사용해
layer를 다시 만드세요.
source에 실제 attribute가 없는 경우에는 기존 cyan fallback을 유지합니다.
단, `required`에서 요청하지 않은 attribute는 source에 있는지 검사되지 않으므로
오류 메시지가 source availability를 확인하지 않았음을 구분해 안내합니다.

`required`는 준비된 point buffer와 cache의 attribute 메모리를 줄입니다. Rust/WASM
backend는 선택되지 않은 LAS attribute의 decompression도 건너뜁니다. copc-js backend는
완전한 point view를 먼저 decode하므로 준비 및 보관 메모리는 줄지만 LAZ attribute
decompression은 줄지 않습니다. Picking은 계속 가능하지만 보관하지 않은 attribute는
point inspection 결과에 포함되지 않습니다.

다만 현재 보이는 node의 decoded buffer가 cache에서 이미 제거된 상태라면, `setStyle()`이 몰래 다시 다운로드하는 대신 오류를 발생시키는 것이 현재 계약입니다.

## Workbench Advanced 설정

Playground와 Dev Viewer의 **Advanced · Attributes**에서 Cesium의 `all` 또는
`required`를 선택하고, `required` 모드에서는 inspection에 추가로 보관할 RGB,
intensity, classification을 선택할 수 있습니다. 화면의 안내에는 현재 pending style과
filter가 요구하는 field 및 pick metadata field가 표시됩니다. 이 설정은 constructor
옵션이므로 Apply/reload가 필요합니다. 적용 후 보관하지 않은 field를 요구하는 style은
기존 style을 유지하며, field를 다시 가져오지 않았다는 안내를 표시합니다.

두 host의 **Advanced · Cache**는 `coordinateCacheLayout`을 제공합니다. 기본 `E`는
ECEF XYZ와 prepared height를 유지해 좌표 기준 32 bytes/point를 사용합니다. Geographic
좌표는 ECEF에서 계산하며 exact Source XYZ는 보관하지 않습니다. `E`에서 exact Source XYZ도
cache-only query와 inspection에 사용하려면 `retainSourceCoordinatesForQueries`를 켜세요.
point당 24 bytes가 추가되고 `maxPointCacheBytes`에 포함됩니다. `A`는 exact Source,
Geographic, ECEF 세 좌표를 유지해 72 coordinate bytes/point를 사용합니다. Cache 설정도
Apply/reload가 필요합니다. 자세한 공개 타입과 기본값은 [영문 API 문서](../API)를 참고하세요.

## Point picking

`onPointPicked` callback을 사용할 수 있습니다.

```ts
const layer = new CopcCesiumLayer({
  url,
  colorMode: 'rgb',
  onPointPicked(point) {
    console.log(point);
  },
});
```

또는 현재 선택 상태를 조회할 수 있습니다.

```ts
const point = layer.getSelectedPoint();
```

사용 가능한 경우 다음과 같은 정보를 확인할 수 있습니다.

- node key
- node level
- point index
- longitude / latitude / height
- source XYZ
- ECEF/world coordinate
- intensity
- classification
- RGB
- 요청한 extra dimensions

필터로 선택된 점이 숨겨지면 stale selection을 유지하지 않고 선택을 정리합니다.

## 화면 예시

기존 repository asset:

- `docs/assets/copc-rgb.webp`
- `docs/assets/copc-elevation.webp`
- `docs/assets/copc-classification.webp`

## 관련 구현

- `packages/cesium/style/CesiumPointStyle.ts`
- `packages/core/copc/points/fieldSelection.ts`
- `packages/core/copc/points/pointInspection.ts`
- `packages/cesium/layer/CopcCesiumLayer.ts`

::: tip 공부할 때
색상 표현과 “어떤 attribute를 decode해서 보관할 것인가”는 연결되어 있습니다. UI 색상만 바꾸는 문제처럼 보여도 cache 메모리와 point field selection에 영향을 줄 수 있으므로 둘을 같이 보는 것이 좋습니다.
:::

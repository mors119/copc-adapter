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
});
```

## 실행 중 변경

Cesium layer는 현재 표시 중인 node의 cached decoded point buffer를 사용해 style을 변경할 수 있습니다.

```ts
layer.setStyle({
  colorMode: 'classification',
});
```

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

다만 현재 보이는 node의 decoded buffer가 cache에서 이미 제거된 상태라면, `setStyle()`이 몰래 다시 다운로드하는 대신 오류를 발생시키는 것이 현재 계약입니다.

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

- `apps/viewer-web/src/cesium/style/CesiumPointStyle.ts`
- `apps/viewer-web/src/copc/points/fieldSelection.ts`
- `apps/viewer-web/src/copc/points/pointInspection.ts`
- `apps/viewer-web/src/api/CopcCesiumLayer.ts`

::: tip 공부할 때
색상 표현과 “어떤 attribute를 decode해서 보관할 것인가”는 연결되어 있습니다. UI 색상만 바꾸는 문제처럼 보여도 cache 메모리와 point field selection에 영향을 줄 수 있으므로 둘을 같이 보는 것이 좋습니다.
:::

# 빠른 시작

이 페이지의 목표는 **COPC 파일 하나를 CesiumJS에 표시하는 최소 흐름**을 이해하는 것입니다.

## 1. 설치

```bash
npm install @frillab/copc-adapter cesium
```

COPC Adapter는 Cesium Viewer를 직접 만들지 않습니다. 애플리케이션이 Viewer를 만들고, COPC Adapter는 그 Viewer에 점군 layer를 붙입니다.

## 2. 최소 코드

```ts
import * as Cesium from 'cesium';
import { CopcCesiumLayer } from '@frillab/copc-adapter/cesium';

const viewer = new Cesium.Viewer('cesium-container');

const layer = new CopcCesiumLayer({
  url: 'https://example.com/data.copc.laz',
  colorMode: 'rgb',
});

await layer.load();
layer.attachTo(viewer);
```

여기서 역할을 나누면 다음과 같습니다.

| 코드 | 역할 |
| --- | --- |
| `new Cesium.Viewer(...)` | 애플리케이션이 Cesium Viewer 생성 |
| `new CopcCesiumLayer(...)` | COPC source와 표시 옵션 구성 |
| `layer.load()` | 메타데이터와 초기 hierarchy 준비 |
| `layer.attachTo(viewer)` | 카메라 기반 streaming과 렌더링 시작 |

## 3. 종료할 때

```ts
layer.detachFrom();
layer.destroy();

viewer.destroy();
```

COPC Adapter는 자신이 만든 리소스만 정리합니다. 애플리케이션의 Cesium Viewer는 애플리케이션이 직접 관리합니다.

## 4. 가장 먼저 확인할 것: 서버

COPC 파일 주소는 일반적인 파일 다운로드 URL만으로는 충분하지 않습니다.

최소한 다음 조건이 필요합니다.

- byte Range 요청 지원
- 요청한 범위에 대해 HTTP `206 Partial Content` 반환
- 올바른 `Content-Range`
- 다른 origin에서 접근한다면 적절한 CORS
- 브라우저 JavaScript가 `Content-Range`를 읽을 수 있도록 header 노출

자세한 내용은 [HTTP Range / CORS 요구사항](/ko/source-requirements)을 참고하세요.

## 5. source를 먼저 검사하기

```ts
import { probeCopcSource } from '@frillab/copc-adapter';

const result = await probeCopcSource(
  'https://example.com/data.copc.laz',
);

console.table(result);
```

이 검사는 전체 파일을 다운로드하지 않고 source가 COPC streaming에 필요한 조건을 만족하는지 확인합니다.

## 6. 추천 학습 순서

처음에는 옵션을 많이 바꾸지 않는 것이 좋습니다.

```ts
const layer = new CopcCesiumLayer({
  url,
  colorMode: 'rgb',
});
```

정상적으로 표시되면 다음 순서로 확인해 보세요.

1. Network에서 `Range: bytes=...` 확인
2. 카메라를 멀리/가까이 이동해 LoD 변화 확인
3. `getSnapshot()`으로 streaming 상태 확인
4. `getPointCacheDiagnostics()`으로 cache 확인
5. `setStyle()`로 색상 모드 변경
6. 점을 클릭해 point inspection 확인

## 관련 소스 코드

직접 구현을 공부하고 싶다면 다음 파일부터 보는 것이 좋습니다.

- `apps/viewer-web/src/api/CopcCesiumLayer.ts` — 공개 Cesium API
- `apps/viewer-web/src/viewer/CopcViewer.ts` — Cesium layer/controller 연결
- `apps/viewer-web/src/viewer/streaming/CopcStreamingController.ts` — renderer-neutral streaming 진입점
- `apps/viewer-web/src/viewer/streaming/StreamingManager.ts` — 선택된 node load와 scheduling

::: tip 수정할 때
사용자에게 노출되는 새 옵션을 추가한다면 먼저 `CopcCesiumLayerOptions`가 정말 필요한지 확인하세요. 내부 구현 세부사항은 가능한 한 public API로 올리지 않는 것이 현재 프로젝트 방향입니다.
:::

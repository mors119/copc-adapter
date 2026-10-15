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
  pointSize: 3,
  colorMode: 'rgb',
  rangeValidation: 'strict',
  maxRenderedPoints: 250_000,
  maxPointCacheBytes: 256 * 1024 * 1024,
  streaming: {
    maxNodes: 24,
    maxDepth: 6,
    maxScreenSpaceError: 8,
    maxRenderDistanceMeters: 12_000,
  },
});
```

기본값은 버전에 따라 바뀔 수 있으므로 정확한 값이 중요할 때는 [Public API](../API)를 확인하세요.

`rangeValidation`은 `'strict' | 'head-fallback'`이며 기본값은 `'strict'`입니다.
`'head-fallback'`은 브라우저 JavaScript에서 `Content-Range`를 읽을 수 없는
source를 위한 명시적 호환 모드입니다. 성공한 `HEAD` 응답에서 읽을 수 있는
`Content-Length`와 정확한 Range body 길이를 확인하지만, 반환된 byte offset이나
객체 버전의 불변성을 증명하지는 못합니다. Three.js layer와 streaming core에도
같은 옵션이 있습니다.

`maxRangeBytes`는 HTTP range 응답 하나의 최대 크기이며 기본값은 64 MiB입니다.
큰 metadata, hierarchy page 또는 point chunk를 읽어야 할 때 명시적으로 높일 수
있습니다. 양의 안전한 정수라면 고정 상한은 없습니다. 값을 높이면 메모리 사용량도
증가할 수 있습니다.

`maxConcurrentRangeRequests`는 source마다 동시에 실행할 HTTP range 요청 수이며
기본값은 4입니다. 작은 range가 여러 개일 때 병렬성을 높일 수 있도록 양의 안전한
정수로 설정할 수 있습니다. 두 설정의 조합이 동시에 진행되는 응답 buffer를
제한하며, 기본 설정에서 최대 약 256 MiB를 사용합니다. 둘 중 하나를 높이면 가능한
메모리 사용량도 늘어납니다.

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

source metadata와 초기 hierarchy를 준비합니다.

### attachTo

기존 Cesium Viewer에 연결합니다.

### detachFrom

Viewer에서 분리하지만 source 전체를 반드시 폐기하는 동작은 아닙니다.

### unload

현재 로드된 COPC data와 layer-owned 상태를 정리합니다.

### destroy

layer를 영구적으로 종료합니다.

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
기본 strict 검증을 사용하며, 호환 모드도 확인하려면
`probeCopcSource(url, { rangeValidation: 'head-fallback' })`를 호출합니다.
결과의 `validationLevel`은 `strict`, `compatibility-limited`, `incompatible`,
`unknown` 중 하나입니다.

## API를 변경할 때 볼 파일

- `apps/viewer-web/src/api/CopcCesiumLayer.ts`
- `apps/viewer-web/src/viewer/CopcViewer.ts`
- `apps/viewer-web/src/viewer/streaming/CopcStreamingController.ts`
- `apps/viewer-web/src/cesium/style/CesiumPointStyle.ts`

::: warning Public API 변경
새 메서드나 옵션을 추가할 때는 구현 편의보다 사용자가 실제로 필요로 하는 안정적인 계약인지 먼저 판단하세요. 내부 diagnostics나 renderer 세부 구현을 그대로 public API로 노출하지 않는 것이 좋습니다.
:::

# API 빠른 참조

이 페이지는 CesiumJS에서 가장 자주 사용하는 public API만 한글로 빠르게 찾기 위한 문서입니다.

전체 타입과 세부 계약은 [영문 Public API](/API)를 기준으로 합니다.

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

기본값은 버전에 따라 바뀔 수 있으므로 정확한 값이 중요할 때는 [Public API](/API)를 확인하세요.

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

## API를 변경할 때 볼 파일

- `apps/viewer-web/src/api/CopcCesiumLayer.ts`
- `apps/viewer-web/src/viewer/CopcViewer.ts`
- `apps/viewer-web/src/viewer/streaming/CopcStreamingController.ts`
- `apps/viewer-web/src/cesium/style/CesiumPointStyle.ts`

::: warning Public API 변경
새 메서드나 옵션을 추가할 때는 구현 편의보다 사용자가 실제로 필요로 하는 안정적인 계약인지 먼저 판단하세요. 내부 diagnostics나 renderer 세부 구현을 그대로 public API로 노출하지 않는 것이 좋습니다.
:::

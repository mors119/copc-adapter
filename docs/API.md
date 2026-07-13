# Library API

`apps/viewer-web/src/index.ts` 가 현재 public entrypoint 이다.

## Exported API

### `CopcViewer`

Cesium viewer lifecycle 과 COPC streaming orchestration 을 감싸는 public class.

주요 메서드:

- `init()`: Cesium viewer mount
- `load()`: metadata / hierarchy / streaming node 로딩
- `start()`: `init()` + `load()`
- `destroy()`: Cesium resource 와 listener 정리
- `getSnapshot()`: 현재 lifecycle, 선택 node, 렌더링 point 수 조회

### `createCopcViewer(options)`

한 번에 viewer 생성, mount, load 를 수행하는 convenience helper.

### Exported types

- `CopcViewerOptions`
- `CopcViewerSnapshot`
- `CopcViewerLifecycleState`
- `CopcMetadata`
- `CopcPoint`
- `GeographicPoint`

## Quick Start

```ts
import { createCopcViewer } from './src';

const viewer = await createCopcViewer({
  container: 'cesium-container',
  url: '/samples/autzen.copc.laz',
});

console.log(viewer.getSnapshot());
```

## Manual Lifecycle

```ts
import { CopcViewer } from './src';

const viewer = new CopcViewer({
  container: document.getElementById('cesium-container')!,
  url: '/samples/autzen.copc.laz',
});

await viewer.init();
await viewer.load();

console.log(viewer.getRenderedNodeKeys());

viewer.destroy();
```

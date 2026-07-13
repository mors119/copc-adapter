# Examples

## Browser App Example

실행 가능한 최소 예제는 [apps/viewer-web/src/main.ts](/Users/mars112/code/project/copc-adapter/apps/viewer-web/src/main.ts) 이다.

동작 흐름:

1. `createCopcViewer()` 호출
2. Cesium container mount
3. COPC metadata / hierarchy 로딩
4. camera 기반 streaming selection 시작

## HTML Skeleton

```html
<div id="cesium-container"></div>
<script type="module" src="/src/main.ts"></script>
```

## Manual Integration Example

```ts
import { CopcViewer } from './src';

const viewer = new CopcViewer({
  container: 'cesium-container',
  url: '/samples/autzen.copc.laz',
});

await viewer.start();

console.log(viewer.getSnapshot());
```

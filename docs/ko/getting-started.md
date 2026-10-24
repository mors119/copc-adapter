# 빠른 시작

이 페이지의 목표는 **COPC 파일 하나를 CesiumJS에 표시하는 최소 흐름**을 이해하는 것입니다.

## 브라우저에서 먼저 체험하기

[공개 Playground](https://mors119.github.io/copc-adapter/playground/)에서 Autzen·Chicago 공개 데이터, 직접 입력한 HTTP(S) URL, 로컬 파일을 선택할 수 있습니다. 원격 주소는 **Probe source**로 먼저 검사하고 결과를 확인한 뒤 **Load source**를 눌러야 합니다. Probe는 설치된 패키지의 공개 `probeCopcSource()` API를 호출하며 layer를 만들거나 기존 layer를 교체하지 않습니다. HTTP 상태, 브라우저 CORS 읽기 가능 여부, Range 지원, COPC 감지, point format, 리소스 크기, 검증 수준과 경고를 제공되는 범위에서 표시합니다. 확인할 수 없는 값은 unknown으로 남깁니다. 알려진 HTTP·CORS·Range·비-COPC 실패는 설명과 함께 Load를 비활성화합니다. 일부 결과가 unknown이면 명시적으로 Load를 시도할 수 있지만 실제 로드도 실패할 수 있습니다. URL을 수정하면 이전 Probe 결과는 무효화됩니다. 로컬 `File`은 HTTP 검사 없이 직접 열 수 있습니다.

로드가 완료되면 전체 point count, point format, source bounds, source가 WKT를 제공했는지, 활성 backend와 renderer를 표시합니다. Bounds는 source CRS 단위 그대로입니다. 위치만으로 CRS, 수직 datum, 높이 기준을 추론하지 않습니다. 원격 요청은 브라우저에서 직접 이뤄지므로 호스트가 CORS와 유효한 HTTP Range 응답을 허용해야 합니다. Playground는 URL을 프록시로 바꾸거나 package의 응답 검증을 약화하지 않습니다. Probe는 브라우저가 확인할 수 있었던 조건만 보여 주며, 원본 데이터의 진위나 불변성을 증명하지는 않습니다. 로컬 파일은 브라우저 안에서 읽고 업로드하지 않습니다. 상세 Worker·cache·benchmark 진단은 공개 화면에 두지 않고 내부 Dev Viewer에서 확인합니다.

Playground는 Cesium과 Three.js, JavaScript와 Rust/WASM backend, 색상 모드, point size, 표시 point/cache 예산, max nodes, max depth, screen-space error, 최대 렌더 거리, refinement algorithm, Focus Lens를 제공합니다. Layer 생성 설정은 **Pending** 상태로 편집하고 **Apply changes**를 눌러 성공적으로 교체된 뒤에만 **Active**가 됩니다. 교체가 실패하면 기존 layer와 화면을 유지합니다. 가능한 경우 카메라 위치도 보존합니다. Cache 예산은 MiB로 입력하며 package에는 정확한 정수 byte 값으로 전달합니다.

Cesium의 색상과 classification 변경은 활성 layer의 공개 `getStyle()` / `setStyle()`로 처리하므로 layer를 다시 만들지 않습니다. Classification은 LAS 코드 0–255를 사용합니다. 빈 include 목록은 모든 점을 숨기며, exclude는 include 적용 뒤에 적용됩니다. **Clear filter**는 필터를 제거합니다. 유지된 point buffer에 스타일을 적용하지 못하면 복구 가능한 오류를 표시하고 이전 Active 스타일을 유지합니다. 공개 Three.js layer에는 runtime style setter가 없으므로 색상 변경은 Apply가 필요하고 classification은 사용할 수 없습니다. Three.js로 전환하기 전에 Cesium classification 필터를 지워야 합니다. Cesium Focus Lens 변경은 활성 layer에 적용하고, refinement algorithm 변경은 Apply가 필요합니다.

**Reset to defaults**는 Playground 기본 설정으로 되돌리지만 source 선택이나 선택된 로컬 파일을 지우지 않습니다. Cesium runtime 스타일은 공개 setter로 즉시 초기화하고, 생성자 설정 변경은 Pending으로 남겨 Apply를 기다립니다. 생성 코드는 마지막으로 성공적으로 적용한 설정과 스타일만 표시하며, pinned npm package의 public API를 사용합니다. 공유 링크에는 정규화된 설정을 저장하고 source는 기본적으로 제외합니다. 선택적으로 query 없는 HTTP(S) 주소만 포함할 수 있습니다. 자격 정보, query, fragment, 로컬 경로, File 내용은 링크에 기록하지 않습니다. 링크를 열면 설정을 복원하지만, 포함된 안전한 주소도 다시 Probe하고 직접 Load해야 합니다. source가 없는 링크는 layer가 로드됐다고 표시하지 않습니다.

교체 중에는 현재 runtime을 표시한 채 숨겨진 후보 runtime을 로드합니다. 후보가 성공하면 교체하고 이전 runtime을 정리하며, 실패하거나 취소된 후보도 정리합니다. Cesium 교체 중에는 viewer 두 개가 잠시 함께 존재할 수 있습니다.

화면의 패키지 표시는 실제 설치된 Adapter 버전과 출처를 읽습니다. 공개 Pages는 lockfile의 정확한 npm 배포 버전과 무결성을 확인합니다. 로컬 workspace와 `.tgz` 후보 패키지는 별도 출처로 표시합니다.

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

표시 옵션을 생략하면 3픽셀 크기의 고정 cyan 점을 사용합니다. `url`에는
브라우저 `File` 또는 `Blob`을 전달할 수도 있습니다. 파일은 필요한 구간만
브라우저 안에서 읽으며 업로드하지 않습니다.

## Three.js 빠른 시작

Three.js에서는 애플리케이션이 scene, camera, renderer와 렌더 루프를 관리합니다.

```ts
import * as THREE from 'three';
import { CopcThreeLayer } from '@frillab/copc-adapter/three';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 20_000);
const renderer = new THREE.WebGLRenderer();
const layer = new CopcThreeLayer({
  url: 'https://example.com/data.copc.laz',
});

await layer.load();
layer.attachTo({ scene, camera, renderer });

function animate() {
  requestAnimationFrame(animate);
  void layer.update();
  renderer.render(scene, camera);
}
animate();
```

Three.js도 같은 기본 표시와 로컬 `File`/`Blob` 입력을 지원합니다. 표시 예제에서
`renderer`는 layer가 참조하는 application-owned WebGLRenderer이고, 선택적 layer
renderer 구현은 `new CopcThreeLayer({ url, renderer: customPointRenderer })`로
전달합니다.

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

## Terrain과 수직 기준 확인

점군이 imagery 위에 떠 보이는 것만으로 필요한 높이 보정량을 알 수는 없습니다.
Imagery에는 높이가 없고, ellipsoid 높이 0도 측량된 실제 지면이 아닙니다. 실제
Cesium TerrainProvider가 있어야 Terrain 높이를 샘플링할 수 있습니다. 3D Tiles의 지붕이나
벽은 이 Terrain 기능의 대상이 아닙니다.

먼저 source의 vertical CRS와 단위를 확인하세요. 예를 들어 Autzen의 NAVD88 height는
orthometric 높이이므로 Z를 US survey foot에서 미터로 변환하는 것만으로 Cesium의
ellipsoidal height가 되지 않습니다. 호환되는 #244 vertical transform 없이는 Terrain
추정이 uncertain이며 Apply할 수 없습니다. #237의 `heightOffsetMeters`는 사용자가 알고
있는 균일한 잔차를 입력하는 값이고, #305는 명시적으로 선택한 ground anchor와 Terrain을
비교해 offset을 제안합니다. 어느 쪽도 자동 geoid correction이 아닙니다.

내부 Dev Viewer에서는 인증정보가 없는 local/public quantized-mesh 서비스 root 주소
(`layer.json`이 있는 폴더)를 Terrain 설정에 입력하고 **Apply Settings**를 누릅니다.
끝에 `/layer.json`을 붙여도 인식합니다. 현재 COPC 점을 선택한 뒤 지면인지
확인하고, 필요하면 ground 확인 checkbox를 선택합니다. **Estimate residual**은 geometry를
움직이지 않습니다. 미리보기와 vertical-reference warnings를 확인하고 actionable 상태일
때만 **Apply proposed correction**을 눌러야 합니다. 자세한 API 및 timeout/lifecycle 계약은
[명시적 Cesium Terrain 잔차 추정](./api#명시적-cesium-terrain-잔차-추정)을 참고하세요.

## 관련 소스 코드

직접 구현을 공부하고 싶다면 다음 파일부터 보는 것이 좋습니다.

- `packages/cesium/layer/CopcCesiumLayer.ts` — 공개 Cesium API
- `packages/cesium/layer/CesiumLayerController.ts` — Cesium layer/controller 연결
- `packages/core/streaming/CopcStreamingController.ts` — renderer-neutral streaming 진입점
- `packages/core/streaming/StreamingManager.ts` — 선택된 node load와 scheduling

::: tip 수정할 때
사용자에게 노출되는 새 옵션을 추가한다면 먼저 `CopcCesiumLayerOptions`가 정말 필요한지 확인하세요. 내부 구현 세부사항은 가능한 한 public API로 올리지 않는 것이 현재 프로젝트 방향입니다.
:::

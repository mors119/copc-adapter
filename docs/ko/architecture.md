# 아키텍처와 소스 코드 위치

이 문서는 “기능이 어느 파일에 있는지”를 빨리 찾기 위한 지도입니다.

더 엄밀한 설계 문서는 [Architecture](/ARCHITECTURE)를 참고하세요.

## 현재 큰 경계

```text
Browser / TypeScript
  HTTP Range
  CORS / response validation
  async scheduling
  hierarchy lifecycle
  NodeSelector
  LoD / SSE / hysteresis
  cache / generation
       ↓
point preparation
  copc-js path
  또는
  Rust/WASM path
       ↓
renderer-neutral prepared point data
       ↓
Cesium adapter
```

## 1. Public Cesium API

```text
apps/viewer-web/src/api/CopcCesiumLayer.ts
```

사용자가 직접 만나는 layer API입니다.

여기를 보면:

- constructor option
- lifecycle
- diagnostics
- point picking
- runtime style

을 찾을 수 있습니다.

## 2. Streaming core

```text
apps/viewer-web/src/viewer/streaming/
```

핵심 파일:

- `CopcStreamingController.ts`
- `StreamingManager.ts`
- `NodeSelector.ts`
- `scheduler.ts`
- `createNodePointCache.ts`

역할을 단순화하면:

```text
Controller
  → 전체 lifecycle

NodeSelector
  → 무엇을 표시할지

StreamingManager / scheduler
  → 어떤 순서로 load할지

Point cache
  → 이미 준비한 node를 얼마나 보관할지
```

## 3. HTTP Range

```text
apps/viewer-web/src/copc/range/
```

여기서는:

- byte range validation
- `206 Partial Content`
- `Content-Range`
- AbortSignal
- bounded coalescing

을 다룹니다.

네트워크 문제를 수정할 때 LoD 코드부터 건드리기보다 이 계층을 먼저 확인하는 것이 좋습니다.

## 4. COPC backend

```text
apps/viewer-web/src/copc/backend/
```

현재 두 production 선택지가 있습니다.

- `copc-js`
- `rust`

두 backend가 외부 renderer에 서로 다른 데이터 계약을 노출하지 않도록 project-owned 타입 경계를 유지하는 것이 중요합니다.

## 5. Rust core / WASM

```text
crates/copc-core/
crates/copc-wasm/
```

원칙:

- binary/numeric point processing은 Rust core에 둘 수 있음
- WASM crate는 얇은 ABI/transport 경계
- camera, browser scheduling, NodeSelector는 TypeScript 영역

Rust를 더 많이 쓰는 것 자체가 목표가 아니라 **재사용 가능한 point-processing domain을 분리하는 것**이 목표입니다.

## 6. 좌표 변환

```text
apps/viewer-web/src/coordinates/
crates/copc-core/
crates/crs-audit/
```

개념적인 흐름:

```text
source/project XYZ
  ↓
WGS84 geographic
  ↓
WGS84 ECEF
  ↓
Cesium
```

현재 conformance에는 Autzen/SoFi뿐 아니라 EPSG:5186 Korean Central Belt 2010 control도 포함되어 있습니다.

## 7. Cesium renderer

```text
apps/viewer-web/src/cesium/
```

Cesium object 생성, style 적용, point identity/picking, resource disposal 같은 renderer-specific 작업이 이쪽에 위치합니다.

COPC parsing이나 NodeSelector를 Cesium 코드 안으로 다시 넣지 않는 것이 중요합니다.

## 8. 테스트와 증거

```text
apps/viewer-web/test/
apps/viewer-web/e2e/
tests/environments/cesium-vite/
docs/benchmarks/
```

테스트를 고칠 때 목적을 구분하면 이해하기 쉽습니다.

- unit: deterministic semantics
- E2E: 실제 browser/Cesium
- packed consumer: npm package 경계
- benchmark/validation doc: 한 번의 측정값과 한계 기록

## 내가 수정하려는 기능은 어디인가?

| 하고 싶은 일 | 먼저 볼 곳 |
| --- | --- |
| 새 public option | `api/CopcCesiumLayer.ts` |
| node 선택 정책 | `streaming/NodeSelector.ts` |
| load 순서/동시성 | `streaming/StreamingManager.ts`, `scheduler.ts` |
| cache | `streaming/createNodePointCache.ts` |
| Range/CORS | `copc/range/`, `sourceProbe.ts` |
| Rust decode | `copc/rustCopcReader.ts`, Rust crates |
| 색상/필터 | `cesium/style/` |
| point picking | `copc/points/pointInspection.ts` |
| CRS | `coordinates/`, `crates/crs-audit/` |

::: tip 수정 전 질문
“이 로직은 point-level binary/numeric 작업인가, browser/view policy인가, renderer 표현인가?”를 먼저 판단하면 파일 위치를 찾기 훨씬 쉽습니다.
:::

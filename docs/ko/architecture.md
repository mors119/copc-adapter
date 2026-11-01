# 아키텍처와 소스 코드 위치

이 문서는 “기능이 어느 파일에 있는지”를 빨리 찾기 위한 지도입니다.

더 엄밀한 설계 문서는 [Architecture](../ARCHITECTURE)를 참고하세요.

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
packages/adapter/cesium/layer/CopcCesiumLayer.ts
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
packages/adapter/core/streaming/
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
packages/adapter/core/copc/range/
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
packages/adapter/core/copc/backend/
```

현재 두 production 선택지가 있습니다.

- `copc-js`
- `rust`

두 backend가 외부 renderer에 서로 다른 데이터 계약을 노출하지 않도록 project-owned 타입 경계를 유지하는 것이 중요합니다.

## 5. Rust core / WASM

```text
crates/core/
crates/wasm/
```

원칙:

- binary/numeric point processing은 Rust core에 둘 수 있음
- WASM crate는 얇은 ABI/transport 경계
- camera, browser scheduling, NodeSelector는 TypeScript 영역

Rust를 더 많이 쓰는 것 자체가 목표가 아니라 **재사용 가능한 point-processing domain을 분리하는 것**이 목표입니다.

## 6. 좌표 변환

```text
packages/adapter/core/coordinates/
crates/core/
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

### 좌표 변환 계획 v1

`CoordinateTransformPlan`은 데이터셋 좌표 경로를 설명하는 불변 renderer-neutral 타입입니다. `createCoordinateTransformPlan`으로 진단용 스냅샷을 만들 수 있고, TypeScript 정방향/역방향 transformer의 `plan` 속성에서 실제 설정을 확인할 수 있습니다. Streaming core는 같은 메타데이터와 연산 입력에 대해 계획을 재사용하고 Rust 준비 결과의 후처리를 조정합니다.

논리적인 처리 순서는 다음과 같습니다.

```text
LAS scale/offset 디코드
  → source 축과 단위 정규화
  → 수평 기준계를 WGS 84 geographic으로 변환
  → 설정된 검증 수직 격자를 한 번 적용
  → 수동 타원체고 offset을 한 번 적용
  → 별도로 승인된 terrain 배치 잔차를 viewer에서 적용
  → WGS 84 ECEF 준비
```

Rust는 디코드, CRS/단위 변환, 수동 offset, ECEF 준비를 융합할 수 있습니다. 수직 격자가 설정되면 TypeScript는 Rust 결과에 이미 포함된 offset을 제거하고, 격자를 샘플링한 다음 요청된 offset을 적용해 ECEF를 다시 계산합니다. 이 작업은 공유 후처리 한 번으로 처리하며 source 좌표는 유지합니다. 격자가 없는 기존 경로는 높이를 그대로 전달하고, source CRS 진단이 알 수 없는 수직 기준계를 명시합니다. 계획의 confidence는 메타데이터 근거를 설명하며 실제 backend 변환 지원은 별도로 backend-dependent로 기록합니다.

계획에는 source/target CRS, 축과 단위 근거, 수동 offset, WKT 선택 출처, 선택적 격자 ID와 SHA-256, 격자 범위와 극값, 격자 epoch, 역변환 요구사항, 미지원 사유가 포함됩니다. identity key는 source WKT와 선택 출처, source 범위와 LAS scale/offset, 격자 식별값/범위/epoch, height offset을 담은 정확한 JSON 튜플입니다. 이 값은 동일성 키이며 콘텐츠 checksum은 아닙니다.

준비 데이터의 cache 수명은 나머지 동일성 범위를 관리합니다. Streaming core는 source generation 동안 하나의 변환 설정과 node cache를 사용합니다. reload 시 cache를 새로 만들고 기존 generation의 worker 결과는 거부합니다. 실험용 compact-E 항목은 source identity, WKT, transform generation, height offset, grid ID/hash도 보관합니다. 향후 TerrainProvider나 승인된 배치 잔차가 바뀌면 해당 layer generation을 갱신해야 합니다. Terrain 잔차는 지오데틱 계획 밖의 viewer 작업이며 datum 변환으로 기록하지 않습니다.

역변환 계획은 지원되는 경우 수동 offset, 수직 격자, 수평 projection을 되돌려 camera/LoD bounds를 source 공간으로 계산합니다. 합성 query bounds는 인위적인 모서리를 샘플링하지 않고 격자의 보수적 극값을 사용합니다. 계획은 필요한 역변환 의미를 기록하고 backend 지원 실패는 안전하게 반환합니다.

## 7. Cesium renderer

```text
packages/adapter/cesium/
```

Cesium object 생성, style 적용, point identity/picking, resource disposal 같은 renderer-specific 작업이 이쪽에 위치합니다.

COPC parsing이나 NodeSelector를 Cesium 코드 안으로 다시 넣지 않는 것이 중요합니다.

## 8. 테스트와 증거

```text
packages/adapter/test/
apps/dev-viewer/e2e/
tests/environments/cesium-vite/
docs/benchmarks/
```

테스트를 고칠 때 목적을 구분하면 이해하기 쉽습니다.

- unit: deterministic semantics
- E2E: 실제 browser/Cesium
- packed consumer: npm package 경계
- benchmark/validation doc: 메인테이너가 승인한 장기 비교용 재현 가능한 성능 기준만 별도 보관 (일회성 검증은 PR 본문에 기록)

공개 Playground E2E에는 로컬 파일과 HTTP 응답 fixture 테스트뿐 아니라 실제 Autzen 데이터 스트리밍 smoke 세 개도 포함됩니다. 이 테스트는 공개 호스트의 CORS·Range 응답과 실제 point streaming을 확인합니다.

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

# COPC 스트리밍과 LoD 이해하기

이 페이지는 COPC Adapter의 핵심인 **“왜 전체 파일을 받지 않고도 점군이 보이는가?”**를 설명합니다.

## 전체 흐름

```text
COPC URL
  ↓
metadata / COPC info
  ↓
root hierarchy
  ↓
현재 카메라 view
  ↓
필요한 hierarchy page 탐색
  ↓
NodeSelector
  ↓
point/node budget 안에서 표시할 node 결정
  ↓
해당 node의 point chunk만 Range 요청
  ↓
decode / 좌표 준비
  ↓
cache
  ↓
Cesium renderer
```

## HTTP Range

COPC 내부에는 hierarchy page와 압축된 point chunk가 서로 다른 byte offset에 있습니다.

따라서 전체 파일이 2 GB라고 해도 현재 장면에 필요한 몇 MB만 읽을 수 있습니다.

예를 들어 개념적으로:

```http
Range: bytes=2027762319-2028459096
```

처럼 필요한 byte 구간만 요청합니다.

COPC Adapter는 `206 Partial Content`와 `Content-Range`가 실제 요청 범위와 맞는지도 검증합니다.

## hierarchy

COPC의 hierarchy는 점군을 공간적으로 나눈 구조입니다.

중요한 점은 **처음부터 전체 hierarchy를 모두 메모리에 올리는 것이 아니라**, 현재 view에서 필요한 영역을 따라가며 필요한 page를 추가로 읽는다는 것입니다.

관련 코드:

- `apps/viewer-web/src/copc/hierarchy/`
- `apps/viewer-web/src/viewer/streaming/CopcStreamingController.ts`

## LoD

LoD(Level of Detail)는 단순히 “가까우면 점을 많이 표시한다”가 아닙니다.

현재 구현은 다음 요소를 함께 봅니다.

- 카메라 frustum
- screen-space error
- 이전 선택 상태
- hysteresis
- 최대 node 수
- 최대 point 수
- 현재 cache 상태
- view relevance

그래서 더 정확한 표현은:

> 현재 화면에서 필요한 시각적 상세도와 자원 제한을 함께 고려하여 표시할 COPC node를 선택한다.

입니다.

## 점진적 전환

더 상세한 child node가 필요해졌다고 해서 coarse node를 즉시 지우지 않습니다.

```text
coarse node 표시
  ↓
fine node 요청/처리 중
  ↓
coarse coverage 유지
  ↓
필요한 fine data 준비
  ↓
안전하게 교체
```

이 구조는 loading 중 점군이 통째로 사라지는 현상을 줄이는 데 중요합니다.

## 자원 제한

대표적인 기본값은 public API 문서를 기준으로 확인해야 하지만, 구조적으로 다음 제한이 존재합니다.

- `maxNodes`
- `maxDepth`
- `maxScreenSpaceError`
- `maxRenderDistanceMeters`
- `maxRenderedPoints`
- `maxConcurrentNodeLoads`
- `maxPointCacheBytes`

이 값들은 서로 다른 문제를 제어합니다.

예를 들어 `maxRenderedPoints`와 `maxConcurrentNodeLoads`는 같은 제한이 아닙니다.

- `maxRenderedPoints`: 현재 view에서 활성화할 point workload
- `maxConcurrentNodeLoads`: 동시에 수행할 Range/decode/preparation 작업 수

## stale generation과 취소

카메라를 빠르게 움직이면 이전 view에서 필요했던 작업이 새 view에서는 필요 없을 수 있습니다.

현재 streaming은 generation을 사용해 오래된 결과가 화면에 반영되지 않도록 하고, 가능한 Range 요청은 AbortController를 통해 취소합니다.

```text
View A
  ↓
Range A 진행

카메라 이동

View B
  ↓
A는 stale
  ↓
불필요한 Range A 취소
  ↓
B의 작업을 우선 진행
```

## 어디를 읽어보면 좋은가

- `apps/viewer-web/src/viewer/streaming/NodeSelector.ts`
  - 어떤 node를 선택할지
- `apps/viewer-web/src/viewer/streaming/StreamingManager.ts`
  - 선택된 node를 어떤 순서와 동시성으로 처리할지
- `apps/viewer-web/src/viewer/streaming/scheduler.ts`
  - bounded scheduling
- `apps/viewer-web/src/copc/range/`
  - HTTP Range 검증, 취소, coalescing
- `apps/viewer-web/src/viewer/streaming/createNodePointCache.ts`
  - decoded point cache

::: warning 혼동하기 쉬운 부분
Node selection, hierarchy loading, Range I/O, LAZ decode, renderer는 서로 다른 단계입니다. 성능 문제가 생겼을 때 “LoD가 느리다”라고 한 번에 묶기보다 어느 단계가 병목인지 diagnostics로 나눠서 보는 것이 좋습니다.
:::

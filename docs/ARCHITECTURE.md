# Architecture - COPC Adapter

## Goal-Aligned Structure

현재 구현은 "COPC를 CesiumJS에서 직접 가시화" 하는 MVP 목표에 맞춰 다음 경계로 나뉜다.

1. `copc.js` 기반 COPC reader 계층
2. Rust + WASM point decoder 계층
3. TypeScript streaming / coordinate transform / viewer orchestration 계층
4. Cesium rendering 계층

---

## Layered Flow

```text
COPC URL / COPC File Source
  ->
Metadata Loader
  ->
Hierarchy Loader
  ->
Point Data View Loader
  ->
Rust + WASM Point Decoder
  ->
Coordinate Transformation
  ->
Streaming Node Selection / Cache
  ->
Cesium Renderer
  ->
Public Viewer API
```

---

## Current Responsibilities

### 1. COPC Reader Layer

위치:

- `apps/viewer-web/src/copc/metadata`
- `apps/viewer-web/src/copc/hierarchy`
- `apps/viewer-web/src/copc/points`

역할:

- COPC metadata 읽기
- root hierarchy 읽기
- 선택된 node의 `CopcPointView` 읽기

현재 구현은 `copc.js` 를 사용한다.

의도:

- COPC 스펙 전체 재구현 없이 MVP를 빠르게 검증
- reader / decoder / renderer 경계를 분리

### 2. Rust + WASM Decoder Layer

위치:

- `crates/copc-wasm`
- `apps/viewer-web/src/wasm/copcDecoder.ts`

역할:

- X/Y/Z dimension 배열을 interleaved point buffer 로 변환
- point decoding hot path 를 Rust로 치환

현재 범위:

- metadata parsing: 아님
- hierarchy traversal: 아님
- point buffer decode: 맞음

즉, Rust + WASM 은 현재 "full COPC parser" 가 아니라 "point decoder replacement" 이다.

### 3. Streaming Viewer Layer

위치:

- `apps/viewer-web/src/viewer`
- `apps/viewer-web/src/viewer/streaming`

역할:

- 카메라 위치 읽기
- hierarchy 기반 node selection
- LoD 정책 적용
- request cache
- incremental load / unload orchestration

이 계층은 low-level binary parsing 을 하지 않고, reader 와 decoder 결과를 연결한다.

### 4. Coordinate Transformation Layer

위치:

- `apps/viewer-web/src/coordinates`

역할:

- COPC CRS / WKT 해석
- projected coordinates -> WGS84 + meters 변환
- Cesium 입력 좌표 준비

### 5. Cesium Rendering Layer

위치:

- `apps/viewer-web/src/cesium`

역할:

- Cesium viewer 생성
- Point primitive collection 생성
- 화면 렌더링

금지 사항:

- COPC parsing
- hierarchy parsing
- file format logic

---

## Public API Boundary

위치:

- `apps/viewer-web/src/index.ts`
- `apps/viewer-web/src/viewer/CopcViewer.ts`

제공 기능:

- `CopcViewer`
- `createCopcViewer()`
- viewer lifecycle
- metadata 조회
- snapshot 조회

소비자는 내부 `copc/`, `coordinates/`, `cesium/`, `wasm/` 세부 구현이 아니라 public entrypoint 만 사용해야 한다.

---

## Actual Runtime Data Flow

1. consumer 가 `createCopcViewer()` 또는 `CopcViewer.start()` 호출
2. metadata loader 가 COPC metadata 읽기
3. hierarchy loader 가 root hierarchy 읽기
4. streaming selector 가 카메라 기준으로 render node 선택
5. point loader 가 node `CopcPointView` 읽기
6. Rust + WASM decoder 가 interleaved point buffer 생성
7. coordinate transform 이 WGS84 좌표로 변환
8. Cesium renderer 가 primitive collection 으로 표시

---

## Near-Term Extension Path

현재 구조에서 다음 확장이 자연스럽다.

- hierarchy page 추가 로딩으로 deeper octree traversal 일반화
- Rust decoder 범위를 metadata / hierarchy parsing 까지 확대
- WebWorker 분리
- GPU 기반 point rendering 최적화

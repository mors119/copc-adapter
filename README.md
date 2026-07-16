# COPC Adapter

COPC (Cloud Optimized Point Cloud) 데이터를 CesiumJS에서 직접 스트리밍 렌더링하는 프로젝트다.

이 저장소의 목표는 사전 타일링 없이 원본 COPC 파일을 로딩하고, 필요한 노드만 선택적으로 읽어 Web에서 시각화하는 `v0.1.0` 수준의 MVP 라이브러리와 예제 viewer를 제공하는 것이다.

---

## Project Purpose

- COPC 파일 직접 로딩
- Octree 기반 스트리밍 구조 이해 및 구현
- CesiumJS 기반 3D Point Cloud 렌더링
- Rust + WASM 기반 COPC 파서 개발
- 필요 영역만 동적으로 로딩 (LOD)

## What Is COPC

COPC는 LAZ 기반 포인트 클라우드를 공간 계층 구조와 함께 저장해, 전체 파일을 모두 풀지 않고도 필요한 범위만 부분 로딩할 수 있도록 설계된 형식이다. 이 프로젝트는 그 계층 정보와 포인트 청크를 직접 읽어 Cesium point primitive로 연결한다.

## Implemented Features

- COPC metadata loading
- Hierarchy traversal
- Point decoding
- Cesium visualization
- Basic LOD selection
- Streaming manager
- Bounded cache

---

## 핵심 개념

- COPC (Cloud Optimized Point Cloud)
- Point Cloud (LiDAR 3D 점 데이터)
- Octree (공간 분할 구조)
- LOD (Level of Detail)
- WASM (Rust ↔ Web 브릿지)
- CesiumJS (3D Globe Rendering Engine)

---

## Architecture Overview

```
copc-viewer/
├── apps/
│ └── viewer-web # Cesium 기반 웹 뷰어 (TypeScript)
├── crates/
│ └── copc-wasm # Rust 기반 COPC 처리 + WASM 모듈
├── docs/
│ ├── architecture.md
│ └── roadmap.md
└── README.md
```

---

## Installation

```bash
npm install
npm ci --prefix apps/viewer-web
```

샘플 데이터는 저장소에 포함하지 않으므로 별도 다운로드가 필요하다.

```bash
npm run download-samples -- autzen
```

## Running Example

### Viewer App

```bash
cd apps/viewer-web
npm run dev
```

기본 샘플 URL은 `/samples/autzen.copc.laz` 이며, 현재 viewer는 아래 순서로 동작합니다.

1. COPC metadata 로딩
2. root hierarchy page 로딩
3. child hierarchy page 재귀 순회
4. camera state -> `NodeSelector`
5. distance / bounds / max depth 기반 LoD selection
6. `StreamingManager` 가 선택 node 와 cache 상태 조정
7. 선택된 node `CopcPointView` 로딩
8. Rust + WASM point decoder 로 interleaved point buffer 생성
9. CRS -> WGS84 + meters 좌표 변환
10. Cesium point primitive 렌더링

`npm run dev`, `npm test`, `npm run coverage`, `npm run build` 는 모두 내부적으로 `cargo build -p copc-wasm --target wasm32-unknown-unknown --release` 를 실행해 WASM asset 을 준비한다.

### Library Usage

```ts
import { createCopcViewer } from './src';

const viewer = await createCopcViewer({
  container: 'cesium-container',
  url: '/samples/autzen.copc.laz',
});

console.log(viewer.getSnapshot());
```

상세 API 는 [docs/API.md](/Users/mars112/code/project/copc-adapter/docs/API.md), 예제는 [docs/EXAMPLES.md](/Users/mars112/code/project/copc-adapter/docs/EXAMPLES.md) 에 정리했다.

## Current MVP Stabilization

현재 viewer-web 은 release-quality MVP 를 위한 두 가지 내부 안정화 경로를 추가했다.

- `CopcContext`: dataset 당 한 번만 `Copc.create()` 를 수행하고 metadata, hierarchy, point loading 이 같은 reader state 를 재사용한다.
- bounded node cache: viewer streaming cache 는 LRU 순서로 최대 entry 수를 유지하며, node deselection 과 `destroy()` 시 cached point promise 를 정리한다.

## Hierarchy Traversal

hierarchy 계층은 rendering 과 분리되어 COPC hierarchy page traversal 만 담당한다.

- hierarchy `node`: point chunk metadata 를 가진 octree node
- hierarchy `page`: 추가 node / page metadata 가 들어 있는 child hierarchy block

viewer 는 point data 를 요청하기 전에 전체 hierarchy metadata 를 재귀적으로 순회하지만, 이 단계에서는 point chunk 자체를 읽지 않는다.

## Streaming Selection

streaming 계층은 hierarchy 와 renderer 사이에서 “지금 어떤 node를 그릴지” 결정한다.

- `NodeSelector`: camera distance, node bounds, max depth 로 visible node 선택
- `StreamingManager`: 선택 결과를 기준으로 cache 조회, 누락 node load, deselection cleanup 수행

현재 LoD 전략은 intentionally simple 하다.

- distance based refinement
- bounding box visibility
- maximum depth limit

advanced screen-space error 는 아직 포함하지 않는다.

## Quality Gates

`apps/viewer-web` 에는 아래 검증 스크립트가 있다.

```bash
npm run typecheck
npm test
npm run coverage
npm run build
```

GitHub Actions workflow `.github/workflows/ci.yml` 은 위 순서를 자동으로 실행한다.

## Rust + WASM Decoder

현재 Rust + WASM 경계는 point decoding hot path 에 적용되어 있다.

- `copc.js`: metadata / hierarchy / LAZ point view
- `copc-wasm`: X/Y/Z dimension 을 interleaved point buffer 로 디코딩
- TypeScript: CRS transform, streaming selection, Cesium rendering

## 샘플 데이터

샘플 COPC 파일은 저장소에 포함하지 않고 별도 다운로드합니다.

```bash
npm install
npm run download-samples -- autzen
```

기본 저장 위치는 `samples/local/`입니다.

2026-06-29 검증 기준으로 `autzen`과 `sofi` 링크는 공개 HTTPS S3 객체로 정상 응답했고, `millsite` 링크는 `404 Not Found` 상태입니다.

## 현재 상태

- [x] 프로젝트 구조 설계
- [x] COPC reader 계층 정리
- [x] generalized hierarchy traversal
- [x] 좌표 변환 + Cesium point rendering 연결
- [x] Camera based streaming selection
- [x] basic LoD node rendering
- [x] Bounded node request cache
- [x] Public viewer API entrypoint
- [x] API 문서 및 예제 정리
- [x] Rust + WASM point decoder 전환

## 참고

- https://copc.io
- https://github.com/connormanning/copc.js
- https://github.com/pka/copc-rs
- https://github.com/potree/potree
- https://www.kossa.kr/materials/2026/ossp/tasks-gaia3d.html

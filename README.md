# COPC Adapter

COPC (Cloud Optimized Point Cloud) 데이터를 Web(CesiumJS)에서 실시간으로 스트리밍 렌더링하는 실험 프로젝트입니다.

Rust + WASM 기반 COPC 처리 모듈과 TypeScript 기반 Cesium Viewer를 결합하여,
사전 타일링 없이 원본 COPC 파일을 직접 시각화하는 것을 목표로 합니다.

---

## 목표

- COPC 파일 직접 로딩
- Octree 기반 스트리밍 구조 이해 및 구현
- CesiumJS 기반 3D Point Cloud 렌더링
- Rust + WASM 기반 COPC 파서 개발
- 필요 영역만 동적으로 로딩 (LOD)

---

## 핵심 개념

- COPC (Cloud Optimized Point Cloud)
- Point Cloud (LiDAR 3D 점 데이터)
- Octree (공간 분할 구조)
- LOD (Level of Detail)
- WASM (Rust ↔ Web 브릿지)
- CesiumJS (3D Globe Rendering Engine)

---

## 구조

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

## 실행 방법

### Web 실행

```bash
cd apps/viewer-web
npm install
npm run dev
```

기본 샘플 URL은 `/samples/autzen.copc.laz` 이며, 현재 viewer는 아래 순서로 동작합니다.

1. COPC metadata 로딩
2. root hierarchy 로딩
3. camera 위치 기반 node selection
4. LoD 기준으로 렌더링 대상 node 선택
5. 선택된 node point decoding + cache
6. CRS -> WGS84 + meters 좌표 변환
7. Cesium point primitive 렌더링

## Library API

public entrypoint 는 `apps/viewer-web/src/index.ts` 이다.

```ts
import { createCopcViewer } from './src';

const viewer = await createCopcViewer({
  container: 'cesium-container',
  url: '/samples/autzen.copc.laz',
});

console.log(viewer.getSnapshot());
```

상세 API 는 [docs/API.md](/Users/mars112/code/project/copc-adapter/docs/API.md), 예제는 [docs/EXAMPLES.md](/Users/mars112/code/project/copc-adapter/docs/EXAMPLES.md) 에 정리했다.

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
- [x] 좌표 변환 + Cesium point rendering 연결
- [x] Camera based streaming selection
- [x] LoD 기반 node rendering
- [x] Node request cache
- [x] Public viewer API entrypoint
- [x] API 문서 및 예제 정리
- [ ] Rust + WASM decoder 전환

## 참고

- https://copc.io
- https://github.com/connormanning/copc.js
- https://github.com/pka/copc-rs
- https://github.com/potree/potree
- https://www.kossa.kr/materials/2026/ossp/tasks-gaia3d.html

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

## 실행 방법 (예정)

### WASM 빌드

```bash
wasm-pack build crates/copc-wasm --target web
```

### Web 실행

```bash
cd apps/viewer-web
npm install
npm run dev
```

## 현재 상태

- [x] 프로젝트 구조 설계
- [ ] COPC WASM 파서
- [ ] Cesium Viewer 연동
- [ ] Octree 기반 스트리밍
- [ ] LOD 구현

## 참고

- https://copc.io
- https://github.com/connormanning/copc.js
- https://github.com/potree/potree

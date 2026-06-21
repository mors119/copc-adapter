# Roadmap

## Phase 0 - Setup (완료 예정)

- [x] Workspace 구성
- [x] WASM 기본 모듈 생성
- [ ] Vite + Cesium 환경 구성

---

## Phase 1 - WASM Bridge

목표:
Rust → Web 연결

- hello() WASM 호출
- metadata JSON 반환
- JS ↔ Rust 데이터 교환 구조 확립

---

## Phase 2 - COPC Metadata

목표:
COPC 파일 구조 이해

- COPC Header parsing
- bounds / point count 추출
- 파일 구조 분석

---

## Phase 3 - Basic Rendering

목표:
Cesium에 점 표시

- 1000 points rendering
- Cesium PointPrimitive 사용
- camera integration

---

## Phase 4 - Octree Streaming

목표:
필요한 데이터만 로딩

- Octree traversal
- LOD 기반 node selection
- dynamic loading

---

## Phase 5 - Full COPC Adapter

- large dataset support
- smooth camera movement
- streaming optimization

---

## Phase 6 - Rust Optimization (optional)

- full COPC decoder in Rust
- WebWorker offload
- WASM performance tuning

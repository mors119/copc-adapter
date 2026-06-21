# Architecture - COPC Adapter

## 전체 구조

COPC Adapter는 다음과 같은 2-layer 구조를 가진다.

---

## 1. Web Layer (TypeScript + CesiumJS)

역할:

- 사용자 인터페이스
- Cesium Globe 렌더링
- 카메라 이벤트 처리
- WASM 모듈 호출

구성:

- Cesium Viewer 초기화
- Point Cloud Primitive 생성
- LOD 기반 렌더링 요청
- WASM ↔ JS 브릿지

---

## 2. Core Layer (Rust + WASM)

역할:

- COPC 파일 파싱
- Octree 구조 해석
- Metadata 추출
- 필요한 Chunk 반환

구성:

- COPC Header Parser
- Octree Traversal Engine
- Point Chunk Decoder
- WASM Interface Layer

---

## 데이터 흐름

COPC File
↓
Rust WASM Parser
↓
Octree Node Selection
↓
JS (TypeScript)
↓
CesiumJS Rendering

---

## 핵심 설계 철학

### 1. Lazy Loading

필요한 영역만 로딩

### 2. Streaming First

전체 파일을 다운로드하지 않음

### 3. Separation of Concerns

- Rust: 데이터 처리
- TS: 렌더링
- Cesium: GPU 시각화

---

## 확장 방향

- Rust 기반 full COPC parser
- WebWorker 분리
- GPU 기반 point rendering 최적화

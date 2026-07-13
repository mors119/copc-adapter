# Roadmap

`docs/AGENTS.MD`의 아키텍처 원칙과 현재 구현 상태를 기준으로 정리한 실행 로드맵이다.

최종 목표:

> CesiumJS에서 COPC 파일을 전처리 없이 직접 로딩하고, 대용량 포인트 클라우드를 스트리밍 기반으로 시각화하는 재사용 가능한 라이브러리를 만든다.

## Current Status

- [x] Vite + Cesium 기반 viewer 앱 구성
- [x] Rust `copc-wasm` 크레이트 생성
- [x] `metadata/`, `hierarchy/`, `points/`, `cesium/`, `viewer/` 계층 골격 구성
- [x] COPC metadata 로딩 프로토타입
- [x] Root hierarchy 로딩 프로토타입
- [x] Point data view 로딩 프로토타입
- [x] 실제 COPC 데이터 -> 내부 포인트 타입 -> Cesium 렌더링 전체 경로 연결
- [x] 샘플 COPC 좌표계 -> WGS84 + meters 변환
- [x] Cesium 포인트 렌더링 파이프라인 연결
- [x] camera 기반 streaming node selection
- [x] LoD 기반 rendering selection
- [x] node request cache
- [x] incremental load / unload 렌더링 갱신
- [x] public viewer API entrypoint
- [x] API 문서와 예제 추가
- [x] Rust + WASM point decoder replacement
- [x] npm / cargo build 경로 통합
- [ ] coverage / CI quality gate 정리

## Phase 1 - COPC Reader Stabilization

목표:
`copc.js` 의존성을 내부 타입 뒤로 숨기고 metadata, hierarchy, points 계층을 안정화한다.

- [x] `metadata/`에서 `CopcMetadata` 반환 경로 확정
- [x] `hierarchy/`에서 root hierarchy를 `CopcHierarchyNode[]`로 안정적으로 변환
- [x] `points/`에서 raw point view를 프로젝트 소유 타입으로 변환
- [x] 외부 라이브러리 타입이 core domain 전반에 새지 않도록 adapter 경계 정리
- [ ] 에러 타입과 메시지 규칙 적용
- [x] 각 계층의 단위 테스트 추가

완료 기준:

- metadata, hierarchy, points가 각자 단일 책임을 유지한다.
- `copc.js` 타입이 public API 또는 core domain에 직접 노출되지 않는다.
- 정상 케이스, invalid input, edge case 테스트가 존재한다.

## Phase 2 - Point Rendering Pipeline

목표:
COPC 포인트를 내부 타입으로 읽어 Cesium에 실제로 표시한다.

- [x] `CopcPoint` 또는 동등한 내부 포인트 타입 확정
- [x] point reader에서 X/Y/Z 추출 및 스케일/오프셋 반영
- [x] 좌표 변환 계층 정리
- [x] Cesium 렌더러가 내부 포인트 타입만 입력받도록 정리
- [x] viewer가 metadata -> points -> render 흐름을 orchestration 하도록 연결
- [x] 샘플 COPC 파일 기준 기본 렌더링 검증

완료 기준:

- dummy 데이터가 아니라 실제 COPC 점이 화면에 렌더링된다.
- viewer 계층에 저수준 디코딩 로직이 남지 않는다.
- Cesium 관련 로직은 `cesium/` 안에만 존재한다.

## Phase 3 - Streaming Viewer

목표:
대용량 데이터를 전체 로드하지 않고 필요한 노드만 선택해 렌더링한다.

- [x] Node selection
- [x] LoD
- [x] Camera based loading
- [x] Cache

완료 기준:

- [x] 전체 파일을 메모리에 올리지 않는다.
- [x] 카메라 이동에 따라 필요한 노드만 로딩한다.
- [x] 메모리 사용량과 중복 요청이 통제된다.

## Phase 4 - Library API

목표:
viewer 앱 프로토타입을 재사용 가능한 라이브러리 API로 정리한다.

- [x] public entrypoint 정의
- [x] `CopcViewer` API 정리
- [x] 옵션, 에러, lifecycle 문서화
- [x] 최소 예제와 사용 문서 추가
- [x] 외부 의존성 노출 여부 점검

완료 기준:

- 소비자는 공개 API만으로 COPC 로딩과 렌더링을 사용할 수 있다.
- public module과 exported function 문서가 존재한다.
- 예제로 기본 사용 흐름을 재현할 수 있다.

## Phase 5 - Quality Gates

목표:
`docs/AGENTS.MD`의 개발 규칙을 CI 수준으로 강제한다.

- [ ] unit test 정비
- [ ] integration test가 필요한 흐름 선별 및 추가
- [ ] type check, lint, build 검증 정리
- [ ] coverage 기준 수립 및 자동화
- [ ] production build 검증

완료 기준:

- Line Coverage >= 90%
- Branch Coverage >= 85%
- critical modules는 가능한 100%에 가깝게 유지
- 커밋 전 build, lint, test, coverage, production build를 검증할 수 있다.

## Phase 6 - Rust + WASM Transition

목표:
현재 TypeScript decoding 경로를 대체 가능한 Rust + WASM 구조로 발전시킨다.

- [x] Rust decoder 인터페이스 설계
- [x] WASM adapter가 내부 타입 계약을 유지하도록 설계
- [x] TypeScript adapter와 교체 가능한 경계 정리
- [x] 성능 개선용 interleaved point buffer 경로 적용
- [ ] 필요 시 WebWorker offload 검토

완료 기준:

- [x] 디코딩 계층 교체가 viewer/renderer/public API 변경 없이 가능하다.
- [x] Rust + WASM 경로가 성능 최적화 용도로 독립적으로 발전 가능하다.

## Next Priorities

우선순위는 아래 순서로 진행한다.

1. Phase 1 완료
2. hierarchy page 확장 로딩과 더 깊은 octree traversal 일반화
3. coverage / CI quality gate 자동화
4. Rust decoder를 full COPC parsing 단계까지 확장

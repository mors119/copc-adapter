---
layout: home

hero:
  name: COPC Adapter
  text: COPC를 CesiumJS에서 바로 스트리밍
  tagline: 별도의 Cesium용 타일 변환 없이 COPC 원본을 HTTP Range와 LoD로 필요한 만큼만 읽어 가시화합니다.
  actions:
    - theme: brand
      text: 시작하기
      link: /ko/getting-started
    - theme: alt
      text: 검증 결과 보기
      link: /ko/validation

features:
  - title: 원본 COPC 직접 사용
    details: COPC를 3D Tiles 같은 별도 렌더러 포맷으로 다시 변환하지 않고 브라우저에서 직접 읽습니다.
  - title: 필요한 구간만 읽기
    details: HTTP Range 요청으로 메타데이터, hierarchy page, 선택된 point chunk를 부분적으로 가져옵니다.
  - title: 카메라 기반 LoD
    details: 현재 시야와 screen-space error를 기준으로 필요한 노드를 선택하고 점진적으로 더 상세한 데이터로 전환합니다.
  - title: 검증 가능한 구조
    details: Range, cache, Worker, CRS, 대용량 데이터 검증 결과를 코드와 함께 확인할 수 있습니다.
---

# 한글 문서 안내

이 한글 문서는 **처음 프로젝트를 보는 사람과 직접 코드를 공부하는 사람**을 기준으로 작성합니다.

영문 문서 전체를 그대로 번역하기보다, 먼저 아래 순서대로 읽으면 프로젝트 구조를 이해할 수 있도록 구성합니다.

1. [빠른 시작](/ko/getting-started)
2. [COPC 스트리밍과 LoD 이해하기](/ko/streaming)
3. [HTTP Range / CORS 요구사항](/ko/source-requirements)
4. [색상 표현과 점 선택](/ko/styling-and-picking)
5. [API 빠른 참조](/ko/api)
6. [아키텍처와 소스 코드 위치](/ko/architecture)
7. [검증 결과](/ko/validation)
8. [문서 수정 방법](/ko/editing-docs)

::: tip 영문 기술 문서
세부 타입과 구현 계약은 기존 [Public API](/API), [Architecture](/ARCHITECTURE), [Conformance](/CONFORMANCE) 문서를 기준으로 합니다.
:::

## 프로젝트를 한 문장으로

COPC Adapter는 다음 흐름을 브라우저 안에서 수행하는 라이브러리입니다.

```text
COPC URL
  ↓
HTTP Range
  ↓
COPC hierarchy
  ↓
현재 카메라에 필요한 node 선택
  ↓
LAZ decode / 좌표 변환
  ↓
점·노드 budget + cache
  ↓
CesiumJS
```

가장 중요한 점은 **COPC 원본을 Cesium 전용 타일 파일로 미리 변환하지 않는다는 것**입니다.

## 현재 중심 범위

대회 지정과제와 실제 라이브러리 사용 관점에서 가장 중요한 경로는 CesiumJS입니다.

Three.js 지원도 존재하지만, 이 한글 가이드에서는 먼저 다음에 집중합니다.

- COPC 직접 로딩
- HTTP Range
- hierarchy와 LoD
- 점진적 갱신
- point/node budget
- cache
- CRS → WGS84/ECEF
- RGB / elevation / intensity / classification
- point picking
- Worker 및 대용량 검증

Three.js의 세부 동작은 [Public API](/API)와 README의 Three.js 섹션을 참고하세요.

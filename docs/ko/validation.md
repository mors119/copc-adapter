# 검증 결과

이 페이지는 COPC Adapter가 무엇을 **실제로 검증했는지**와 무엇을 아직 일반화해서 말하면 안 되는지를 정리합니다.

## 핵심 검증 항목

| 영역 | 현재 근거 |
| --- | --- |
| COPC 직접 로딩 | Cesium browser/E2E 및 packed consumer |
| HTTP Range | 요청/응답 range 검증, `206`, `Content-Range` 검사 |
| hierarchy / LoD | Autzen camera-driven streaming regression |
| 점진적 coarse/fine 전환 | coverage transition 테스트 |
| point/node budget | streaming deterministic + browser validation |
| decoded point cache | hit/miss/byte bound/eviction diagnostics |
| Worker | Rust backend Worker responsiveness 검증 |
| obsolete Range cancellation | generation/lifecycle cancellation 테스트 |
| Range coalescing | Autzen/SoFi 요청 패턴 측정 후 bounded merge |
| runtime styling/filter | cached buffer 기반 `setStyle()` regression |
| EPSG:5186 | authoritative control 기반 conformance + Cesium placement smoke |
| multi-GB | SoFi 약 2.03 GB browser validation |

## Autzen

Autzen은 프로젝트의 기본 회귀/시연 데이터입니다.

현재 local sample은 약 81 MB 규모이며 다음을 반복적으로 검증하는 데 사용합니다.

- 직접 COPC loading
- Range request
- camera-driven hierarchy selection
- LoD
- point/cache budget
- Rust Worker
- renderer transition
- point picking
- style

## SoFi multi-GB

현재 검증 기록의 source 크기:

```text
2,029,696,615 bytes
364,384,576 points
```

기록된 browser run에서는 전체 object를 다운로드하지 않고 144개의 검증된 `206` Range 응답으로 총 6,695,017 bytes를 전달했습니다.

이는 source 전체의 약 0.330%입니다.

또한 기록된 run에서:

- rendered point budget: 250,000
- decoded CPU point cache cap: 256 MiB
- observed cache maximum: 약 37.7 MB
- 이전 area로 돌아갔을 때 추가 point Range 없이 cache reuse 확인
- obsolete Range 1건 superseded 처리
- Rust Worker 최대 4 active 확인

단, 이 결과에는 중요한 제한이 있습니다.

::: warning SoFi 결과는 LIMITED
공개 SoFi endpoint는 `Content-Range`를 브라우저 JavaScript에 노출하지 않습니다.

따라서 검증에서는 실제 upstream Range byte를 전달하는 Playwright route가 누락된 `Access-Control-Expose-Headers`만 보완했습니다.

즉 “SoFi 공개 URL을 아무 설정 없이 브라우저에 넣으면 바로 된다”는 증거가 아닙니다.
:::

상세 기록:

- [SoFi multi-GB streaming validation](/benchmarks/issue-212-sofi-multigb-streaming)

## Worker 검증

Rust backend는 Worker가 가능한 browser에서 bounded Worker pool을 사용합니다.

검증에서는 실제 wheel input과 camera change가 Worker active 시점에 발생하는 것을 관찰했습니다.

다만 Worker가 모든 main-thread 작업을 제거한다는 뜻은 아닙니다.

Cesium primitive 준비와 browser rendering은 여전히 main thread/GPU pipeline의 영향을 받습니다.

상세 기록:

- [Worker responsiveness](/benchmarks/issue-208-worker-responsiveness)

## Range coalescing

측정 결과:

- Autzen: 해당 capture에서는 병합 이득 없음
- SoFi root-node batch: point request 8개 → 7개, 전송 byte 증가 없음

현재 구현은 무조건 Range를 크게 합치지 않습니다.

- 같은 JavaScript turn에 queue된 요청만
- gap 최대 4 KiB
- merged span 최대 1 MiB

이라는 bounded 조건을 사용합니다.

상세 기록:

- [Range coalescing](/benchmarks/issue-210-range-coalescing)

## EPSG:5186

EPSG:5186 KGD2002 / Central Belt 2010에 대해 authoritative control과 독립적으로 생성한 expected coordinate를 fixture로 유지합니다.

검증 목적은 다음과 같습니다.

- false easting/northing 중복 적용 방지
- axis order 오류 방지
- unit 중복 변환 방지
- WGS84/ECEF 결과 conformance
- Cesium에서 한국 영역 placement smoke

Autzen 자체가 EPSG:5186 데이터라는 뜻은 아닙니다.

## 대회 기능시험

실제 2026 오픈소스 개발자대회 기능시험 절차는 별도의 runbook으로 관리합니다.

- [Cesium contest functional-test runbook](/CONTEST-FUNCTIONAL-TEST)

이 문서는 공개 기술 검증과 심사 당일 동작 절차를 섞지 않기 위해 분리되어 있습니다.

## 숫자를 읽을 때 주의할 점

benchmark 문서의 시간/FPS/Long Task 수치는 특정 머신과 browser에서 측정한 한 번의 관찰입니다.

다음처럼 해석하면 안 됩니다.

- 모든 PC에서 같은 FPS 보장
- browser 전체 memory 사용량 보장
- GPU memory 정확한 측정
- 모든 COPC source에서 동일한 latency 보장

대신 다음을 검증하는 증거로 사용합니다.

- 전체 파일을 받지 않고 필요한 범위만 읽는가
- budget이 실제로 지켜지는가
- cache가 재사용되는가
- stale work가 안전하게 취소되는가
- 특정 backend path가 실제 browser/package에서 동작하는가

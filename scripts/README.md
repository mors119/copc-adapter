# Scripts

개발 환경 준비를 위한 자동화 스크립트를 관리합니다.

현재 지원:

- `download-samples`
  `npm run download-samples`로 추천 샘플을 다운로드합니다.
  `npm run download-samples -- autzen`처럼 데이터셋 id를 넘기면 선택 다운로드합니다.
- `benchmark:streaming`
  `npm run benchmark:streaming --prefix apps/viewer-web`로 Autzen streaming,
  budget, stale-work, and decoded CPU cache validation을 실행합니다.
- `audit:crs`
  `npm run audit:crs -- --wasm --benchmark`로 checked-in WKT fixtures를
  `proj4js`와 차분 비교하고 native Rust/WASM CRS benchmark를 실행합니다.

패키지 빌드, Rust/WASM 준비, 테스트, conformance, browser 검증 명령은
각 package script와 [기여 가이드](../CONTRIBUTING.md)에서 관리합니다.

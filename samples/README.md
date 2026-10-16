# Sample Datasets

이 프로젝트는 대용량 COPC 데이터를 Git 저장소에 포함하지 않습니다.

샘플 데이터는 아래 명령으로 자동 다운로드할 수 있습니다.

```bash
npm run setup
npm run download-samples
npm run download-samples -- autzen
```

`npm run setup`은 검증용 Autzen의 설정된 파일 크기와 SHA-256을 확인합니다.
Cesium 개발 서버는 `samples/local/` 파일을 same-origin HTTP Range
미들웨어로 직접 제공합니다. 정적 호스트에 게시할 때만 `apps/dev-viewer/public/samples/`
아래에 별도 복사본을 둘 수 있습니다.

기본 저장 위치:

`samples/local/`

지원되는 샘플 목록은 [datasets.json](datasets.json)에서 관리됩니다.

2026-06-29 기준 링크 확인 결과:

- `autzen`: `200 OK`, 공개 S3 객체, 다운로드 가능
- `sofi`: `200 OK`, 공개 S3 객체, 다운로드 가능
- `millsite`: `404 Not Found`, 현재 URL 기준 다운로드 불가

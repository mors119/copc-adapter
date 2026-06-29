# Sample Datasets

이 프로젝트는 대용량 COPC 데이터를 Git 저장소에 포함하지 않습니다.

샘플 데이터는 아래 명령으로 자동 다운로드할 수 있습니다.

```bash
npm run download-samples
npm run download-samples -- autzen
```

기본 저장 위치:

`samples/local/`

지원되는 샘플 목록은 [datasets.json](/Users/mars112/code/project/copc-adapter/samples/datasets.json)에서 관리됩니다.

2026-06-29 기준 링크 확인 결과:

- `autzen`: `200 OK`, 공개 S3 객체, 다운로드 가능
- `sofi`: `200 OK`, 공개 S3 객체, 다운로드 가능
- `millsite`: `404 Not Found`, 현재 URL 기준 다운로드 불가

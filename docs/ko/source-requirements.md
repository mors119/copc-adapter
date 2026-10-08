# HTTP Range / CORS 요구사항

COPC Adapter가 URL 기반 source를 브라우저에서 직접 읽으려면 서버가 **부분 byte 요청**을 제대로 지원해야 합니다.

## 정상적인 응답

브라우저가 다음처럼 요청했다고 가정합니다.

```http
Range: bytes=0-1023
```

정상적인 source는 대략 다음 조건을 만족해야 합니다.

```http
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1023/<전체 크기>
Content-Length: 1024
```

COPC Adapter는 서버가 Range 요청을 무시하고 `200 OK`로 전체 파일을 보내는 경우를 정상 streaming source로 취급하지 않습니다.

## CORS와 Range는 다른 문제

두 조건은 따로 확인해야 합니다.

### Range 지원

서버가 실제 byte 범위를 반환하는가?

### CORS

브라우저의 애플리케이션 origin에서 그 응답을 읽을 수 있는가?

외부 source라면 일반적으로 다음이 필요합니다.

- 애플리케이션 origin 허용
- `Range` 요청 header 허용
- `Content-Range` 응답 header 노출

특히 `Content-Range`는 서버가 보내더라도 브라우저 JavaScript에 노출하지 않으면 검증할 수 없습니다.

## source probe

문제 발생 시 먼저 source를 검사합니다.

```ts
import { probeCopcSource } from '@frillab/copc-adapter';

const result = await probeCopcSource(url);
console.table(result);
```

확인할 핵심 값은 다음과 같습니다.

- `reachable`
- `rangeSupported`
- `corsReadable`
- `copcDetected`
- `pointFormat`
- warning/error 메시지

probe는 전체 파일을 다운로드하기 위한 기능이 아닙니다. 필요한 prefix/VLR 범위만 제한적으로 읽습니다.

## 자주 발생하는 문제

### 서버가 200을 반환함

가능한 원인:

- object storage 설정
- CDN 또는 reverse proxy가 `Range`를 제거
- 서버가 부분 요청을 무시

### 브라우저에서는 실패하지만 curl/Node에서는 성공함

CORS 가능성이 큽니다.

특히 `Access-Control-Expose-Headers`에 `Content-Range`가 빠져 있는지 확인하세요.

### SoFi 공개 source의 현재 검증 사례

프로젝트의 SoFi multi-GB 검증에서는 원본 endpoint가 `206`과 올바른 `Content-Range` 자체는 반환했지만, 브라우저 JavaScript에 `Content-Range`를 노출하지 않아 직접 browser source로는 제한이 있었습니다.

따라서 검증 보고서는 이를 **LIMITED**로 기록하고 있으며, 테스트 route가 실제 upstream Range byte를 전달하면서 누락된 노출 header만 보완해 측정했습니다.

자세한 기록:

- [SoFi multi-GB streaming validation](/benchmarks/issue-212-sofi-multigb-streaming)

## 관련 구현

- `apps/viewer-web/src/copc/range/httpRangeSource.ts`
- `apps/viewer-web/src/copc/range/contentRange.ts`
- `apps/viewer-web/src/copc/sourceProbe.ts`

::: tip 서버 설정을 먼저 확인하세요
COPC가 화면에 안 나온다고 해서 바로 decoder나 Cesium 문제라고 판단하지 마세요. URL source 문제의 상당수는 Range 또는 CORS 단계에서 먼저 발견할 수 있습니다.
:::

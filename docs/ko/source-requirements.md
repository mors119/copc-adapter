# COPC 원본 호스팅: 브라우저 HTTP Range / CORS

COPC Adapter는 원본 객체의 여러 byte offset을 직접 읽습니다. 정상
배포에는 HTTP 부분 응답과, cross-origin으로 사용할 때 브라우저가 그
응답을 검사할 수 있는 CORS 설정이 모두 필요합니다. 두 조건은 서로
다릅니다.

아래의 `https://viewer.example.com`, bucket, host 이름을 실제 환경에 맞게
바꾸세요. origin은 scheme, host, 선택적 port로 구성되며 경로나 마지막
슬래시를 포함하지 않습니다. 예시는 명시한 웹 origin만 허용하며 그
자체로 객체 접근 권한을 부여하지 않습니다.

## 필요한 HTTP 응답

다음과 같은 요청을 받았다고 가정합니다.

```http
GET /data.copc.laz HTTP/1.1
Range: bytes=0-1023
```

정상 응답은 다음과 같습니다.

```http
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1023/2030000
Content-Length: 1024
```

응답 body는 이 요청에 대해 정확히 1,024 bytes여야 합니다.
`Content-Length`가 있다면 전체 객체가 아니라 부분 body의 크기를 나타내며
`1024`여야 합니다. adapter는 header 값만 믿지 않고 실제 수신한 body 길이를
확인합니다. `Content-Range` 슬래시 뒤에는 알고 있는 경우 전체 객체 크기를
표시하고, 서버가 전체 크기를 모를 때는 `*`를 사용할 수 있습니다. 숫자
크기가 있으면 진단에 더 유용합니다. 이는 [RFC 9110의
`Content-Range` 문법](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.4)에
따릅니다.
Range 요청에 대한 `200 OK`는 보통 서버, CDN 또는 proxy가 `Range`를
무시하거나 제거했다는 뜻입니다. `Accept-Ranges: bytes`만으로 요청한
범위가 동작한다고 증명할 수는 없습니다. byte offset이 저장된 원본과
일치하도록 COPC 경로에는 gzip/Brotli 압축이나 다른 변환을 적용하지
마세요.

## HTTP Range와 브라우저 CORS는 별도 조건

- **Range 지원**은 HTTP 동작입니다. 서버가 `206`, 요청과 일치하는
  `Content-Range`, 요청한 byte를 반환해야 합니다.
- **CORS**는 다른 origin의 JavaScript가 응답을 읽을 수 있는지 정합니다.
  응답의 `Access-Control-Allow-Origin`에 애플리케이션 origin이 허용되어야
  합니다. `Content-Range`는 CORS 응답 safelist에 포함되지 않으므로
  JavaScript에서 읽으려면 `Access-Control-Expose-Headers`에도 명시해야
  합니다. `Content-Length`는 safelist에 포함되므로 꼭 노출 목록에 넣을
  필요는 없지만, 진단 편의를 위해 함께 넣어도 됩니다.
- **Preflight는 조건부입니다.** `Range: bytes=0-1023`처럼 단일 byte 범위를
  지정한 `GET`의 `Range`는 CORS 요청 safelist에 포함되므로 이것만으로는
  `OPTIONS` preflight가 발생하지 않습니다. 다중 범위 값,
  `Authorization`, 다른 safelist 외 요청 header, 또는 단순 요청에 속하지
  않는 method가 있으면 preflight가 발생할 수 있습니다. 실제 preflight가
  오면 요청 method와 header를 서버가 허용해야 합니다. 허용 목록에
  `Range`를 넣어도 preflight를 발생시키지는 않습니다.

CORS는 인증이나 접근 권한 제어가 아닙니다. bucket/object 정책, 서명 URL,
애플리케이션 접근 검사를 유지하세요. Cookie 자격 증명을 쓰려면 브라우저
요청이 credentials를 사용하도록 설정되어야 하고, 응답은 정확한 허용
origin과 `Access-Control-Allow-Credentials: true`를 보내야 하며, 캐시가
사용자별 응답을 섞지 않아야 합니다. 자격 증명 요청에
`Access-Control-Allow-Origin: *`를 함께 사용하지 마세요. 아래 예시는
cross-origin cookie에 의존하지 않는 요청을 대상으로 합니다. 자세한 내용은
[Fetch CORS 요청 safelist 규칙](https://developer.mozilla.org/en-US/docs/Glossary/CORS-safelisted_request_header),
[CORS 응답 header 노출](https://developer.mozilla.org/en-US/docs/Glossary/CORS-safelisted_response_header),
[AWS S3 CORS 규칙 항목](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html)을
참고하세요.

## AWS S3

아래 내용을 `cors.json`으로 저장해 bucket에 적용합니다.
`AllowedHeaders`는 브라우저가 preflight를 보낼 때 확인하는 요청 header이고,
`ExposeHeaders`는 JavaScript가 읽을 수 있는 응답 header입니다.

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://viewer.example.com"],
      "AllowedMethods": ["GET", "HEAD"],
      "AllowedHeaders": ["Range"],
      "ExposeHeaders": ["Accept-Ranges", "Content-Length", "Content-Range"],
      "MaxAgeSeconds": 600
    }
  ]
}
```

```bash
aws s3api put-bucket-cors \
  --bucket YOUR_COPC_BUCKET \
  --cors-configuration file://cors.json
aws s3api get-bucket-cors --bucket YOUR_COPC_BUCKET
```

S3의 `AllowedMethods`는 실제 요청 method인 `GET`/`HEAD`를 지정합니다.
여기에 `OPTIONS`를 추가하지 마세요. S3는 bucket CORS 규칙으로 브라우저
preflight를 판정하고 응답합니다. 브라우저가 `Authorization`이나 다른
사용자 지정 header를 보내면 실제 사용하는 header 이름만
`AllowedHeaders`에 추가하고 preflight 응답을 확인하세요. 이 규칙은 private
객체를 공개하지 않습니다. 요청에는 권한이 부여된 bucket/object 정책이나
유효한 서명 URL이 여전히 필요합니다. S3 bucket CORS 설정에는
`Access-Control-Allow-Credentials`를 지정하는 항목이 없습니다. cookie 인증
흐름은 실제 브라우저 응답을 확인하기 전까지 지원된다고 가정하지 마세요.

S3 앞에 CloudFront가 있다면 CORS에 맞게 cache behavior를 설정하세요.
`Origin`을 origin으로 전달하고, `OPTIONS`를 캐시한다면
`Access-Control-Request-Method`와 `Access-Control-Request-Headers`도 origin에
전달하고 cache key에 포함해야 합니다. S3 주소만 확인하지 말고 실제
CloudFront URL에서 Range 동작을 검증하세요. 문서: [S3 CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html),
[CloudFront CORS header 전달](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/header-caching.html).

## MinIO AIStor

`mc cors set`으로 bucket CORS를 지원하는 MinIO AIStor 버전에서는 아래 S3
호환 CORS 문서를 `cors-config.xml`로 저장합니다.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<CORSConfiguration>
  <CORSRule>
    <AllowedOrigin>https://viewer.example.com</AllowedOrigin>
    <AllowedMethod>GET</AllowedMethod>
    <AllowedMethod>HEAD</AllowedMethod>
    <AllowedHeader>Range</AllowedHeader>
    <ExposeHeader>Accept-Ranges</ExposeHeader>
    <ExposeHeader>Content-Length</ExposeHeader>
    <ExposeHeader>Content-Range</ExposeHeader>
    <MaxAgeSeconds>600</MaxAgeSeconds>
  </CORSRule>
</CORSConfiguration>
```

```bash
mc cors set myminio/YOUR_COPC_BUCKET cors-config.xml
mc cors get myminio/YOUR_COPC_BUCKET
```

서버 버전과 호환되는 `mc`를 사용하고 실제 배포 edition에서 bucket CORS를
지원하는지 확인하세요. MinIO 배포판과 버전에 따라 기능이 다릅니다.
전역 `MINIO_API_CORS_ALLOW_ORIGIN` 설정은 `Content-Range` 노출을 설정하는
bucket 규칙을 대신할 수 없습니다. AIStor 문서상 전역 origin 기본값은 `*`이며,
wildcard일 때는 요청 origin을 그대로 돌려주면서
`Access-Control-Allow-Credentials: true`도 기본 설정으로 보낼 수 있습니다.
운영에서 이처럼 넓은 전역 동작에 의존하지 말고 bucket별 정확한 허용 목록을
사용하세요. AIStor에서는 bucket별 CORS 규칙이 전역 설정에 우선합니다.
서버가 응답 header 노출을 설정할 수 없다면 통제 가능한 gateway/proxy에서
추가하거나 bucket CORS API를 지원하는 MinIO 버전을 사용하세요. S3와
마찬가지로 CORS는 객체 권한을 주지 않습니다. 사용자 지정 요청 header는
브라우저가 실제 전송할 때만 preflight 정책에 허용하세요.
공식 문서: [MinIO AIStor CORS 가이드](https://docs.min.io/aistor/administration/cors-configuration/),
[`mc cors set` 레퍼런스](https://docs.min.io/aistor/reference/cli/mc-cors/mc-cors-set/).

## nginx reverse proxy

아래 예시는 `/copc/` 경로가 동일한 upstream에서 공개 읽기 가능한 객체를
제공하는 전용 host를 가정합니다. origin 허용 목록을 좁게 유지하세요.
`map`은 nginx `http {}` 문맥에 넣고, `server`/`location`은 해당 virtual
host에 병합합니다. proxy cache와 cookie credentials는 사용하지 않는
예시입니다. TLS 인증서와 key 경로는 발급받은 인증서 파일에 맞게 바꾸세요.
이 설정은 nginx `add_header ... always`(1.7.5 이상)와
`proxy_ssl_server_name`, `proxy_ssl_verify`, `proxy_ssl_trusted_certificate`
지시어(1.7.0 이상)를 사용합니다. 아래 CA 번들 경로는 Debian/Ubuntu의
예시입니다. 실제 host나 container에서 nginx 프로세스가 읽을 수 있는 PEM
신뢰 번들 경로로 바꾸세요. 비공개 origin CA를 사용한다면 해당 CA를 신뢰하는
번들을 지정해야 합니다. `proxy_pass`의 hostname은 upstream 인증서의 이름과
일치해야 합니다.

```nginx
map $http_origin $copc_cors_origin {
    default "";
    "https://viewer.example.com" $http_origin;
}

server {
    listen 443 ssl;
    server_name copc.example.com;
    ssl_certificate /etc/letsencrypt/live/copc.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/copc.example.com/privkey.pem;

    location /copc/ {
        # Preflight가 발생하는 요청만 처리합니다.
        if ($request_method = OPTIONS) { return 204; }

        proxy_pass https://copc-origin.internal.example.net;
        proxy_ssl_server_name on;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
        proxy_cache off;

        # nginx가 CORS 응답 header를 소유해 중복 값을 피합니다.
        proxy_hide_header Access-Control-Allow-Origin;
        proxy_hide_header Access-Control-Allow-Methods;
        proxy_hide_header Access-Control-Allow-Headers;
        proxy_hide_header Access-Control-Expose-Headers;
        proxy_hide_header Access-Control-Allow-Credentials;

        add_header Access-Control-Allow-Origin $copc_cors_origin always;
        add_header Access-Control-Allow-Methods "GET, HEAD" always;
        add_header Access-Control-Allow-Headers "Range" always;
        add_header Access-Control-Expose-Headers "Accept-Ranges, Content-Length, Content-Range" always;
        add_header Vary "Origin" always;
    }
}
```

nginx는 별도 설정으로 바꾸지 않으면 `Range`를 포함한 client 요청 header를
upstream에 전달합니다. 다른 proxy 설정에서 이를 덮어쓰거나 제거하지
마세요. 올바른 `206`, `Content-Range`, body는 upstream이 반환해야 합니다.
이 proxy 예시는 브라우저 CORS 응답 header만 추가하며 잘못된 byte 범위를
수정하지 않습니다. 애플리케이션이 `Authorization`을 보내면
`Access-Control-Allow-Headers`에 추가하고 upstream이 실제 인증하는지
확인하세요. Cookie 인증 요청은 정확한 origin 허용 목록을 유지하고
애플리케이션이 의도적으로 credentials fetch를 사용할 때만
`Access-Control-Allow-Credentials: true`를 추가하세요. private upstream을
인증 없는 공개 proxy 뒤에 두지 마세요. nginx proxy cache는 Range 전달
동작에 영향을 줍니다. cache를 별도로 구성하고 end-to-end ranged GET을
검증하기 전에는 비활성화하세요. nginx 문서: [`add_header`](https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header),
[`proxy_set_header`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header),
[upstream SSL 인증서 검증](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_ssl_verify).

## Endpoint 검증

브라우저가 사용할 CDN 또는 proxy를 포함한 최종 URL을 `COPC_URL`로
설정합니다. 서명 URL은 자격 증명입니다. 공유 로그나 shell history에
남기지 마세요. `GET`으로 서명된 URL은 `HEAD`를 거부할 수 있습니다. 이때는
선택적 `curl -I` 확인을 건너뛰고 아래 ranged `GET`으로 검사하세요.

```bash
# 선택적인 metadata 확인. HEAD만으로 ranged GET 동작을 증명할 수 없습니다.
curl -sSI -H 'Origin: https://viewer.example.com' "$COPC_URL"

# 핵심 확인: 상태, 응답 header, 다운로드한 body 길이를 검사합니다.
curl -sS -D - -o /dev/null \
  -w '\nstatus=%{http_code} body_bytes=%{size_download}\n' \
  -H 'Origin: https://viewer.example.com' \
  -H 'Range: bytes=0-1023' \
  "$COPC_URL"
```

1,024 bytes보다 큰 객체라면 `206`, `Content-Range: bytes 0-1023/N`(전체
크기를 모르면 `bytes 0-1023/*`), `body_bytes=1024`, 그리고 해당 header가
반환되면 `Content-Length: 1024`를 기대합니다. 실제 요청에서 safelist 외
header를 사용한다면 실제 앱의 요청 header에 맞춰 preflight도 확인합니다.

```bash
curl -sS -i -X OPTIONS \
  -H 'Origin: https://viewer.example.com' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' \
  "$COPC_URL"
```

`curl`은 header를 출력하지만 브라우저 CORS를 적용하지 않으므로 JavaScript가
`Content-Range`를 읽을 수 있는지는 증명하지 못합니다. 실제 애플리케이션
origin에서 브라우저로도 확인하세요.

```ts
import { probeCopcSource } from '@frillab/copc-adapter';

const url = 'https://copc.example.com/copc/data.copc.laz';
const result = await probeCopcSource(url);
console.table({
  status: result.partialStatus,
  requestedRange: `${result.requestedRange.offset}-${result.requestedRange.offset + result.requestedRange.length - 1}`,
  returnedRange: result.contentRange,
  objectBytes: result.contentLength,
  rangeSupported: result.rangeSupported,
  corsReadable: result.corsReadable,
  copcDetected: result.copcDetected,
  warnings: result.warnings.join(' '),
});
```

정상 COPC 결과는 상태 `206`, 요청/반환 범위 `0-1023`, JavaScript에서 읽을
수 있는 `Content-Range: bytes 0-1023/N`(전체 크기를 모르면 `*`),
`rangeSupported: true`, `copcDetected: true`입니다. `206`에서
`result.contentLength`는 `Content-Range`로부터 읽은 전체 객체 크기이고,
전체 크기가 `*`라면 이 값은 없을 수 있습니다. HTTP `Content-Length`가
있다면 응답 body 크기입니다. `corsReadable: true`는 fetch 응답을 검사할 수
있었다는 뜻이지만 모든 응답 header가 노출됐다는 뜻은 아닙니다.
`result.contentRange`도 직접 확인하세요.

브라우저 Network 패널에서 요청의 `Range`, 응답 상태 `206`, 응답에 포함된
`Content-Range`를 확인할 수 있습니다. DevTools에는 header가 보이지만
`result.contentRange`가 없다면 `Access-Control-Expose-Headers` 누락을
의심하세요. 단일 `Range` 요청에는 보통 `OPTIONS`가 없습니다. `OPTIONS`가
있다면 실제 method와 `Access-Control-Request-Headers`를 살펴 사용자 지정
header나 다중 범위 사용 여부를 확인하세요. fetch 실패는 DNS, TLS, 네트워크
문제일 수도 있으므로 브라우저 console/Network 패널과 curl 결과를 함께
살펴보세요.

## CDN, proxy, SoFi 검증의 한계

CDN 또는 proxy를 거치는 최종 공개 URL을 확인하세요. 각 계층은 요청 범위를
전달하거나 그에 맞는 부분 데이터를 응답하고, 일치하는 `206`,
`Content-Range`, body를 반환해야 합니다. 브라우저가 읽어야 하는 CORS 응답
header도 전달되어야 합니다. origin별로 CORS 응답이 다르면 cache는
`Vary: Origin`을 존중하거나 `Origin`을 cache key에 포함해야 합니다.
preflight 응답을 캐시한다면 요청 method와 header도 반영하세요. 인증된
응답을 사용자 사이에 공유하지 마세요. 서명 URL이나 인증 방식의 source는
관련 서명 query/auth를 cache policy에서 구분하거나 cache를 비활성화하세요.
COPC 경로의 content 변환도 피해야 합니다.

[Issue #212 SoFi multi-GB 보고서](../benchmarks/issue-212-sofi-multigb-streaming)는
결과를 명시적으로 **LIMITED**로 기록합니다. 공개 S3 URL은 실제 `206`과
일치하는 `Content-Range`를 반환했지만, 브라우저 JavaScript에
`Content-Range`를 노출하지 않았습니다. Playwright 테스트 route는 실제
upstream Range 요청을 전달하고 테스트 페이지에 필요한
`Access-Control-Expose-Headers`만 추가했습니다. 수정하지 않은 공개 URL이
브라우저에서 직접 동작한다는 근거는 아닙니다. 이 테스트 shim은 스트리밍과
byte accounting을 검증한 것이지 운영 proxy 설정 예제가 아닙니다. 운영
proxy는 별도의 보안·가용성 경계입니다. 허용 origin과 객체 접근을 제한하고
upstream 인증을 보존하세요. 내부 서비스에 접근하거나 무제한 데이터를
전송하는 임의 URL/open proxy를 만들지 마세요.

2026-10-14에 `Origin: https://viewer.example.com`을 넣어 별도로 실행한
Range `curl` 확인에서는 `206`, `Content-Range: bytes 0-1023/2029696615`,
`Content-Length: 1024`, body 1,024 bytes를 받았습니다. 응답에는
`Access-Control-Allow-Origin: *`가 있었지만
`Access-Control-Expose-Headers`는 없었습니다. 이는 현재 endpoint가 curl에
부분 응답을 반환한다는 확인입니다. curl은 CORS를 적용하지 않으며 브라우저
JavaScript가 `Content-Range`를 읽을 수 있음을 증명하지 않습니다.

2026-10-15 추가 `curl -I` 및 `Range: bytes=0-3` 확인에서도 보고된 두 COPC
객체가 같은 패턴을 보였습니다. Autzen은 `HEAD`에서 `200`과
`Content-Length: 81123042`, SoFi는 `200`과 `Content-Length: 2029696615`를
반환했습니다. 둘 다 Range `GET`에 `206`, body 4 bytes, wire 상의
`Content-Range`를 반환했고 `GET, HEAD` 및 `Access-Control-Allow-Origin: *`를
허용했지만 `Access-Control-Expose-Headers`는 없었습니다. Millsite는 두
method 모두 계속 `404`였습니다. curl 결과만으로 브라우저의 header 가시성이나
byte offset 정확성을 입증할 수는 없습니다.

## `Content-Range`가 숨겨진 경우의 선택적 호환 모드

가능하면 계속 `Content-Range`를 노출하세요. 기본
`rangeValidation: 'strict'`는 브라우저 JavaScript에서 정확한 시작/끝 범위와
전체 크기를 검증합니다. `206`은 반환하지만 브라우저에 해당 header를
노출하지 않는 source에 한해 다음처럼 명시적으로 호환 모드를 켤 수 있습니다.

```ts
import { CopcCesiumLayer, probeCopcSource } from '@frillab/copc-adapter/cesium';

const sourceUrl = 'https://example.com/data.copc.laz';
const layer = new CopcCesiumLayer({
  url: sourceUrl,
  rangeValidation: 'head-fallback',
});

const probe = await probeCopcSource(sourceUrl, {
  rangeValidation: 'head-fallback',
});
console.log(probe.validationLevel);
```

이 모드는 source instance마다 한 번 `HEAD`를 보내고 메타데이터를 캐시합니다.
브라우저가 `HEAD`를 허용하고 양수의 안전한 정수 `Content-Length`를 읽을 수
있어야 합니다. 각 `GET + Range`도 `206`과 요청한 길이와 정확히 일치하는 body를
반환해야 합니다. 읽을 수 있지만 잘못되거나 요청과 다른 `Content-Range`는
항상 거부합니다. `404`, `200`, 짧은 body, 실패한 `HEAD`, 모순되는 전체 크기도
우회하지 않습니다. 전체 객체를 `GET`으로 받지 않습니다.

검증 수준은 **compatibility-limited**입니다. `HEAD`의 크기와 정확한 body 길이만으로는
응답이 요청한 byte offset에서 왔는지, 같은 크기의 객체가 그대로 유지되는지
증명할 수 없습니다. 읽을 수 있는 validator/감지 가능한 크기 변경은 거부하지만,
validator를 읽을 수 없거나 약한 ETag/`Last-Modified` 정밀도만 있으면 객체 버전과
offset은 검증되지 않은 한계로 남습니다. `Content-Range`를 JavaScript에서 읽을 수
없어도 실제로 없었는지 CORS가 숨겼는지는 브라우저에서 구분할 수 없습니다.
올바른 CORS 노출 설정을 하는 것이 권장됩니다.

HTTP reader는 Range 요청 하나를 기본 최대 64 MiB로 제한합니다. 큰 metadata,
hierarchy page 또는 point chunk가 필요한 유효한 source에는
`CopcCesiumLayer`, `CopcThreeLayer` 또는 `CopcStreamingCore`의 `maxRangeBytes`를
명시적으로 높일 수 있습니다. 양의 안전한 정수라면 고정 상한은 없으며, 이 값은
두 backend와 Rust/WASM parser에 전달됩니다. 요청당 제한을 높이면 메모리 사용량도
늘 수 있습니다.

`maxConcurrentRangeRequests`는 source마다 동시에 실행하는 HTTP range 요청 수이며
기본값은 4입니다. 작은 range가 많을 때 처리량을 높이도록 양의 안전한 정수로
설정할 수 있습니다. 두 설정의 조합이 동시에 진행되는 응답 buffer를 제한하며,
기본 설정에서 최대 약 256 MiB를 사용합니다. 둘 중 하나를 높이면 가능한 메모리
사용량도 늘어납니다. viewer의 `maxConcurrentNodeLoads`는 한 번에 요청할 node 수를
별도로 제어합니다.

reader는 읽을 수 있는 `Content-Length`를 미리 확인하고, 정확한 크기의 buffer
하나에 스트리밍하며, 초과 chunk 또는 거부한 응답을 확인하는 즉시 body를
취소합니다. 가까운 read는 제한된 하나의 coalesced fetch로 합칠 수 있습니다.
Range 요청은 자동 재시도나 요청별 timeout을 사용하지 않으며, source lifecycle과
caller의 `AbortSignal`로 pending 작업을 취소합니다. 오류와 probe 진단에는 URL 사용자
정보, query, fragment를 포함하지 않습니다. COPC 객체에는 gzip/Brotli 또는 다른
byte 변환을 적용하지 마세요.

근거 자료: [Issue #212](https://github.com/mors119/copc-adapter/issues/212),
[SoFi 검증 기록](../benchmarks/issue-212-sofi-multigb-streaming).

## 관련 구현

- `packages/copc-adapter/src/core/copc/range/httpRangeSource.ts`
- `packages/copc-adapter/src/core/copc/range/contentRange.ts`
- `packages/copc-adapter/src/core/copc/sourceProbe.ts`

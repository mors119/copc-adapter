# Host a COPC source for browser Range access

COPC Adapter reads the original object at byte offsets. A working deployment
needs both correct HTTP partial responses and, for cross-origin use, browser
CORS permission to inspect those responses. These are separate requirements.

Replace `https://viewer.example.com`, bucket names, and host names below with
the exact values for your deployment. An origin is a scheme, host, and
optional port; it has no path or trailing slash. The examples allow one
specific web origin and do not grant object access by themselves.

## Expected HTTP response

For a request such as:

```http
GET /data.copc.laz HTTP/1.1
Range: bytes=0-1023
```

the server should return a partial response like:

```http
HTTP/1.1 206 Partial Content
Content-Range: bytes 0-1023/2030000
Content-Length: 1024
```

The body must contain exactly 1,024 bytes for this request. If
`Content-Length` is present, it describes that partial body (not the full
object) and should be `1024`; the adapter checks the received body length
itself. The number after the slash in `Content-Range` should be the full object
size when known; `*` is valid when the server cannot determine it. A numeric
total makes diagnostics more useful. This follows [RFC 9110's
`Content-Range` syntax](https://www.rfc-editor.org/rfc/rfc9110.html#section-14.4).
A `200 OK` response to this request usually means that a server, CDN, or proxy
ignored or removed `Range`; `Accept-Ranges: bytes` alone does not prove that
the requested range works. Avoid gzip/Brotli or other transformations on the
COPC object path because byte offsets must address the same stored bytes.

## HTTP Range and browser CORS are different

- **Range support** is an HTTP behavior: the server returns `206`, a matching
  `Content-Range`, and the requested bytes.
- **CORS** controls whether JavaScript on another origin may read the response.
  The response needs `Access-Control-Allow-Origin` for the application
  origin. `Content-Range` is not a CORS-safelisted response header, so it also
  needs to be named in `Access-Control-Expose-Headers`. `Content-Length` is
  safelisted; listing it as well is harmless and can help diagnostics.
- **Preflight is conditional.** A single byte range such as
  `Range: bytes=0-1023` is a CORS-safelisted request header for a `GET`, so it
  does not by itself trigger an `OPTIONS` preflight. A multi-range value,
  `Authorization`, another non-safelisted request header, or a method outside
  the simple-request set can trigger preflight. If a preflight occurs, the
  server must allow the requested method and headers. Listing `Range` in an
  allowed-header list is fine, but it does not make preflight happen.

CORS is not authentication or authorization. Keep bucket/object policies,
signed URLs, and application access checks in place. For cookie credentials,
the browser request must opt into credentials, the response must use the exact
allowed origin plus `Access-Control-Allow-Credentials: true`, and caches must
not mix users' responses. Do not combine credentialed requests with
`Access-Control-Allow-Origin: *`. The examples below are for requests that do
not depend on cross-origin cookies. See the [Fetch CORS safelist
rules](https://developer.mozilla.org/en-US/docs/Glossary/CORS-safelisted_request_header),
[CORS response-header exposure](https://developer.mozilla.org/en-US/docs/Glossary/CORS-safelisted_response_header),
and [AWS S3 CORS rule fields](https://docs.aws.amazon.com/AmazonS3/latest/userguide/ManageCorsUsing.html).

## AWS S3

Save this as `cors.json` and apply it to the bucket. `AllowedHeaders` is used
when a browser sends a preflight; `ExposeHeaders` controls which response
headers JavaScript can inspect.

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

S3's `AllowedMethods` values describe the requested operation (`GET`/`HEAD`);
do not add `OPTIONS` there. S3 evaluates and answers browser preflight from the
bucket CORS rules. If the browser sends `Authorization` or another custom
header, add only the actual header names to `AllowedHeaders` and verify the
resulting preflight. The rule does not make a private object public: the
request still needs an authorized bucket/object policy or a valid signed URL.
S3 bucket CORS configuration has no `Access-Control-Allow-Credentials` switch;
do not assume a cookie-authenticated flow works without verifying its actual
browser response. For CloudFront in front of S3, configure its cache behavior
to respect CORS: forward `Origin`, and if caching `OPTIONS`, also forward and
key the cache on `Access-Control-Request-Method` and
`Access-Control-Request-Headers`. Validate Range behavior at the CloudFront
URL, not only against S3. See [S3 CORS](https://docs.aws.amazon.com/AmazonS3/latest/userguide/cors.html)
and [CloudFront CORS header forwarding](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/header-caching.html).

## MinIO AIStor

For MinIO AIStor releases that support bucket CORS through `mc cors set`,
save this S3-compatible CORS document as `cors-config.xml`:

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

Use an `mc` release compatible with the server release and confirm that the
deployed edition supports bucket CORS. MinIO distributions and releases differ:
the global `MINIO_API_CORS_ALLOW_ORIGIN` setting is not a substitute for a
bucket rule that exposes `Content-Range`. AIStor documents `*` as the global
origin default and, with wildcard origins, echoes the request origin with
`Access-Control-Allow-Credentials: true` by default. Do not rely on that broad
global behavior for production; prefer an exact per-bucket allowlist. If your
server cannot configure exposed response headers, add them at a controlled
gateway/proxy or use a MinIO release that supports the bucket CORS API.
AIStor's bucket-specific CORS rules take precedence over its global setting.
As with S3, CORS does not grant object permissions, and custom request headers
must be included in the preflight policy only when the browser actually sends
them. See the official
[MinIO AIStor CORS guide](https://docs.min.io/aistor/administration/cors-configuration/)
and [`mc cors set` reference](https://docs.min.io/aistor/reference/cli/mc-cors/mc-cors-set/).

## nginx reverse proxy

This example is for a dedicated host serving publicly readable objects from
an upstream that uses the same `/copc/` path. Keep the origin allowlist narrow.
Put the `map` in nginx's `http {}` context and merge the `server`/`location`
directives into the matching TLS virtual host, including its certificate
directives. Replace the certificate paths with your provisioned TLS
certificate and key. This uses nginx's `add_header ... always` (1.7.5+) and
the `proxy_ssl_server_name`, `proxy_ssl_verify`, and
`proxy_ssl_trusted_certificate` directives (1.7.0+). The CA bundle path below
is an example for Debian/Ubuntu; replace it with the PEM trust bundle available
to the nginx process in your host or container. For a private origin CA, use a
bundle that trusts that CA. The `proxy_pass` hostname must match the upstream
certificate name. The sample deliberately does not enable nginx proxy caching
or cookie credentials.

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
        # This OPTIONS handler is needed only for requests that preflight.
        if ($request_method = OPTIONS) { return 204; }

        proxy_pass https://copc-origin.internal.example.net;
        proxy_ssl_server_name on;
        proxy_ssl_verify on;
        proxy_ssl_trusted_certificate /etc/ssl/certs/ca-certificates.crt;
        proxy_cache off;

        # Let nginx own these CORS response headers; avoid duplicate values.
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

nginx passes client request headers to the upstream by default, including
`Range`; do not overwrite or drop it in other proxy configuration. The
upstream must itself return the correct `206`, `Content-Range`, and body. The
proxy only adds browser CORS headers; it does not repair invalid byte ranges.
If the application sends `Authorization`, add it to
`Access-Control-Allow-Headers` and check that the upstream authorizes it. For
cookie-authenticated requests, add `Access-Control-Allow-Credentials: true`
only with this exact-origin allowlist and an application that intentionally
uses credentialed fetches. Do not put a private origin behind a public,
unauthenticated proxy. nginx's proxy cache changes Range forwarding behavior;
keep it disabled until the cache is explicitly configured and the ranged GET
is verified end to end. See nginx's [`add_header`](https://nginx.org/en/docs/http/ngx_http_headers_module.html#add_header),
[`proxy_set_header`](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_set_header),
and [upstream SSL verification](https://nginx.org/en/docs/http/ngx_http_proxy_module.html#proxy_ssl_verify)
references.

## Verify the endpoint

Set `COPC_URL` to the exact URL the browser will use, including its CDN or
proxy. A signed URL is a credential: keep it out of shared logs and shell
history. A URL signed for `GET` may reject `HEAD`; if so, skip the optional
`curl -I` check and use the ranged `GET` below.

```bash
# Optional metadata check. HEAD does not prove ranged GET behavior.
curl -sSI -H 'Origin: https://viewer.example.com' "$COPC_URL"

# The important check: status, response headers, and downloaded body length.
curl -sS -D - -o /dev/null \
  -w '\nstatus=%{http_code} body_bytes=%{size_download}\n' \
  -H 'Origin: https://viewer.example.com' \
  -H 'Range: bytes=0-1023' \
  "$COPC_URL"
```

For an object larger than 1,024 bytes, expect `206`,
`Content-Range: bytes 0-1023/N` (or `bytes 0-1023/*` if its total is unknown),
`body_bytes=1024`, and `Content-Length: 1024` when that header is returned. If
your real request uses a non-safelisted header, inspect
its preflight separately (replace the requested header list with the headers
your app actually sends):

```bash
curl -sS -i -X OPTIONS \
  -H 'Origin: https://viewer.example.com' \
  -H 'Access-Control-Request-Method: GET' \
  -H 'Access-Control-Request-Headers: authorization' \
  "$COPC_URL"
```

`curl` prints headers but does not enforce browser CORS and cannot prove that
JavaScript can read `Content-Range`. Run the check from the actual application
origin in a browser as well:

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

A healthy COPC result has status `206`, requested and returned range
`0-1023`, `Content-Range` readable as `bytes 0-1023/N` (or `*` if the total
is unknown), `rangeSupported: true`, and `copcDetected: true`. For a `206`,
`result.contentLength` is the full object size parsed from `Content-Range`; the
HTTP `Content-Length`, if present, is the size of that response body. With an
unknown `*` total, `result.contentLength` is absent even if the byte range is
valid. `corsReadable: true` means fetch returned an inspectable response, but
does not guarantee that every response header is exposed. Check
`result.contentRange` directly.

The browser's Network panel can show whether the request carried `Range`,
whether the response was `206`, and whether the response contained
`Content-Range`. A header visible in DevTools but absent from
`result.contentRange` points to a missing `Access-Control-Expose-Headers`
rule. A single `Range` request normally has no `OPTIONS`; if an `OPTIONS`
appears, inspect the actual method and `Access-Control-Request-Headers` for
custom headers or multiple ranges. A fetch failure can also be DNS, TLS, or
network trouble, so compare the browser console and Network panel with curl.

## CDN, proxy, and SoFi limits

Test the public URL through every CDN or proxy layer. Each layer must preserve
or correctly serve the requested range and return a matching `206`,
`Content-Range`, and body. It must also pass the relevant CORS response headers
to the browser. If CORS responses vary by origin, the cache must honor
`Vary: Origin` or key responses by `Origin`; if it caches preflight, it must
also account for the requested method and headers. Do not share authenticated
responses between users; for signed URLs or authorization-based sources,
preserve the relevant authorization/query separation in the cache policy or
disable caching. Avoid content transformations on the COPC path.

The [issue #212 SoFi multi-GB report](benchmarks/issue-212-sofi-multigb-streaming)
is explicitly **LIMITED**. The public S3 URL returned real `206` responses and
matching `Content-Range`, but did not expose `Content-Range` to browser
JavaScript. The Playwright test route forwarded real upstream Range requests
and added the missing `Access-Control-Expose-Headers` for the test page; it
did not prove that the unmodified public URL works directly in browsers. That
test-only shim is evidence for streaming and byte accounting, not a production
proxy recipe. A production proxy is another security and availability
boundary: restrict its origins and object access, preserve upstream
authorization, and never make an arbitrary-URL/open proxy that can be abused
to reach internal services or transfer unbounded data.

A separate ranged `curl` check on 2026-10-14, with
`Origin: https://viewer.example.com`, returned `206`,
`Content-Range: bytes 0-1023/2029696615`, `Content-Length: 1024`, and 1,024
body bytes. It included `Access-Control-Allow-Origin: *` but no
`Access-Control-Expose-Headers`. This confirms the current endpoint's partial
response over curl; curl does not enforce CORS or demonstrate that browser
JavaScript can read `Content-Range`.

A follow-up `curl -I` and `Range: bytes=0-3` check on 2026-10-15 found the same
pattern for both reported COPC objects: Autzen returned `200` to `HEAD` with
`Content-Length: 81123042`; SoFi returned `200` with
`Content-Length: 2029696615`; each ranged `GET` returned `206`, four body bytes,
and an on-wire `Content-Range`. Both allowed `GET, HEAD` and returned
`Access-Control-Allow-Origin: *`, but neither exposed `Content-Range` through
`Access-Control-Expose-Headers`. Millsite still returned `404` to both methods.
These curl observations do not establish browser header visibility or byte
offset correctness; the browser fixture and the compatibility limitations
below cover those separately.

## Optional compatibility mode when `Content-Range` is hidden

Keep exposing `Content-Range` where possible. The default `rangeValidation:
'strict'` policy requires JavaScript to read and validate its exact start,
end, and total. For a source that returns `206` but does not make that header
readable, callers may explicitly opt in:

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
console.log(probe.validationLevel); // 'compatibility-limited' when fallback succeeds
```

On the first `206` whose `Content-Range` is not readable, this mode makes one
`HEAD` request to the same resolved URL and caches its metadata for that source
instance. The browser must allow `HEAD` and JavaScript must be able to read a
positive, safe-integer `Content-Length`. Each `GET + Range` must still return
`206` and exactly the requested number of bytes. A visible but malformed or
mismatched `Content-Range` is always rejected; a `404`, `200`, short body,
unsupported `HEAD`, or contradictory source size is never rescued. No whole
object `GET` is used.

This mode provides **compatibility-limited** validation. `HEAD` size and an
exact body length cannot prove that a `206` body came from the requested byte
offset or that same-sized content stayed immutable. Readable validator changes
and detectable size changes are rejected, but unavailable validators, weak ETags, and
`Last-Modified` granularity leave an unverified version/offset limitation.
`probe.validationLevel` reports `strict`, `compatibility-limited`,
`incompatible`, or `unknown`; `rangeSupported` remains `true` only when the
selected response contract can be used. `Content-Range` is not readable means
it may be absent or hidden by CORS; browser JavaScript cannot distinguish those
cases. Fixing the source CORS exposure remains the recommended deployment.

The HTTP reader defaults to a 64 MiB maximum for each individual range. Set
`maxRangeBytes` on `CopcCesiumLayer`, `CopcThreeLayer`, or `CopcStreamingCore`
to raise it when a valid source needs larger metadata, hierarchy pages, or
point chunks. The setting accepts any positive safe integer and passes through
both backends and the Rust/WASM parser. Raising the per-range limit can increase
memory use.

`maxConcurrentRangeRequests` defaults to four active HTTP range requests per
source and can be raised to any positive safe integer. A higher setting can
improve throughput when many ranges are available. The two settings together
bound active response buffers: defaults allow up to 256 MiB (four 64 MiB
ranges), and increasing either setting raises that possible memory use. The
streaming core's separate `maxConcurrentNodeLoads` setting continues to control
how many nodes the viewer requests at a time.

The reader checks a readable `Content-Length` before reading, streams into one
exact-size buffer, and cancels the body as soon as a surplus chunk or rejected
response is observed. Nearby reads may share one capped coalesced fetch. Range
requests have no automatic retry or per-request timeout; source lifecycle and
caller `AbortSignal`s cancel pending work. Error and probe diagnostics omit URL
credentials, query strings, and fragments. Keep the COPC object on an identity
representation without gzip/Brotli or other byte transformations.

For the corresponding evidence, see [issue #212](https://github.com/mors119/copc-adapter/issues/212)
and the [SoFi validation record](benchmarks/issue-212-sofi-multigb-streaming).

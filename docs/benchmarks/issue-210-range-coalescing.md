# Issue 210: bounded HTTP Range coalescing

## Measurement and decision

Measurements on 2026-10-07 showed one useful same-turn merge in a bounded
SoFi point-read batch, with no extra bytes transferred. The implementation
coalesces only reads queued in the same JavaScript turn when their gap is at
most 4 KiB and their combined span is at most 1 MiB. Other reads remain
independent requests.

The measurement covered two different workloads:

| Workload | Capture method | Baseline requests / bytes | Coalesced requests / bytes | Result |
| --- | --- | ---: | ---: | --- |
| Autzen near view | Browser issue-68 streaming scenario, Rust backend, local 81,123,042-byte sample; six selected point nodes | 9 / 2,159,037 B | 9 / 2,159,037 B | No point chunks were within 4 KiB of another selected chunk. |
| SoFi root-node batch | `CopcJsBackend` against the public 2,029,696,615-byte SoFi object; root page plus eight point nodes loaded concurrently | 11 / 1,701,776 B | 10 / 1,701,776 B | One pair of adjacent point chunks became one request; point requests fell from 8 to 7 (12.5%). |

The SoFi pair was `[2,027,762,319, 2,028,459,096]` and
`[2,028,459,097, 2,028,673,049]`. Their combined request is 910,731 bytes,
below the 1 MiB cap, with a zero-byte gap. Total bytes stayed unchanged, so
there was no over-fetch in this capture. The three metadata/hierarchy requests
were unchanged. The probe read about 1.7 MB from the 2.03 GB object; it did not
download the full file.

The Autzen capture had nine successful `206` responses. Its six point chunks
totaled 2,148,030 bytes. The remaining three requests read 375 bytes, 1,736
bytes, and 8,896 bytes for metadata and hierarchy. The two metadata reads
started 269 ms apart, so the same-turn queue did not delay or combine them.

The SoFi source does not expose the CORS headers needed by a browser, so this
range-pattern probe used Node's `fetch` through the existing `CopcJsBackend`.
It loaded the first eight point-node entries from the root page concurrently;
it is a bounded backend probe, not a full camera-driven SoFi browser run. That
browser validation remains covered by issue #212. Both captures measured
requests made through the current COPC reader paths; the coalescer works at
`readRange()` so it can combine same-turn point reads even when callers do not
use `readRanges()` directly.

## Reproduction

For the Autzen browser scenario, prepare the repository sample as described in
[`issue-68-streaming.md`](issue-68-streaming.md), then run:

```bash
npm run benchmark:streaming --prefix apps/viewer-web
```

The Range request offsets and lengths were captured from the browser's request
headers during the issue-68 near-view transition. The SoFi probe used
`new CopcJsBackend().open('https://hobu-lidar.s3.amazonaws.com/sofi.copc.laz')`,
loaded the root hierarchy, then concurrently loaded the first eight point nodes
with position-only fields. Before/after request counts were compared against
the requested node ranges and the actual HTTP `206` responses.

## Safety and behavior

- Calls queue for one microtask, so only synchronous request bursts can merge.
- Overlap and adjacency are eligible; gaps are limited to 4,096 bytes.
- Every merged request is capped at 1,048,576 bytes.
- Each caller receives a copy of exactly its original requested slice, in the
  caller's original result order, including duplicate ranges.
- Cancelling one caller rejects only that caller. The shared fetch continues
  for remaining callers and aborts when all callers have cancelled.
- The server response is validated against the merged byte interval before
  slices are returned.

Unit coverage is in `apps/viewer-web/test/range-source.test.mjs`.

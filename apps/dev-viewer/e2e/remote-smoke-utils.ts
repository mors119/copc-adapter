/** Read at most `maximumBytes` from a cloned response body. */
export async function readBoundedBodyLength(
  response: Response,
  maximumBytes: number,
): Promise<number | undefined> {
  const reader = response.clone().body?.getReader();
  if (!reader) return undefined;

  let bodyLength = 0;
  try {
    while (bodyLength < maximumBytes) {
      const next = await reader.read();
      if (next.done) break;
      bodyLength += Math.min(next.value.byteLength, maximumBytes - bodyLength);
    }
    if (bodyLength === maximumBytes) {
      // A tee branch may not settle its cancellation until the adapter consumes
      // or cancels the original response, so do not await this promise here.
      void reader.cancel().catch(() => undefined);
    }
    return bodyLength;
  } finally {
    reader.releaseLock();
  }
}

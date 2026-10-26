export type DeadlineResult<T> =
  | { timedOut: false; value: T }
  | { timedOut: true };

/** Abort an operation when its deadline expires, even if it ignores cancellation. */
export async function withAbortDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
): Promise<DeadlineResult<T>> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      timedOut = true;
      const error = new DOMException("Source read exceeded its deadline", "TimeoutError");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });

  try {
    const value = await Promise.race([operation(controller.signal), deadline]);
    return { timedOut: false, value };
  } catch (error) {
    if (timedOut) return { timedOut: true };
    throw error;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

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

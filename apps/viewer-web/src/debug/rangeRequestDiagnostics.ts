export type RangeRequestDiagnostics = {
  requested: number;
  active: number;
  completed: number;
  failed: number;
};

const diagnostics: RangeRequestDiagnostics = {
  requested: 0,
  active: 0,
  completed: 0,
  failed: 0,
};
const originalFetch = window.fetch;

const instrumentedFetch: typeof window.fetch = async (input, init) => {
  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  const source = input instanceof Request ? input.url : String(input);
  const sourceUrl = new URL(source, window.location.href);
  const isSampleRange = sourceUrl.pathname.startsWith('/samples/')
    && sourceUrl.pathname.endsWith('.copc.laz')
    && headers.has('Range');

  if (!isSampleRange) {
    return originalFetch.call(window, input, init);
  }

  diagnostics.requested += 1;
  diagnostics.active += 1;
  let response: Response;
  try {
    response = await originalFetch.call(window, input, init);
  } catch (error) {
    diagnostics.active = Math.max(0, diagnostics.active - 1);
    diagnostics.failed += 1;
    throw error;
  }

  if (response.status !== 206) {
    diagnostics.active = Math.max(0, diagnostics.active - 1);
    diagnostics.failed += 1;
    return response;
  }

  diagnostics.active = Math.max(0, diagnostics.active - 1);
  diagnostics.completed += 1;
  return response;
};

// This module is imported before the decoder/backend modules so copc-js's
// cross-fetch wrapper captures this observer as its native fetch function.
window.fetch = instrumentedFetch;

export const rangeRequestDiagnostics = {
  getSnapshot(): RangeRequestDiagnostics {
    return { ...diagnostics };
  },
  destroy(): void {
    window.fetch = originalFetch;
  },
};

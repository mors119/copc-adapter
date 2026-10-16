import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';

type ProbeResult = {
  reachable: boolean;
  rangeSupported: boolean | 'unknown';
  corsReadable: boolean | 'unknown';
  copcDetected: boolean | 'unknown';
  warnings: readonly string[];
};

type DebugAdapter = {
  probeSource(source: string): Promise<ProbeResult>;
};

declare global {
  interface Window {
    __COPC_DEBUG__?: DebugAdapter;
  }
}

test('reports CORS as unknown for a browser-blocked cross-origin response', async ({ page }) => {
  const server = createServer((_request, response) => {
    // Deliberately omit Access-Control-Allow-Origin and do not answer a CORS
    // preflight. The browser, rather than the unit-test fetch mock, decides
    // that the response is not readable.
    response.writeHead(206, {
      'Content-Range': 'bytes 0-1023/8192',
      'Content-Length': 1024,
    });
    response.end(new Uint8Array(1024));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();

  try {
    await page.goto('/?debugPanel=false');
    const result = await page.evaluate(async (source) => {
      if (!window.__COPC_DEBUG__) {
        throw new Error('COPC debug adapter is unavailable');
      }
      return window.__COPC_DEBUG__.probeSource(source);
    }, `http://127.0.0.1:${address.port}/blocked.copc.laz`);

    expect(result.reachable).toBe(false);
    expect(result.rangeSupported).toBe('unknown');
    expect(result.corsReadable).toBe('unknown');
    expect(result.copcDetected).toBe('unknown');
    expect(result.warnings.join(' ')).toMatch(/network availability and CORS policy/);
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});

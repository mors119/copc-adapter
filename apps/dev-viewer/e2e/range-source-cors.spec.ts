import { expect, test } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const packageEntryUrl = `/@fs/${fileURLToPath(
  new URL('../../../packages/index.ts', import.meta.url),
)}`;

test('default compatibility fallback works and strict mode refuses hidden Content-Range', async ({ page }) => {
  test.setTimeout(30_000);
  const requests: Array<{ method: string; range?: string }> = [];
  const rangeWarnings: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'warning' && message.text().includes('HEAD-based Range compatibility')) {
      rangeWarnings.push(message.text());
    }
  });
  await page.route('**/range-validation-fixture.html', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: '<!doctype html><html><head></head><body></body></html>',
    });
  });
  await page.route('https://range-fixture.invalid/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const range = request.headers().range;
    requests.push({ method, ...(range ? { range } : {}) });

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length',
    };
    if (method === 'HEAD') {
      await route.fulfill({
        status: 200,
        headers: { ...corsHeaders, 'Content-Length': '4096' },
      });
      return;
    }

    const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '');
    if (!match) {
      await route.fulfill({ status: 400, headers: corsHeaders });
      return;
    }
    const offset = Number(match[1]);
    const end = Number(match[2]);
    const body = Uint8Array.from(
      { length: end - offset + 1 },
      (_value, index) => (offset + index) % 256,
    );
    await route.fulfill({
      status: 206,
      headers: {
        ...corsHeaders,
        'Content-Length': String(body.byteLength),
        'Content-Range': `bytes ${offset}-${end}/4096`,
      },
        body: Buffer.from(body),
    });
  });

  await page.goto('/range-validation-fixture.html', { waitUntil: 'domcontentloaded' });
  const result = await page.evaluate(async (moduleUrl) => {
    const sourceUrl = 'https://range-fixture.invalid/data.copc.laz';
    const directResponse = await fetch(sourceUrl, {
      headers: { Range: 'bytes=0-0' },
    });
    const contentRangeVisible = directResponse.headers.get('Content-Range');
    const contentLengthVisible = directResponse.headers.get('Content-Length');
    await directResponse.body?.cancel();

    const module = await Promise.race([
      import(/* @vite-ignore */ moduleUrl),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('module import timed out')), 8_000);
      }),
    ]);
    const source = new module.HttpRangeByteSource(sourceUrl);
    const bytes = await Promise.race([
      source.readRange(7, 4).then((rangeBytes) => [...rangeBytes]),
      new Promise<never>((_resolve, reject) => {
        setTimeout(() => reject(new Error('range read timed out')), 8_000);
      }),
    ]);
    const secondBytes = await source.readRange(20, 2).then((rangeBytes) => [...rangeBytes]);
    const strictSource = new module.HttpRangeByteSource(sourceUrl, {
      rangeValidation: 'strict',
    });
    const strictOutcome = await strictSource.readRange(7, 4).then(
      () => ({ code: 'unexpected-success' }),
      (error: { code?: string; status?: number }) => ({ code: error.code, status: error.status }),
    );
    return { contentRangeVisible, contentLengthVisible, bytes, secondBytes, strictOutcome };
  }, packageEntryUrl);

  expect(result).toEqual({
    contentRangeVisible: null,
    contentLengthVisible: '1',
    bytes: [7, 8, 9, 10],
    secondBytes: [20, 21],
    strictOutcome: { code: 'content-range', status: 206 },
  });
  expect(requests).toEqual([
    { method: 'GET', range: 'bytes=0-0' },
    { method: 'GET', range: 'bytes=7-10' },
    { method: 'HEAD' },
    { method: 'GET', range: 'bytes=20-21' },
    { method: 'GET', range: 'bytes=7-10' },
  ]);
  expect(rangeWarnings).toHaveLength(1);
  expect(rangeWarnings[0].replace(/\n/g, ' ')).toContain('byte-offset correctness cannot be fully established');
  expect(rangeWarnings[0]).toContain("rangeValidation: 'strict'");
});

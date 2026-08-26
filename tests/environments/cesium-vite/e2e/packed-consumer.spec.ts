import { expect, test } from '@playwright/test';

test('renders the Autzen sample through the packed npm consumer', async ({ page }) => {
  const pageErrors: Error[] = [];
  const rangeHeaders: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));
  page.on('request', (request) => {
    const range = request.headers().range;
    if (request.url().includes('autzen.copc.laz') && range) {
      rangeHeaders.push(range);
    }
  });

  await page.goto('/');

  await expect(page.locator('#viewer-status')).toHaveText('ready');
  await expect(page.locator('#metadata-status')).toContainText('10,653,336');
  await expect.poll(async () => page.locator('#rendered-points').textContent())
    .toMatch(/[1-9][0-9,]*/);
  await expect(page.locator('#selected-nodes')).not.toHaveText('0');
  await expect(page.locator('#last-error')).toHaveText('none');
  expect(rangeHeaders.length).toBeGreaterThan(0);
  expect(rangeHeaders.every((range) => /^bytes=\d+-\d+$/.test(range))).toBe(true);
  expect(pageErrors).toEqual([]);
});

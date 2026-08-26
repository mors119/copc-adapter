import { expect, test } from '@playwright/test';

test('renders the Autzen sample through the packed npm consumer', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/');

  await expect(page.locator('#viewer-status')).toHaveText('ready');
  await expect(page.locator('#metadata-status')).toContainText('10,653,336');
  await expect.poll(async () => page.locator('#rendered-points').textContent())
    .toMatch(/[1-9][0-9,]*/);
  await expect(page.locator('#selected-nodes')).not.toHaveText('0');
  await expect(page.locator('#last-error')).toHaveText('none');
  expect(pageErrors).toEqual([]);
});

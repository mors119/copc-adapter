import assert from 'node:assert/strict';

export const rootContentUri = 'content/726f6f74.glb';
export const childContentUri = 'content/6c656674.glb';

export async function resetServerStats(page) {
  await page.evaluate(() => fetch('/__stats?reset=1'));
}

export function expectSharedTileResources(result) {
  assert.deepEqual(result.tileLoadErrors ?? [], []);
  assert.ok(result.resources.httpRequests.includes('tileset.json'), 'the renderer requested the URL-addressable tileset JSON');
  assert.ok(result.resources.httpRequests.includes(rootContentUri), 'the renderer requested root GLB content');
  assert.ok(result.resources.httpRequests.includes(childContentUri), 'the renderer requested child GLB content');
}

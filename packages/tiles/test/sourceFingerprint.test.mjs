import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpEtagSourceFingerprint } from '../src/resources/sourceFingerprint.ts';

test('creates a stable fingerprint from a redacted HTTP resource path, strong ETag, and length', async () => {
  const first = await createHttpEtagSourceFingerprint(
    'https://example.test/area.copc.laz?token=one',
    '"version-7"',
    4096,
  );
  const sameVersion = await createHttpEtagSourceFingerprint(
    'https://example.test/area.copc.laz?token=refreshed',
    '"version-7"',
    4096,
  );
  const changedVersion = await createHttpEtagSourceFingerprint(
    'https://example.test/area.copc.laz?token=refreshed',
    '"version-8"',
    4096,
  );
  assert.match(first, /^http-etag-sha256:[a-f0-9]{64}$/u);
  assert.equal(first, sameVersion);
  assert.notEqual(first, changedVersion);
  assert.doesNotMatch(first, /token|version/u);
});

test('rejects weak tags, missing size, and credential-bearing URLs', async () => {
  await assert.rejects(() => createHttpEtagSourceFingerprint('https://example.test/a', 'W/"weak"', 10));
  await assert.rejects(() => createHttpEtagSourceFingerprint('https://example.test/a', 'unquoted', 10));
  await assert.rejects(() => createHttpEtagSourceFingerprint('https://example.test/a', '"bad tag"', 10));
  await assert.rejects(() => createHttpEtagSourceFingerprint('https://example.test/a', '"v1"', 0));
  await assert.rejects(() => createHttpEtagSourceFingerprint('https://user:pass@example.test/a', '"v1"', 10));
});

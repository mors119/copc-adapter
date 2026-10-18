import assert from 'node:assert/strict';
import test from 'node:test';
import { createCoalescedUpdate } from '../src/coalescedUpdate.ts';

test('coalesces camera updates and reruns with the latest view after an active update', async () => {
  const calls = [];
  let resolveFirst;
  const scheduler = createCoalescedUpdate(() => {
    calls.push(calls.length + 1);
    if (calls.length === 1) {
      return new Promise((resolve) => { resolveFirst = resolve; });
    }
    return Promise.resolve();
  }, (error) => { throw error; });

  scheduler.request();
  await new Promise((resolve) => setTimeout(resolve, 0));
  scheduler.request();
  scheduler.request();
  assert.deepEqual(calls, [1]);

  resolveFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [1, 2]);
  scheduler.destroy();
});

test('destroying the update scheduler drops queued work', async () => {
  const calls = [];
  let resolveFirst;
  const scheduler = createCoalescedUpdate(() => {
    calls.push(calls.length + 1);
    if (calls.length === 1) {
      return new Promise((resolve) => { resolveFirst = resolve; });
    }
    return Promise.resolve();
  }, (error) => { throw error; });

  scheduler.request();
  await new Promise((resolve) => setTimeout(resolve, 0));
  scheduler.request();
  scheduler.destroy();
  resolveFirst();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, [1]);
});

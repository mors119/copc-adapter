import assert from 'node:assert/strict';
import test from 'node:test';
import {
  nextSegmentedValue,
  normalizeRangeValue,
} from '../../shared/ui-controls.ts';

const choices = [
  { value: 'cesium', label: 'Cesium' },
  { value: 'three', label: 'Three.js' },
  { value: 'unavailable', label: 'Unavailable', disabled: true },
];

test('segmented control keyboard navigation wraps and skips disabled options', () => {
  assert.equal(nextSegmentedValue(choices, 'cesium', 'ArrowRight'), 'three');
  assert.equal(nextSegmentedValue(choices, 'three', 'ArrowDown'), 'cesium');
  assert.equal(nextSegmentedValue(choices, 'cesium', 'ArrowLeft'), 'three');
  assert.equal(nextSegmentedValue(choices, 'cesium', 'Home'), 'cesium');
  assert.equal(nextSegmentedValue(choices, 'cesium', 'End'), 'three');
  assert.equal(nextSegmentedValue(choices, 'cesium', 'Enter'), undefined);
});

test('slider values clamp to bounds and snap to their configured step', () => {
  assert.equal(normalizeRangeValue(-3, { min: 1, max: 10, step: 1 }), 1);
  assert.equal(normalizeRangeValue(10_000_000, { min: 50_000, max: 1_000_000, step: 50_000 }), 1_000_000);
  assert.equal(normalizeRangeValue(1.26, { min: 0.1, max: 4, step: 0.1 }), 1.3);
});

test('slider scales reject invalid bounds and steps', () => {
  assert.throws(
    () => normalizeRangeValue(2, { min: 1, max: 10, step: 0 }),
    RangeError,
  );
  assert.throws(
    () => normalizeRangeValue(2, { min: 10, max: 1, step: 1 }),
    RangeError,
  );
});

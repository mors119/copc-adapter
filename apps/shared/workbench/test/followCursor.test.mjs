import assert from "node:assert/strict";
import test from "node:test";
import { mountFollowCursorTracker } from "../followCursor.ts";

class FakeTarget {
  listeners = new Map();
  addCount = 0;
  removeCount = 0;
  rect = { left: 0, top: 0, width: 100, height: 100 };

  addEventListener(name, handler) {
    this.addCount += 1;
    const handlers = this.listeners.get(name) ?? new Set();
    handlers.add(handler);
    this.listeners.set(name, handlers);
  }

  removeEventListener(name, handler) {
    this.removeCount += 1;
    this.listeners.get(name)?.delete(handler);
  }

  getBoundingClientRect() {
    return {
      ...this.rect,
      right: this.rect.left + this.rect.width,
      bottom: this.rect.top + this.rect.height,
    };
  }

  dispatch(name, event = {}) {
    for (const handler of this.listeners.get(name) ?? []) handler(event);
  }
}

function browserHarness(t) {
  let nextFrame = 1;
  const frames = new Map();
  const observers = [];
  const windowListeners = new Map();
  const fakeWindow = {
    addEventListener(name, handler) {
      const handlers = windowListeners.get(name) ?? new Set();
      handlers.add(handler);
      windowListeners.set(name, handlers);
    },
    removeEventListener(name, handler) {
      windowListeners.get(name)?.delete(handler);
    },
  };
  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.disconnected = false;
      observers.push(this);
    }
    observe() {}
    disconnect() { this.disconnected = true; }
    trigger() { if (!this.disconnected) this.callback(); }
  }
  const original = {
    window: globalThis.window,
    ResizeObserver: globalThis.ResizeObserver,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    cancelAnimationFrame: globalThis.cancelAnimationFrame,
  };
  Object.defineProperties(globalThis, {
    window: { configurable: true, value: fakeWindow },
    ResizeObserver: { configurable: true, value: FakeResizeObserver },
    requestAnimationFrame: {
      configurable: true,
      value(callback) {
        const id = nextFrame++;
        frames.set(id, callback);
        return id;
      },
    },
    cancelAnimationFrame: {
      configurable: true,
      value(id) { frames.delete(id); },
    },
  });
  t.after(() => {
    for (const [name, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[name];
      else Object.defineProperty(globalThis, name, { configurable: true, value });
    }
  });
  return {
    frames,
    observers,
    windowListeners,
    flushFrames() {
      const scheduled = [...frames.values()];
      frames.clear();
      scheduled.forEach((callback) => callback(0));
    },
  };
}

test("normalizes offset CSS-pixel pointer coordinates and bounds updates to one RAF", (t) => {
  const harness = browserHarness(t);
  const target = new FakeTarget();
  target.rect = { left: 100, top: 50, width: 200, height: 100 };
  const positions = [];
  const tracker = mountFollowCursorTracker({ getTarget: () => target, onPosition: (point) => positions.push(point) });
  tracker.setEnabled(true);

  target.dispatch("pointermove", { clientX: 150, clientY: 75 });
  target.dispatch("pointermove", { clientX: 180, clientY: 90 });
  target.dispatch("pointermove", { clientX: 200, clientY: 100 });
  assert.equal(harness.frames.size, 1);
  assert.deepEqual(positions, []);
  harness.flushFrames();
  assert.deepEqual(positions, [{ x: 0.5, y: 0.5 }]);

  target.dispatch("pointermove", { clientX: 200.2, clientY: 100.2 });
  harness.flushFrames();
  assert.equal(positions.length, 1, "sub-threshold normalized jitter is ignored");
  tracker.destroy();
});

test("recomputes the normalized position after viewport resize and scroll", (t) => {
  const harness = browserHarness(t);
  const target = new FakeTarget();
  target.rect = { left: 100, top: 50, width: 200, height: 100 };
  const positions = [];
  const tracker = mountFollowCursorTracker({ getTarget: () => target, onPosition: (point) => positions.push(point) });
  tracker.setEnabled(true);
  target.dispatch("pointermove", { clientX: 200, clientY: 100 });
  harness.flushFrames();
  target.rect = { left: 100, top: 50, width: 400, height: 200 };
  harness.observers.at(-1).trigger();
  harness.flushFrames();
  assert.deepEqual(positions, [{ x: 0.5, y: 0.5 }, { x: 0.25, y: 0.25 }]);

  target.rect = { left: 120, top: 70, width: 400, height: 200 };
  for (const handler of harness.windowListeners.get("scroll") ?? []) handler();
  harness.flushFrames();
  assert.deepEqual(positions.at(-1), { x: 0.2, y: 0.15 });
  tracker.destroy();
});

test("pointer exit cancels pending work and disable or remount removes old listeners", (t) => {
  const harness = browserHarness(t);
  let currentTarget = new FakeTarget();
  const firstTarget = currentTarget;
  const positions = [];
  const tracker = mountFollowCursorTracker({ getTarget: () => currentTarget, onPosition: (point) => positions.push(point) });
  tracker.setEnabled(true);

  firstTarget.dispatch("pointermove", { clientX: 40, clientY: 50 });
  firstTarget.dispatch("pointerleave");
  assert.equal(harness.frames.size, 0);
  harness.flushFrames();
  assert.deepEqual(positions, []);

  currentTarget = new FakeTarget();
  tracker.refreshTarget();
  assert.equal(firstTarget.listeners.get("pointermove")?.size, 0);
  currentTarget.dispatch("pointermove", { clientX: 75, clientY: 25 });
  harness.flushFrames();
  assert.deepEqual(positions, [{ x: 0.75, y: 0.25 }]);
  tracker.setEnabled(false);
  assert.equal(currentTarget.listeners.get("pointermove")?.size, 0);
  assert.ok(harness.observers.every((observer) => observer.disconnected));
  assert.equal(harness.windowListeners.get("resize")?.size, 0);
  tracker.destroy();
});

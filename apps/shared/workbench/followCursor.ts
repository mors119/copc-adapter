export type NormalizedScreenPosition = Readonly<{ x: number; y: number }>;

export type FollowCursorTracker = {
  /** Start or stop host-owned pointer tracking. */
  setEnabled(enabled: boolean): void;
  /** Rebind after a renderer change, source swap, resize, or DOM remount. */
  refreshTarget(): void;
  /** Remove pointer, resize, and frame callbacks. */
  destroy(): void;
};

export type FollowCursorTrackerOptions = {
  readonly getTarget: () => HTMLElement | undefined;
  readonly onPosition: (position: NormalizedScreenPosition) => void;
  /** Ignore normalized movement below this fraction on both axes. Defaults to 0.005. */
  readonly changeThreshold?: number;
};

/**
 * Track a pointer inside the actual renderer viewport and report at most once
 * per animation frame. Coordinates use CSS-pixel client positions and the
 * current viewport rectangle, so they remain normalized across DPR changes,
 * offsets, and viewport resizes.
 */
export function mountFollowCursorTracker(
  options: FollowCursorTrackerOptions,
): FollowCursorTracker {
  const threshold = options.changeThreshold ?? 0.005;
  let enabled = false;
  let target: HTMLElement | undefined;
  let resizeObserver: ResizeObserver | undefined;
  let animationFrame: number | undefined;
  let pending: NormalizedScreenPosition | undefined;
  let lastReported: NormalizedScreenPosition | undefined;
  let lastClient: { x: number; y: number } | undefined;
  let pointerInside = false;
  let destroyed = false;

  const cancelFrame = (): void => {
    if (animationFrame !== undefined) cancelAnimationFrame(animationFrame);
    animationFrame = undefined;
    pending = undefined;
  };

  const removeTarget = (): void => {
    if (!target) return;
    target.removeEventListener("pointermove", onPointerMove);
    target.removeEventListener("pointerleave", onPointerExit);
    target.removeEventListener("pointercancel", onPointerExit);
    window.removeEventListener("resize", onResize);
    window.removeEventListener("scroll", onResize, true);
    resizeObserver?.disconnect();
    resizeObserver = undefined;
    target = undefined;
    pointerInside = false;
    lastClient = undefined;
    cancelFrame();
  };

  const schedule = (position: NormalizedScreenPosition): void => {
    pending = position;
    if (animationFrame === undefined) {
      animationFrame = requestAnimationFrame(flush);
    }
  };

  function normalize(clientX: number, clientY: number): NormalizedScreenPosition | undefined {
    if (!target) return undefined;
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    if (clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) {
      return undefined;
    }
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  }

  function flush(): void {
    animationFrame = undefined;
    const next = pending;
    pending = undefined;
    if (!enabled || destroyed || !pointerInside || !next) return;
    if (
      lastReported &&
      Math.abs(lastReported.x - next.x) < threshold &&
      Math.abs(lastReported.y - next.y) < threshold
    ) return;
    lastReported = next;
    options.onPosition(next);
  }

  function onPointerMove(event: PointerEvent): void {
    if (!enabled || destroyed) return;
    lastClient = { x: event.clientX, y: event.clientY };
    const next = normalize(event.clientX, event.clientY);
    pointerInside = next !== undefined;
    if (next) schedule(next);
    else cancelFrame();
  }

  function onPointerExit(): void {
    pointerInside = false;
    lastClient = undefined;
    cancelFrame();
  }

  const onResize = (): void => {
    if (!enabled || !pointerInside || !lastClient) return;
    const next = normalize(lastClient.x, lastClient.y);
    if (next) schedule(next);
    else onPointerExit();
  };

  function bindTarget(next: HTMLElement | undefined): void {
    if (next === target) return;
    removeTarget();
    if (!enabled || !next || destroyed) return;
    target = next;
    target.addEventListener("pointermove", onPointerMove, { passive: true });
    target.addEventListener("pointerleave", onPointerExit, { passive: true });
    target.addEventListener("pointercancel", onPointerExit, { passive: true });
    if (typeof ResizeObserver !== "undefined") {
      resizeObserver = new ResizeObserver(onResize);
      resizeObserver.observe(target);
    }
    window.addEventListener("resize", onResize, { passive: true });
    window.addEventListener("scroll", onResize, { passive: true, capture: true });
  }

  return {
    setEnabled(value): void {
      if (destroyed || enabled === value) return;
      enabled = value;
      if (!enabled) {
        removeTarget();
        lastReported = undefined;
        return;
      }
      bindTarget(options.getTarget());
    },
    refreshTarget(): void {
      if (destroyed || !enabled) return;
      removeTarget();
      bindTarget(options.getTarget());
    },
    destroy(): void {
      if (destroyed) return;
      destroyed = true;
      enabled = false;
      removeTarget();
      lastReported = undefined;
    },
  };
}

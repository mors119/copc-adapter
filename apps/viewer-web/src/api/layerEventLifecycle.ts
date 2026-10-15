import type { CopcMetadata } from '../copc/types/copc';

export type CopcViewCancellationReason =
  | 'camera-change'
  | 'detach'
  | 'unload'
  | 'reload'
  | 'destroy';

export type CopcActiveViewCancellation = {
  viewGeneration: number;
  reason: CopcViewCancellationReason;
};

/** Tracks public view generations independently from core and adapter tokens. */
export class CopcLayerEventLifecycle {
  private nextViewGeneration = 0;
  private activeViewGeneration?: number;

  beginView(): {
    viewGeneration: number;
    superseded?: CopcActiveViewCancellation;
  } {
    const superseded = this.cancelView('camera-change');
    const viewGeneration = ++this.nextViewGeneration;
    this.activeViewGeneration = viewGeneration;
    return {
      viewGeneration,
      ...(superseded ? { superseded } : {}),
    };
  }

  cancelView(reason: CopcViewCancellationReason): CopcActiveViewCancellation | undefined {
    const viewGeneration = this.activeViewGeneration;
    if (viewGeneration === undefined) {
      return undefined;
    }

    this.activeViewGeneration = undefined;
    return { viewGeneration, reason };
  }

  settleView(viewGeneration: number): boolean {
    return this.finishView(viewGeneration);
  }

  failView(viewGeneration: number): boolean {
    return this.finishView(viewGeneration);
  }

  isActiveView(viewGeneration: number): boolean {
    return this.activeViewGeneration === viewGeneration;
  }

  private finishView(viewGeneration: number): boolean {
    if (this.activeViewGeneration !== viewGeneration) {
      return false;
    }

    this.activeViewGeneration = undefined;
    return true;
  }
}

export type CopcThreeLayerProgressEvent = {
  type: 'progress';
  target?: object;
  queuedNodeCount: number;
  activeNodeCount: number;
  viewGeneration: number;
};

export type CopcThreeLayerMetadataReadyEvent = {
  type: 'metadataready';
  target?: object;
  metadata: import('../copc/types/copc').CopcMetadata;
  loadGeneration: number;
};

export type CopcThreeLayerFirstVisibleEvent = {
  type: 'firstvisible';
  target?: object;
  loadGeneration: number;
  viewGeneration: number;
};

export type CopcThreeLayerViewSettledEvent = {
  type: 'viewsettled';
  target?: object;
  viewGeneration: number;
  selectedNodeKeys: readonly string[];
};

export type CopcThreeLayerViewCancelledEvent = {
  type: 'viewcancelled';
  target?: object;
  viewGeneration: number;
  reason: CopcViewCancellationReason;
};

export type CopcLayerErrorEvent = {
  error: unknown;
  phase: 'load' | 'view';
  loadGeneration?: number;
  viewGeneration?: number;
};

/** Defensive immutable metadata snapshot for public lifecycle notifications. */
export function snapshotCopcMetadata(metadata: CopcMetadata): CopcMetadata {
  return Object.freeze({
    ...metadata,
    bounds: Object.freeze({ ...metadata.bounds }),
    cube: Object.freeze({ ...metadata.cube }),
    ...(metadata.scale ? { scale: Object.freeze({ ...metadata.scale }) } : {}),
    ...(metadata.offset ? { offset: Object.freeze({ ...metadata.offset }) } : {}),
  });
}

/** Preserve an Error's prototype and cause chain without sharing mutable Error objects. */
export function snapshotCopcError(error: unknown): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  const descriptors = Object.getOwnPropertyDescriptors(error);
  if (typeof DOMException !== 'undefined' && error instanceof DOMException) {
    const snapshot = new DOMException(error.message, error.name);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (key === 'stack' || key === 'name' || key === 'message') {
        continue;
      }
      if (key === 'cause' && 'value' in descriptor) {
        descriptor.value = snapshotCopcError(descriptor.value);
      }
      Object.defineProperty(snapshot, key, descriptor);
    }
    return Object.freeze(snapshot);
  }
  const cause = descriptors.cause;
  if (cause && 'value' in cause) {
    cause.value = snapshotCopcError(cause.value);
  }
  const snapshot = Object.create(Object.getPrototypeOf(error)) as Error;
  Object.defineProperties(snapshot, descriptors);
  return Object.freeze(snapshot);
}

export type CopcThreeLayerErrorEvent = CopcLayerErrorEvent & {
  type: 'error';
  target?: object;
};

export type CopcThreeLayerEventMap = {
  progress: CopcThreeLayerProgressEvent;
  metadataready: CopcThreeLayerMetadataReadyEvent;
  firstvisible: CopcThreeLayerFirstVisibleEvent;
  viewsettled: CopcThreeLayerViewSettledEvent;
  viewcancelled: CopcThreeLayerViewCancelledEvent;
  error: CopcThreeLayerErrorEvent;
};

export type CopcThreeLayerEventType = keyof CopcThreeLayerEventMap;

type CopcThreeLayerEventListener<TEvent> = (event: TEvent) => void;
type AnyCopcThreeLayerEventListener = (event: unknown) => void;

/** A small typed dispatcher with listener cleanup scoped to one layer. */
export class CopcThreeLayerEventDispatcher {
  private readonly listeners = new Map<
    CopcThreeLayerEventType,
    Set<AnyCopcThreeLayerEventListener>
  >();
  private disposed = false;
  private readonly target: object;

  constructor(target: object) {
    this.target = target;
  }

  addEventListener<TType extends CopcThreeLayerEventType>(
    type: TType,
    listener: CopcThreeLayerEventListener<CopcThreeLayerEventMap[TType]>,
  ): void {
    if (this.disposed) {
      throw new Error('CopcThreeLayer has been destroyed');
    }
    let listeners = this.listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener as AnyCopcThreeLayerEventListener);
  }

  removeEventListener<TType extends CopcThreeLayerEventType>(
    type: TType,
    listener: CopcThreeLayerEventListener<CopcThreeLayerEventMap[TType]>,
  ): void {
    const listeners = this.listeners.get(type);
    listeners?.delete(listener as AnyCopcThreeLayerEventListener);
    if (listeners?.size === 0) {
      this.listeners.delete(type);
    }
  }

  hasEventListener(type: CopcThreeLayerEventType): boolean {
    return (this.listeners.get(type)?.size ?? 0) > 0;
  }

  dispatchEvent<TType extends CopcThreeLayerEventType>(
    event: CopcThreeLayerEventMap[TType],
  ): void {
    if (this.disposed) {
      return;
    }
    event.target = this.target;
    Object.freeze(event);
    const listeners = this.listeners.get(event.type);
    if (!listeners) {
      return;
    }

    for (const listener of [...listeners]) {
      if (this.disposed) {
        break;
      }
      try {
        listener.call(this.target, event);
      } catch (error: unknown) {
        reportListenerError(error);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }
}

export function reportListenerError(error: unknown): void {
  try {
    console.error('COPC layer event listener failed', error);
  } catch {
    // A replaced console.error must not interrupt streaming lifecycle work.
  }
}

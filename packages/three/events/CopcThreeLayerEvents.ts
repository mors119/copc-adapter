import type { CopcLayerErrorEvent, CopcViewCancellationReason } from '../../core/events/layerEventLifecycle';
import type { CopcMetadata } from '../../core/copc/types/copc';
import { reportListenerError } from '../../core/events/layerEventLifecycle';

/** Scheduler queue occupancy snapshot for the active view generation. */
export type CopcThreeLayerProgressEvent = {
  /** Discriminator for the pending/active work event. */
  type: 'progress';
  /** Layer instance that dispatched the event. */
  target?: object;
  /** Number of node loads waiting for a scheduler slot. */
  queuedNodeCount: number;
  /** Number of node loads currently active. */
  activeNodeCount: number;
  /** View generation these queue counts describe. */
  viewGeneration: number;
};

/** Emitted after source metadata and the root hierarchy have loaded. */
export type CopcThreeLayerMetadataReadyEvent = {
  /** Discriminator for the metadata-ready event. */
  type: 'metadataready';
  /** Layer instance that dispatched the event. */
  target?: object;
  /** Immutable snapshot of source metadata; no point nodes are implied loaded. */
  metadata: CopcMetadata;
  /** Load attempt associated with this notification. */
  loadGeneration: number;
};

/** Emitted when the first nonempty selected node has been committed to the renderer. */
export type CopcThreeLayerFirstVisibleEvent = {
  /** Discriminator for the first-visible event. */
  type: 'firstvisible';
  /** Layer instance that dispatched the event. */
  target?: object;
  /** Load attempt that produced the visible node. */
  loadGeneration: number;
  /** View update that committed the first node. */
  viewGeneration: number;
};

/** Emitted after the selected node work for a view has been committed. */
export type CopcThreeLayerViewSettledEvent = {
  /** Discriminator for the settled-view event. */
  type: 'viewsettled';
  /** Layer instance that dispatched the event. */
  target?: object;
  /** View generation that completed. */
  viewGeneration: number;
  /** Selected hierarchy node keys for the settled view. */
  selectedNodeKeys: readonly string[];
};

/** Emitted when active work for a view is invalidated before settling. */
export type CopcThreeLayerViewCancelledEvent = {
  /** Discriminator for the cancelled-view event. */
  type: 'viewcancelled';
  /** Layer instance that dispatched the event. */
  target?: object;
  /** Invalidated view generation. */
  viewGeneration: number;
  /** Lifecycle change that cancelled the generation. */
  reason: CopcViewCancellationReason;
};

/** Three.js layer error event with a standard type and dispatch target. */
export type CopcThreeLayerErrorEvent = CopcLayerErrorEvent & {
  /** Discriminator for the error event. */
  type: 'error';
  /** Layer instance that dispatched the event. */
  target?: object;
};

/** Event payload types accepted by {@link CopcThreeLayer.addEventListener}. */
export type CopcThreeLayerEventMap = {
  /** Scheduler queue occupancy changes for the active view. */
  progress: CopcThreeLayerProgressEvent;
  /** Metadata and root hierarchy became available. */
  metadataready: CopcThreeLayerMetadataReadyEvent;
  /** First nonempty node was committed to the renderer for a load. */
  firstvisible: CopcThreeLayerFirstVisibleEvent;
  /** Selected nodes for a view were committed to the renderer. */
  viewsettled: CopcThreeLayerViewSettledEvent;
  /** Active view work was invalidated before settling. */
  viewcancelled: CopcThreeLayerViewCancelledEvent;
  /** A source load or background view update failed. */
  error: CopcThreeLayerErrorEvent;
};

/** Name of a public Three layer lifecycle event. */
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

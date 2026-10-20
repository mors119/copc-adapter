import * as Cesium from "cesium";
import { reportListenerError } from "../../core/events/layerEventLifecycle";

type CopcCesiumListener<Args extends unknown[]> = (...args: Args) => void;

/** Native Cesium event with layer-scoped listener cleanup. */
export class CopcCesiumEvent<Args extends unknown[]> extends Cesium.Event<
  CopcCesiumListener<Args>
> {
  private readonly registrations = new Map<
    CopcCesiumListener<Args>,
    Map<unknown, { remove: Cesium.Event.RemoveCallback }>
  >();
  private disposed = false;

  /**
   * Register a Cesium-style listener and return its layer-scoped removal callback.
   * Duplicate listener/scope registrations reuse the existing callback.
   *
   * @throws If this event has been disposed.
   */
  override addEventListener(
    listener: CopcCesiumListener<Args>,
    scope?: unknown,
  ): Cesium.Event.RemoveCallback {
    if (this.disposed) {
      throw new Error("COPC layer event is disposed");
    }
    const existing = this.registrations.get(listener)?.get(scope);
    if (existing) {
      return existing.remove;
    }

    const thisEvent = this;
    const wrapped = function (this: unknown, ...args: Args): void {
      if (thisEvent.disposed) {
        return;
      }
      try {
        Reflect.apply(listener, this, args);
      } catch (error: unknown) {
        reportListenerError(error);
      }
    };
    super.addEventListener(wrapped, scope);
    const registration = {
      remove: (): void => {
        super.removeEventListener(wrapped, scope);
        const scopes = this.registrations.get(listener);
        scopes?.delete(scope);
        if (scopes?.size === 0) {
          this.registrations.delete(listener);
        }
      },
    };
    let scopes = this.registrations.get(listener);
    if (!scopes) {
      scopes = new Map();
      this.registrations.set(listener, scopes);
    }
    scopes.set(scope, registration);
    return registration.remove;
  }

  /** Remove a registered listener for the matching scope and report whether it existed. */
  override removeEventListener(
    listener: CopcCesiumListener<Args>,
    scope?: unknown,
  ): boolean {
    const registration = this.registrations.get(listener)?.get(scope);
    if (!registration) {
      return false;
    }
    registration.remove();
    return true;
  }

  /** Notify current listeners unless the event has been disposed. Listener failures are reported. */
  override raiseEvent(...args: Parameters<CopcCesiumListener<Args>>): void {
    if (!this.disposed) {
      super.raiseEvent(...args);
    }
  }

  /** Remove all layer-owned listener wrappers and ignore later raises. */
  dispose(): void {
    this.disposed = true;
    const registrations = [...this.registrations.values()].flatMap((scopes) => [
      ...scopes.values(),
    ]);
    for (const registration of registrations) {
      registration.remove();
    }
    this.registrations.clear();
  }
}

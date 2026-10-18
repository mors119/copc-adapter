export type CoalescedUpdate = {
  request(): void;
  destroy(): void;
};

/** Run one async update at a time and repeat once when newer work arrives. */
export function createCoalescedUpdate(
  update: () => Promise<unknown>,
  onError: (error: unknown) => void,
): CoalescedUpdate {
  let running = false;
  let pending = false;
  let destroyed = false;

  const run = (): void => {
    if (destroyed) return;
    if (running) {
      pending = true;
      return;
    }

    running = true;
    void Promise.resolve().then(update).catch((error: unknown) => {
      if (!destroyed) onError(error);
    }).finally(() => {
      running = false;
      if (pending && !destroyed) {
        pending = false;
        run();
      }
    });
  };

  return {
    request: run,
    destroy() {
      destroyed = true;
      pending = false;
    },
  };
}

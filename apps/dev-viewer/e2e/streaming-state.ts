import { expect } from '@playwright/test';

export async function getCompletedStreamingState<T extends {
  performance: Record<string, unknown>;
}>(readState: () => Promise<T>): Promise<T> {
  // First rendered points expose a provisional update count. Superseding that
  // update can leave the count unchanged, so camera baselines must wait for
  // finishUpdate(), which sets this duration after all selected nodes settle.
  // beginUpdate() resets the duration to zero for each new update.
  await expect.poll(async () => (await readState()).performance.updateDurationMs, {
    message: 'The streaming update must complete before recording its state',
  }).toBeGreaterThan(0);
  return readState();
}

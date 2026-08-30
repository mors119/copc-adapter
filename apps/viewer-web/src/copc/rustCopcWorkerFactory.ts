import RustCopcDecodeWorker from './rustCopcDecodeWorker.ts?worker';
import type { RustCopcDecodeWorkerLike } from './rustCopcDecodeWorkerPool';

export default function createRustCopcDecodeWorker(): RustCopcDecodeWorkerLike {
  return new RustCopcDecodeWorker();
}

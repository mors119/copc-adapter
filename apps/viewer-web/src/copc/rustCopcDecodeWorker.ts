import { decodeRustCopcNode } from './rustCopcNodeDecoder';
import { createCopcPointFieldSelection } from './points/fieldSelection';
import type {
  RustCopcDecodeWorkerRequest,
} from './rustCopcDecodeWorkerProtocol';

let metadataBytes: Uint8Array | undefined;
const workerScope = self as unknown as {
  onmessage: (event: MessageEvent<RustCopcDecodeWorkerRequest>) => void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

workerScope.onmessage = async (event: MessageEvent<RustCopcDecodeWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'init') {
      metadataBytes = new Uint8Array(request.metadata);
      workerScope.postMessage({ type: 'ready' });
      return;
    }

    if (!metadataBytes) {
      throw new Error('Rust COPC decode worker was not initialized');
    }

    const fields = createCopcPointFieldSelection([
      'position',
      ...(request.requestedFields & 1 ? ['intensity' as const] : []),
      ...(request.requestedFields & 2 ? ['classification' as const] : []),
      ...(request.requestedFields & 4 ? ['rgb' as const] : []),
    ]);
    const result = await decodeRustCopcNode(
      metadataBytes,
      new Uint8Array(request.chunk),
      request.pointCount,
      fields,
    );
    const attributes = result.buffer.attributes;
    const response = {
      type: 'result' as const,
      id: request.id,
      nodeKey: request.nodeKey,
      pointCount: result.buffer.pointCount,
      durationMs: result.durationMs,
      coordinates: result.buffer.coordinates.buffer,
      intensity: attributes?.intensity?.buffer,
      classification: attributes?.classification?.buffer,
      red: attributes?.red?.buffer,
      green: attributes?.green?.buffer,
      blue: attributes?.blue?.buffer,
    };
    const transferables = [
      response.coordinates,
      response.intensity,
      response.classification,
      response.red,
      response.green,
      response.blue,
    ].filter((buffer): buffer is ArrayBuffer => buffer !== undefined);
    workerScope.postMessage(response, transferables);
  } catch (error: unknown) {
    const structured = error instanceof Error
      ? { name: error.name, message: error.message, code: 'code' in error ? String(error.code) : undefined }
      : { name: 'Error', message: String(error) };
    workerScope.postMessage({
      type: 'error',
      id: request.type === 'decode' ? request.id : undefined,
      nodeKey: request.type === 'decode' ? request.nodeKey : undefined,
      error: structured,
    });
  }
};

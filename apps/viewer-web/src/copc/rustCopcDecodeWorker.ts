import {
  decodeRustCopcNode,
  RustCopcNodePreparer,
} from './rustCopcNodeDecoder';
import { loadCopcWasmWorker } from '../wasm/copcWasmWorker';
import { createCopcPointFieldSelection } from './points/fieldSelection';
import type {
  RustCopcDecodeWorkerRequest,
} from './rustCopcDecodeWorkerProtocol';

let metadataBytes: Uint8Array | undefined;
let wasmBinary: Uint8Array | undefined;
let nodePreparer: RustCopcNodePreparer | undefined;
const workerScope = self as unknown as {
  onmessage: (event: MessageEvent<RustCopcDecodeWorkerRequest>) => void;
  postMessage(message: unknown, transfer?: Transferable[]): void;
};

workerScope.onmessage = async (event: MessageEvent<RustCopcDecodeWorkerRequest>) => {
  const request = event.data;
  try {
    if (request.type === 'init') {
      nodePreparer?.dispose();
      nodePreparer = undefined;
      metadataBytes = new Uint8Array(request.metadata);
      wasmBinary = new Uint8Array(request.wasm);
      workerScope.postMessage({ type: 'ready' });
      return;
    }

    const fields = createCopcPointFieldSelection([
      'position',
      ...(request.requestedFields & 1 ? ['intensity' as const] : []),
      ...(request.requestedFields & 2 ? ['classification' as const] : []),
      ...(request.requestedFields & 4 ? ['rgb' as const] : []),
    ]);
    if (!metadataBytes || !wasmBinary) throw new Error('Rust COPC decode worker was not initialized');
    if (request.type === 'prepare') {
      if (!nodePreparer) {
        const wasm = await loadCopcWasmWorker(wasmBinary);
        nodePreparer = await RustCopcNodePreparer.fromMetadata(
          metadataBytes,
          () => Promise.resolve(wasm),
        );
      }
      const result = nodePreparer.prepare(
        new Uint8Array(request.chunk),
        request.pointCount,
        fields,
      );
      const prepared = result.prepared;
      const response = {
        type: 'result' as const,
        id: request.id,
        nodeKey: request.nodeKey,
        operation: 'prepare' as const,
        pointCount: prepared.pointCount,
        durationMs: result.durationMs,
        decodeDurationMs: result.decodeDurationMs,
        preparationDurationMs: result.preparationDurationMs,
        coordinateSystem: 'wgs84-geographic' as const,
        sourceCoordinateSystem: prepared.source.coordinateSystem,
        worldCoordinateSystem: prepared.world.coordinateSystem,
        coordinates: prepared.geographic.coordinates.buffer,
        sourceCoordinates: prepared.source.coordinates.buffer,
        geographicCoordinates: prepared.geographic.coordinates.buffer,
        worldCoordinates: prepared.world.coordinates.buffer,
        statistics: {
          ...(prepared.statistics.elevation ? { elevation: prepared.statistics.elevation } : {}),
          ...(prepared.statistics.intensity ? { intensity: prepared.statistics.intensity } : {}),
          ...(prepared.statistics.rgbMax !== undefined ? { rgbMax: prepared.statistics.rgbMax } : {}),
        },
        intensity: prepared.attributes?.intensity?.buffer,
        classification: prepared.attributes?.classification?.buffer,
        red: prepared.attributes?.red?.buffer,
        green: prepared.attributes?.green?.buffer,
        blue: prepared.attributes?.blue?.buffer,
      };
      const transferables = [
        response.coordinates,
        response.sourceCoordinates,
        response.geographicCoordinates,
        response.worldCoordinates,
        response.intensity,
        response.classification,
        response.red,
        response.green,
        response.blue,
      ].filter((buffer): buffer is ArrayBuffer => buffer !== undefined);
      // `coordinates` and `geographicCoordinates` are aliases by contract;
      // transfer each backing buffer only once.
      workerScope.postMessage(response, [...new Set(transferables)]);
      return;
    }
    const result = await decodeRustCopcNode(
      metadataBytes,
      new Uint8Array(request.chunk),
      request.pointCount,
      fields,
      () => loadCopcWasmWorker(wasmBinary!),
    );
    const attributes = result.buffer.attributes;
    const response = {
      type: 'result' as const,
      id: request.id,
      nodeKey: request.nodeKey,
      pointCount: result.buffer.pointCount,
      durationMs: result.durationMs,
      coordinateSystem: result.buffer.coordinateSystem ?? 'copc-source',
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
      id: request.type === 'decode' || request.type === 'prepare' ? request.id : undefined,
      nodeKey: request.type === 'decode' || request.type === 'prepare' ? request.nodeKey : undefined,
      error: structured,
    });
  }
};

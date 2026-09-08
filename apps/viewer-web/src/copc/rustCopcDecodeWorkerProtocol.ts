export type RustCopcDecodeWorkerInit = {
  type: 'init';
  metadata: ArrayBuffer;
  wasm: ArrayBuffer;
};

export type RustCopcDecodeWorkerJob = {
  type: 'decode' | 'prepare';
  id: number;
  nodeKey: string;
  pointCount: number;
  requestedFields: number;
  chunk: ArrayBuffer;
};

export type RustCopcDecodeWorkerRequest =
  | RustCopcDecodeWorkerInit
  | RustCopcDecodeWorkerJob;

export type RustCopcDecodeWorkerResult = {
  type: 'result';
  id: number;
  nodeKey: string;
  operation?: 'decode' | 'prepare';
  pointCount: number;
  durationMs: number;
  decodeDurationMs?: number;
  preparationDurationMs?: number;
  coordinateSystem: 'copc-source' | 'wgs84-geographic';
  sourceCoordinateSystem?: 'copc-source';
  worldCoordinateSystem?: 'wgs84-ecef-meters';
  /** Transferred typed coordinate storage; never a WASM memory view. */
  coordinates: ArrayBuffer;
  /** Prepared source/geographic/ECEF buffers for the fused path. */
  sourceCoordinates?: ArrayBuffer;
  geographicCoordinates?: ArrayBuffer;
  worldCoordinates?: ArrayBuffer;
  statistics?: {
    elevation?: { min: number; max: number };
    intensity?: { min: number; max: number };
    rgbMax?: 255 | 65535;
  };
  intensity?: ArrayBuffer;
  classification?: ArrayBuffer;
  red?: ArrayBuffer;
  green?: ArrayBuffer;
  blue?: ArrayBuffer;
};

export type RustCopcDecodeWorkerErrorMessage = {
  type: 'error';
  id?: number;
  nodeKey?: string;
  error: { name: string; message: string; code?: string };
};

export type RustCopcDecodeWorkerResponse =
  | { type: 'ready' }
  | RustCopcDecodeWorkerResult
  | RustCopcDecodeWorkerErrorMessage;

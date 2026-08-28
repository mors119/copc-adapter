export type RustCopcDecodeWorkerInit = {
  type: 'init';
  metadata: ArrayBuffer;
};

export type RustCopcDecodeWorkerJob = {
  type: 'decode';
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
  pointCount: number;
  durationMs: number;
  coordinates: ArrayBuffer;
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

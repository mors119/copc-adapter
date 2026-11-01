export type TileResourceProvider = Readonly<{
  /** Opaque source instance identity. Do not put signed URLs or credentials here. */
  sourceIdentity: string;
  /** Changes whenever source or coordinate preparation is invalidated. */
  generation: number;
  isCurrent?(): boolean;
  getResource(uri: string, signal: AbortSignal): Promise<Uint8Array | undefined>;
  close?(): void | Promise<void>;
}>;

export type TileResourceServerOptions = Readonly<{
  /** URL prefix owned by this handler. The default serves from `/`. */
  basePath?: string;
  maxResourceBytes?: number;
  maxCacheBytes?: number;
  maxCacheEntries?: number;
  maxConcurrentLoads?: number;
  maxQueuedLoads?: number;
  maxSubscribersPerResource?: number;
  /** The caller owns the provider by default. */
  closeProviderOnShutdown?: boolean;
}>;

export type TileResourceServer = Readonly<{
  handle(request: Request): Promise<Response>;
  /** Abort old-generation work and clear cache before changing sources. */
  switchSource(provider: TileResourceProvider): Promise<void>;
  /** Stop serving, abort pending work, and optionally close the owned provider. */
  close(): Promise<void>;
  getStats(): Readonly<{
    cacheEntries: number;
    cacheBytes: number;
    inFlightLoads: number;
    queuedLoads: number;
    activeLoads: number;
    closed: boolean;
  }>;
}>;

export type StaticTileResource = Readonly<{ uri: string; bytes: Uint8Array }>;
export type StaticTileResourceProviderOptions = Readonly<{
  maxEntries?: number;
  maxTotalBytes?: number;
}>;

export class TileResourceServerError extends Error {
  readonly code: 'INVALID_CONFIGURATION' | 'SOURCE_CLOSED';

  constructor(code: TileResourceServerError['code'], message: string) {
    super(message);
    this.name = 'TileResourceServerError';
    this.code = code;
  }
}

const DEFAULTS = Object.freeze({
  maxResourceBytes: 64 * 1024 * 1024,
  maxCacheBytes: 64 * 1024 * 1024,
  maxCacheEntries: 512,
  maxConcurrentLoads: 8,
  maxQueuedLoads: 64,
  maxSubscribersPerResource: 32,
});
const HARD_LIMITS = Object.freeze({
  maxResourceBytes: 512 * 1024 * 1024,
  maxCacheBytes: 512 * 1024 * 1024,
  maxCacheEntries: 10_000,
  maxConcurrentLoads: 64,
  maxQueuedLoads: 4_096,
  maxSubscribersPerResource: 256,
});

type Limits = Readonly<{
  maxResourceBytes: number;
  maxCacheBytes: number;
  maxCacheEntries: number;
  maxConcurrentLoads: number;
  maxQueuedLoads: number;
  maxSubscribersPerResource: number;
  basePath: string;
  closeProviderOnShutdown: boolean;
}>;

type CacheEntry = Readonly<{ bytes: Uint8Array }>;

type InFlightEntry = {
  controller: AbortController;
  promise: Promise<Uint8Array | undefined>;
  subscribers: number;
  settled: boolean;
};

type LoadJob<T> = {
  run: () => Promise<T>;
  signal: AbortSignal;
  resolve(value: T): void;
  reject(error: unknown): void;
  abortListener: () => void;
};

class ResourceQueueFullError extends Error {}
class StaleResourceError extends Error {}
class InvalidResourceError extends Error {}

/**
 * Fetch-compatible URL resource handler with bounded deduplicated loads and an
 * LRU byte cache. It does not depend on Cesium or Three internals.
 */
export function createTileResourceServer(
  initialProvider: TileResourceProvider,
  options: TileResourceServerOptions = {},
): TileResourceServer {
  const limits = resolveLimits(options);
  validateProvider(initialProvider);
  let provider: TileResourceProvider | null = initialProvider;
  let activeSourceIdentity = initialProvider.sourceIdentity;
  let activeGeneration = initialProvider.generation;
  let closed = false;
  let cacheBytes = 0;
  const cache = new Map<string, CacheEntry>();
  const inFlight = new Map<string, InFlightEntry>();
  const outstandingLoads = new Set<InFlightEntry>();
  const loadGate = new LoadGate(limits.maxConcurrentLoads, limits.maxQueuedLoads);

  const current = (candidate: TileResourceProvider, generation: number): boolean => {
    if (closed || provider !== candidate || candidate.generation !== generation) return false;
    try {
      return candidate.isCurrent?.() ?? true;
    } catch {
      return false;
    }
  };

  const clearGenerationState = (): void => {
    for (const entry of outstandingLoads) entry.controller.abort();
    inFlight.clear();
    cache.clear();
    cacheBytes = 0;
  };

  const synchronizeGeneration = (candidate: TileResourceProvider): void => {
    if (candidate.sourceIdentity !== activeSourceIdentity || candidate.generation !== activeGeneration) {
      clearGenerationState();
      activeSourceIdentity = candidate.sourceIdentity;
      activeGeneration = candidate.generation;
    }
  };

  const getCached = (key: string): Uint8Array | undefined => {
    const entry = cache.get(key);
    if (!entry) return undefined;
    cache.delete(key);
    cache.set(key, entry);
    return entry.bytes;
  };

  const cacheResource = (key: string, bytes: Uint8Array): void => {
    if (limits.maxCacheEntries === 0 || bytes.byteLength > limits.maxCacheBytes) return;
    const prior = cache.get(key);
    if (prior) {
      cache.delete(key);
      cacheBytes -= prior.bytes.byteLength;
    }
    cache.set(key, Object.freeze({ bytes }));
    cacheBytes += bytes.byteLength;
    while (cache.size > limits.maxCacheEntries || cacheBytes > limits.maxCacheBytes) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = cache.get(oldestKey);
      cache.delete(oldestKey);
      if (oldest) cacheBytes -= oldest.bytes.byteLength;
    }
  };

  const subscribe = (entry: InFlightEntry, signal: AbortSignal): Promise<Uint8Array | undefined> => {
    if (signal.aborted) {
      if (entry.subscribers === 0 && !entry.settled) entry.controller.abort();
      return Promise.reject(abortError());
    }
    if (entry.subscribers >= limits.maxSubscribersPerResource) {
      return Promise.reject(new ResourceQueueFullError('Too many concurrent requests for one tile resource.'));
    }
    entry.subscribers += 1;
    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (): void => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', onAbort);
        entry.subscribers -= 1;
        if (entry.subscribers === 0 && !entry.settled) entry.controller.abort();
      };
      const onAbort = (): void => {
        finish();
        reject(abortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) {
        onAbort();
        return;
      }
      entry.promise.then(
        (bytes) => {
          finish();
          resolve(bytes);
        },
        (error: unknown) => {
          finish();
          reject(error);
        },
      );
    });
  };

  const getResourceBytes = (candidate: TileResourceProvider, uri: string, signal: AbortSignal): Promise<Uint8Array | undefined> => {
    const generation = candidate.generation;
    if (!Number.isSafeInteger(generation) || generation < 0 || !current(candidate, generation)) {
      return Promise.reject(new StaleResourceError('The tile source is no longer current.'));
    }
    const key = JSON.stringify([candidate.sourceIdentity, generation, uri]);
    const cached = getCached(key);
    if (cached) return signal.aborted ? Promise.reject(abortError()) : Promise.resolve(cached);

    let entry = inFlight.get(key);
    if (entry?.controller.signal.aborted) {
      if (inFlight.get(key) === entry) inFlight.delete(key);
      entry = undefined;
    }
    if (!entry) {
      if (outstandingLoads.size >= limits.maxConcurrentLoads + limits.maxQueuedLoads) {
        return Promise.reject(new ResourceQueueFullError('The tile resource load queue is full.'));
      }
      const controller = new AbortController();
      const created: InFlightEntry = {
        controller,
        promise: Promise.resolve(undefined),
        subscribers: 0,
        settled: false,
      };
      created.promise = loadGate.run(async () => {
        if (controller.signal.aborted) throw abortError();
        if (!current(candidate, generation)) throw new StaleResourceError('The tile source changed before resource loading began.');
        const result = await candidate.getResource(uri, controller.signal);
        if (controller.signal.aborted) throw abortError();
        if (!current(candidate, generation)) throw new StaleResourceError('The tile source changed while the resource was loading.');
        if (result === undefined) return undefined;
        if (!(result instanceof Uint8Array) || result.byteLength > limits.maxResourceBytes) {
          throw new InvalidResourceError(`Tile resource must be a Uint8Array no larger than ${limits.maxResourceBytes} bytes.`);
        }
        const owned = new Uint8Array(result);
        cacheResource(key, owned);
        return owned;
      }, controller.signal).finally(() => {
        created.settled = true;
        outstandingLoads.delete(created);
        if (inFlight.get(key) === created) inFlight.delete(key);
      });
      entry = created;
      inFlight.set(key, created);
      outstandingLoads.add(created);
    }
    return subscribe(entry, signal);
  };

  const handle = async (request: Request): Promise<Response> => {
    if (request.signal.aborted) throw abortError();
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return responseText('Method not allowed', 405, { Allow: 'GET, HEAD' });
    }
    if (closed || !provider) return responseText('Tile source is closed', 503);

    const candidate = provider;
    synchronizeGeneration(candidate);
    let uri: string;
    try {
      uri = requestPath(request.url, limits.basePath);
    } catch {
      return responseText('Invalid tile resource path', 400);
    }
    const generation = candidate.generation;
    if (!Number.isSafeInteger(generation) || generation < 0 || !current(candidate, generation)) {
      return responseText('Tile source is stale', 410);
    }

    try {
      const bytes = await getResourceBytes(candidate, uri, request.signal);
      if (request.signal.aborted) throw abortError();
      if (!current(candidate, generation)) return responseText('Tile source is stale', 410);
      if (bytes === undefined) return responseText('Tile resource not found', 404);
      const headers = resourceHeaders(uri, bytes.byteLength);
      const body = request.method === 'HEAD' ? null : bytes.slice().buffer as ArrayBuffer;
      return new Response(body, { status: 200, headers });
    } catch (error) {
      if (request.signal.aborted) throw abortError();
      if (!current(candidate, generation) || error instanceof StaleResourceError) return responseText('Tile source is stale', 410);
      if (isAbortError(error)) throw abortError();
      if (error instanceof ResourceQueueFullError) return responseText('Tile resource service is busy', 503, { 'Retry-After': '1' });
      return responseText(error instanceof InvalidResourceError ? 'Invalid tile resource' : 'Tile resource could not be loaded', 502);
    }
  };

  const switchSource = async (next: TileResourceProvider): Promise<void> => {
    if (closed) throw new TileResourceServerError('SOURCE_CLOSED', 'Cannot switch a closed tile resource server.');
    validateProvider(next);
    const previous = provider;
    provider = next;
    clearGenerationState();
    activeSourceIdentity = next.sourceIdentity;
    activeGeneration = next.generation;
    if (limits.closeProviderOnShutdown && previous && previous !== next) await previous.close?.();
  };

  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    const previous = provider;
    provider = null;
    clearGenerationState();
    activeSourceIdentity = '';
    activeGeneration = -1;
    if (limits.closeProviderOnShutdown) await previous?.close?.();
  };

  return Object.freeze({
    handle,
    switchSource,
    close,
    getStats: () => Object.freeze({
      cacheEntries: cache.size,
      cacheBytes,
      inFlightLoads: outstandingLoads.size,
      queuedLoads: loadGate.queued,
      activeLoads: loadGate.active,
      closed,
    }),
  });
}

/** Build a read-only source for tileset JSON, subtree bytes, and static content. */
export function createStaticTileResourceProvider(
  sourceIdentity: string,
  generation: number,
  resources: readonly StaticTileResource[],
  options: StaticTileResourceProviderOptions = {},
): TileResourceProvider {
  if (!options || typeof options !== 'object' || typeof sourceIdentity !== 'string' || sourceIdentity.trim() === '' || !Number.isSafeInteger(generation) || generation < 0 || !Array.isArray(resources)) {
    throw new TileResourceServerError('INVALID_CONFIGURATION', 'Static tile resource source identity, generation, or resources are invalid.');
  }
  const maxEntries = options.maxEntries ?? 512;
  const maxTotalBytes = options.maxTotalBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > 10_000 || !Number.isSafeInteger(maxTotalBytes) || maxTotalBytes <= 0 || maxTotalBytes > 512 * 1024 * 1024) {
    throw new TileResourceServerError('INVALID_CONFIGURATION', 'Static resource entry and byte limits must be positive and within hard bounds.');
  }
  if (resources.length > maxEntries) {
    throw new TileResourceServerError('INVALID_CONFIGURATION', `Static resource count exceeds ${maxEntries}.`);
  }
  const items = new Map<string, Uint8Array>();
  let totalBytes = 0;
  for (const resource of resources) {
    if (!resource || typeof resource !== 'object') {
      throw new TileResourceServerError('INVALID_CONFIGURATION', 'Static resource entries must be objects.');
    }
    let uri: string;
    try {
      uri = normalizeResourceUri(resource?.uri);
    } catch {
      throw new TileResourceServerError('INVALID_CONFIGURATION', 'Static resources need safe relative URI paths.');
    }
    if (!(resource.bytes instanceof Uint8Array) || items.has(uri)) {
      throw new TileResourceServerError('INVALID_CONFIGURATION', 'Static resource entries must have unique safe URIs and Uint8Array bytes.');
    }
    totalBytes += resource.bytes.byteLength;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > maxTotalBytes) {
      throw new TileResourceServerError('INVALID_CONFIGURATION', `Static resource bytes exceed ${maxTotalBytes}.`);
    }
    items.set(uri, new Uint8Array(resource.bytes));
  }
  return Object.freeze({
    sourceIdentity,
    generation,
    getResource: async (uri: string, signal: AbortSignal) => {
      if (signal.aborted) throw abortError();
      const bytes = items.get(uri);
      return bytes;
    },
  });
}

class LoadGate {
  private activeCount = 0;
  private readonly queue: Array<LoadJob<unknown>> = [];

  constructor(private readonly concurrency: number, private readonly maxQueued: number) {}

  get active(): number { return this.activeCount; }
  get queued(): number { return this.queue.length; }

  run<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const job: LoadJob<T> = {
        run,
        signal,
        resolve,
        reject,
        abortListener: () => undefined,
      };
      job.abortListener = () => {
        const index = this.queue.indexOf(job as LoadJob<unknown>);
        if (index >= 0) this.queue.splice(index, 1);
        reject(abortError());
      };
      if (this.activeCount < this.concurrency) {
        this.start(job);
      } else if (this.queue.length >= this.maxQueued) {
        reject(new ResourceQueueFullError('The tile resource load queue is full.'));
      } else {
        signal.addEventListener('abort', job.abortListener, { once: true });
        this.queue.push(job as LoadJob<unknown>);
        if (signal.aborted) job.abortListener();
      }
    });
  }

  private start<T>(job: LoadJob<T>): void {
    job.signal.removeEventListener('abort', job.abortListener);
    if (job.signal.aborted) {
      job.reject(abortError());
      this.pump();
      return;
    }
    this.activeCount += 1;
    Promise.resolve().then(job.run).then(job.resolve, job.reject).finally(() => {
      this.activeCount -= 1;
      this.pump();
    });
  }

  private pump(): void {
    while (this.activeCount < this.concurrency && this.queue.length > 0) {
      const next = this.queue.shift();
      if (next) this.start(next);
    }
  }
}

function resolveLimits(options: TileResourceServerOptions): Limits {
  if (!options || typeof options !== 'object') {
    throw new TileResourceServerError('INVALID_CONFIGURATION', 'Tile resource server options must be an object.');
  }
  const basePath = options.basePath ?? '/';
  if (
    typeof basePath !== 'string' || !basePath.startsWith('/') || !basePath.endsWith('/') ||
    basePath.includes('//') || basePath.includes('?') || basePath.includes('#') || basePath.includes('%') || basePath.includes('\\') ||
    basePath.split('/').some((part) => part === '.' || part === '..')
  ) {
    throw new TileResourceServerError('INVALID_CONFIGURATION', 'basePath must be a safe absolute URL path ending in `/`.');
  }
  const values = {
    maxResourceBytes: options.maxResourceBytes ?? DEFAULTS.maxResourceBytes,
    maxCacheBytes: options.maxCacheBytes ?? DEFAULTS.maxCacheBytes,
    maxCacheEntries: options.maxCacheEntries ?? DEFAULTS.maxCacheEntries,
    maxConcurrentLoads: options.maxConcurrentLoads ?? DEFAULTS.maxConcurrentLoads,
    maxQueuedLoads: options.maxQueuedLoads ?? DEFAULTS.maxQueuedLoads,
    maxSubscribersPerResource: options.maxSubscribersPerResource ?? DEFAULTS.maxSubscribersPerResource,
  };
  for (const [name, value] of Object.entries(values) as Array<[keyof typeof values, number]>) {
    if (!Number.isSafeInteger(value) || value < 0 || value > HARD_LIMITS[name]) {
      throw new TileResourceServerError('INVALID_CONFIGURATION', `${name} must be a non-negative safe integer no greater than ${HARD_LIMITS[name]}.`);
    }
  }
  if (values.maxResourceBytes === 0 || values.maxConcurrentLoads === 0 || values.maxSubscribersPerResource === 0) {
    throw new TileResourceServerError('INVALID_CONFIGURATION', 'Resource size, load concurrency, and subscribers per resource must be positive.');
  }
  if (options.closeProviderOnShutdown !== undefined && typeof options.closeProviderOnShutdown !== 'boolean') {
    throw new TileResourceServerError('INVALID_CONFIGURATION', 'closeProviderOnShutdown must be a boolean.');
  }
  return Object.freeze({
    ...values,
    basePath,
    closeProviderOnShutdown: options.closeProviderOnShutdown ?? false,
  });
}

function validateProvider(provider: TileResourceProvider): void {
  if (
    !provider || typeof provider !== 'object' || typeof provider.sourceIdentity !== 'string' || provider.sourceIdentity.trim() === '' ||
    !Number.isSafeInteger(provider.generation) || provider.generation < 0 || typeof provider.getResource !== 'function'
  ) {
    throw new TileResourceServerError('INVALID_CONFIGURATION', 'A tile resource provider needs a stable identity, safe generation, and getResource method.');
  }
}

function requestPath(requestUrl: string, basePath: string): string {
  const pathname = new URL(requestUrl).pathname;
  if (!pathname.startsWith(basePath)) throw new TypeError('Request path is outside the configured base path.');
  const relative = pathname.slice(basePath.length);
  if (relative === '') return 'tileset.json';
  const rawSegments = relative.split('/');
  const decoded = rawSegments.map((segment) => decodeURIComponent(segment));
  if (decoded.some((segment) =>
    segment === '' || segment === '.' || segment === '..' || segment.includes('/') || segment.includes('\\') || segment.includes('%') ||
    /[\u0000-\u001f\u007f]/u.test(segment)
  )) {
    throw new TypeError('Request path contains an unsafe segment.');
  }
  return decoded.join('/');
}

function normalizeResourceUri(value: unknown): string {
  if (typeof value !== 'string' || value === '') throw new TypeError('Resource URI must be a non-empty path.');
  const parts = value.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\') || part.includes('%') || /[\u0000-\u001f\u007f]/u.test(part))) {
    throw new TypeError('Resource URI must be a safe relative path.');
  }
  return value;
}

function resourceHeaders(uri: string, byteLength: number): Headers {
  const contentType = uri === 'tileset.json' || uri.endsWith('.json')
    ? 'application/json'
    : uri.endsWith('.glb')
      ? 'model/gltf-binary'
      : uri.endsWith('.gltf')
        ? 'model/gltf+json'
        : 'application/octet-stream';
  return new Headers({
    'Content-Type': contentType,
    'Content-Length': String(byteLength),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
}

function responseText(message: string, status: number, extraHeaders: Record<string, string> = {}): Response {
  return new Response(message, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extraHeaders,
    },
  });
}

function abortError(): DOMException {
  return new DOMException('Tile resource request was aborted.', 'AbortError');
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

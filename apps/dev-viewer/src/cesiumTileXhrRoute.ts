type Deferred = Readonly<{
  resolve(value: unknown): void;
  reject(error: unknown): void;
}>;

type LoadWithXhr = (
  this: ResourceImplementations,
  url: string,
  responseType: string | undefined,
  method: string,
  data: unknown,
  headers: Readonly<Record<string, string>> | undefined,
  deferred: Deferred,
  overrideMimeType?: string,
) => unknown;

type ResourceImplementations = {
  loadWithXhr: LoadWithXhr;
};

type CesiumResource = {
  _Implementations?: ResourceImplementations;
};

let implementation: ResourceImplementations | undefined;
let originalLoadWithXhr: LoadWithXhr | undefined;
let routedLoadWithXhr: LoadWithXhr | undefined;
const routePrefixes = new Set<string>();

/**
 * Cesium's Resource uses XMLHttpRequest in browsers, while Three's loaders use
 * Fetch. Bridge only the Dev Viewer Tiles URLs to the existing Fetch route.
 */
export function registerCesiumTileXhrRoute(
  resourceValue: unknown,
  baseUrl: string,
): Readonly<{ close(): void }> {
  const resource = resourceValue as CesiumResource;
  const target = resource._Implementations;
  if (!target || typeof target.loadWithXhr !== "function") {
    throw new Error("Cesium Resource does not expose its XHR implementation hook.");
  }
  if (implementation && implementation !== target) {
    throw new Error("Only one Cesium Resource implementation can use the Tiles route at a time.");
  }

  const routeUrl = new URL(baseUrl, window.location.href);
  const prefix = routeUrl.pathname.slice(0, routeUrl.pathname.lastIndexOf("/") + 1);
  if (routePrefixes.size === 0) install(target);
  routePrefixes.add(prefix);

  let closed = false;
  return Object.freeze({
    close(): void {
      if (closed) return;
      closed = true;
      routePrefixes.delete(prefix);
      if (routePrefixes.size === 0) restore(target);
    },
  });
}

function install(target: ResourceImplementations): void {
  implementation = target;
  originalLoadWithXhr = target.loadWithXhr;
  routedLoadWithXhr = function (
    url,
    responseType,
    method,
    data,
    headers,
    deferred,
    overrideMimeType,
  ): unknown {
    let requestUrl: URL;
    try {
      requestUrl = new URL(url, window.location.href);
    } catch {
      return originalLoadWithXhr!.call(
        this,
        url,
        responseType,
        method,
        data,
        headers,
        deferred,
        overrideMimeType,
      );
    }
    if (
      requestUrl.origin !== window.location.origin ||
      ![...routePrefixes].some((prefix) => requestUrl.pathname.startsWith(prefix))
    ) {
      return originalLoadWithXhr!.call(
        this,
        url,
        responseType,
        method,
        data,
        headers,
        deferred,
        overrideMimeType,
      );
    }

    const controller = new AbortController();
    let settled = false;
    const resolve = (value: unknown): void => {
      if (settled) return;
      settled = true;
      deferred.resolve(value);
    };
    const reject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      deferred.reject(error);
    };
    const requestHeaders = new Headers(headers);
    const body = data === undefined || data === null
      ? undefined
      : data as BodyInit;

    void window.fetch(requestUrl, {
      method,
      headers: requestHeaders,
      ...(body === undefined ? {} : { body }),
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Cesium Tiles resource request failed (${response.status}): ${requestUrl.pathname}`);
      }
      if (method === "HEAD" || method === "OPTIONS") {
        const values: Record<string, string> = {};
        response.headers.forEach((value, key) => { values[key] = value; });
        resolve(values);
      } else if (responseType === "json") {
        resolve(await response.json());
      } else if (responseType === "arraybuffer") {
        resolve(await response.arrayBuffer());
      } else if (responseType === "blob") {
        resolve(await response.blob());
      } else {
        resolve(await response.text());
      }
    }).catch(reject);

    return Object.freeze({
      abort(): void {
        controller.abort();
        reject(new DOMException("Cesium Tiles resource request was aborted.", "AbortError"));
      },
    });
  };
  target.loadWithXhr = routedLoadWithXhr;
}

function restore(target: ResourceImplementations): void {
  if (target.loadWithXhr === routedLoadWithXhr && originalLoadWithXhr) {
    target.loadWithXhr = originalLoadWithXhr;
  }
  implementation = undefined;
  originalLoadWithXhr = undefined;
  routedLoadWithXhr = undefined;
}

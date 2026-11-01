import type { TileResourceServer } from "@frillab/copc-tiles/resources";

export type TileResourceRouteMetrics = Readonly<{
  requestCount: number;
  responseBytes: number;
  failedRequestCount: number;
  tilesetRequestCount: number;
  glbRequestCount: number;
  glbBytes: number;
}>;

export type TileResourceRoute = Readonly<{
  url: string;
  getMetrics(): TileResourceRouteMetrics;
  close(): void;
}>;

type RegisteredRoute = {
  readonly prefix: string;
  readonly server: TileResourceServer;
  readonly onChange: (() => void) | undefined;
  readonly metrics: {
    requestCount: number;
    responseBytes: number;
    failedRequestCount: number;
    tilesetRequestCount: number;
    glbRequestCount: number;
    glbBytes: number;
  };
};

const routes = new Map<string, RegisteredRoute>();
let nextRouteId = 0;
let originalFetch: typeof window.fetch | undefined;
let routedFetch: typeof window.fetch | undefined;

/**
 * Register one same-origin Fetch route for a public Tiles resource server.
 * Cesium and 3d-tiles-renderer continue to use their normal URL loaders; only
 * requests under this unique route are handled by the caller-owned server.
 */
export function registerTileResourceRoute(
  server: TileResourceServer,
  onChange?: () => void,
): TileResourceRoute {
  const id = `/_dev/copc-tiles/${++nextRouteId}/`;
  const route: RegisteredRoute = {
    prefix: id,
    server,
    onChange,
    metrics: {
      requestCount: 0,
      responseBytes: 0,
      failedRequestCount: 0,
      tilesetRequestCount: 0,
      glbRequestCount: 0,
      glbBytes: 0,
    },
  };
  routes.set(id, route);
  installFetchRouter();

  let closed = false;
  return Object.freeze({
    url: new URL(`${id}tileset.json`, window.location.href).href,
    getMetrics: () => Object.freeze({ ...route.metrics }),
    close(): void {
      if (closed) return;
      closed = true;
      routes.delete(id);
      restoreFetchRouterIfUnused();
      onChange?.();
    },
  });

  function installFetchRouter(): void {
    if (routedFetch) return;
    originalFetch = window.fetch;
    const fetchToRoute: typeof window.fetch = function (input, init): Promise<Response> {
      const rawUrl = input instanceof Request ? input.url : String(input);
      let requestUrl: URL;
      try {
        requestUrl = new URL(rawUrl, window.location.href);
      } catch {
        return originalFetch!.call(window, input, init);
      }
      if (requestUrl.origin !== window.location.origin) {
        return originalFetch!.call(window, input, init);
      }
      const match = [...routes.values()].find(({ prefix }) =>
        requestUrl.pathname.startsWith(prefix),
      );
      if (!match) return originalFetch!.call(window, input, init);

      const request = input instanceof Request
        ? new Request(input, init)
        : new Request(requestUrl, init);
      const resourcePath = requestUrl.pathname.slice(match.prefix.length);
      match.metrics.requestCount += 1;
      if (resourcePath === "tileset.json") match.metrics.tilesetRequestCount += 1;
      if (resourcePath.toLowerCase().endsWith(".glb")) match.metrics.glbRequestCount += 1;
      match.onChange?.();
      const resourceRequest = new Request(
        new URL(`/${resourcePath}`, requestUrl.origin),
        request,
      );
      return match.server.handle(resourceRequest).then((response) => {
        const contentLength = Number(response.headers.get("content-length"));
        if (response.ok && Number.isSafeInteger(contentLength) && contentLength >= 0) {
          match.metrics.responseBytes += contentLength;
          if (resourcePath.toLowerCase().endsWith(".glb")) {
            match.metrics.glbBytes += contentLength;
          }
        } else if (!response.ok) {
          match.metrics.failedRequestCount += 1;
        }
        match.onChange?.();
        return response;
      }, (error: unknown) => {
        match.metrics.failedRequestCount += 1;
        match.onChange?.();
        throw error;
      });
    };
    routedFetch = fetchToRoute;
    window.fetch = fetchToRoute;
  }

  function restoreFetchRouterIfUnused(): void {
    if (routes.size > 0 || !originalFetch || !routedFetch) return;
    if (window.fetch === routedFetch) window.fetch = originalFetch;
    originalFetch = undefined;
    routedFetch = undefined;
  }
}

import type {
  WorkbenchBackend,
  WorkbenchColorMode,
  WorkbenchLayerConfig,
  WorkbenchRenderer,
} from "../../shared/workbench-config";
import { isPotentiallySensitiveSource } from "./integrationCode";
import {
  defaultPlaygroundRefinementConfig,
  readPlaygroundRefinementConfig,
  writePlaygroundRefinementConfig,
  type PlaygroundRefinementConfig,
} from "./refinementConfig";

export type PlaygroundUrlConfig = WorkbenchLayerConfig & {
  readonly renderer: WorkbenchRenderer;
};

export const defaultPlaygroundUrlConfig: PlaygroundUrlConfig = {
  renderer: "cesium",
  backend: "copc-js",
  colorMode: "elevation",
  pointSize: 3,
  maxNodes: 24,
  maxRenderedPoints: 250_000,
  refinementAlgorithm: defaultPlaygroundRefinementConfig.algorithm,
};

const renderers = new Set<WorkbenchRenderer>(["cesium", "three"]);
const backends = new Set<WorkbenchBackend>(["copc-js", "rust"]);
const colorModes = new Set<WorkbenchColorMode>([
  "fixed",
  "rgb",
  "elevation",
  "intensity",
  "classification",
]);

function readEnum<T extends string>(
  params: URLSearchParams,
  key: string,
  allowed: ReadonlySet<T>,
  fallback: T,
  warnings: string[],
): T {
  const value = params.get(key);
  if (value === null) return fallback;
  if (allowed.has(value as T)) return value as T;
  warnings.push(`Unknown ${key} value; using ${fallback}.`);
  return fallback;
}

function readInteger(
  params: URLSearchParams,
  key: string,
  minimum: number,
  maximum: number,
  step: number,
  fallback: number,
  warnings: string[],
): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum ||
    (value - minimum) % step !== 0
  ) {
    warnings.push(`Invalid ${key}; using ${fallback}.`);
    return fallback;
  }
  return value;
}

/** Read and normalize renderer settings and a safe optional source from a share URL. */
export function readPlaygroundUrlConfig(params: URLSearchParams): {
  readonly config: PlaygroundUrlConfig;
  readonly refinementConfig: PlaygroundRefinementConfig;
  readonly sourceUrl?: string;
  readonly warning?: string;
} {
  const warnings: string[] = [];
  const defaults = defaultPlaygroundUrlConfig;
  const renderer = readEnum(
    params,
    "renderer",
    renderers,
    defaults.renderer,
    warnings,
  );
  const backend = readEnum(
    params,
    "backend",
    backends,
    defaults.backend,
    warnings,
  );
  const colorMode = readEnum(
    params,
    "colorMode",
    colorModes,
    defaults.colorMode,
    warnings,
  );
  const refinement = readPlaygroundRefinementConfig(params);
  if (refinement.warning) warnings.push(refinement.warning);

  let sourceUrl: string | undefined;
  const rawSource = params.get("sourceUrl");
  if (rawSource !== null) {
    try {
      const parsed = new URL(rawSource);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error();
      }
      if (isPotentiallySensitiveSource(rawSource)) {
        warnings.push(
          "A source URL with credentials, query parameters, or a fragment was ignored for privacy.",
        );
      } else {
        sourceUrl = parsed.href;
      }
    } catch {
      warnings.push("Invalid sourceUrl; no source was loaded.");
    }
  }

  return {
    config: {
      renderer,
      backend,
      colorMode,
      pointSize: readInteger(
        params,
        "pointSize",
        1,
        10,
        1,
        defaults.pointSize,
        warnings,
      ),
      maxNodes: readInteger(
        params,
        "maxNodes",
        1,
        48,
        1,
        defaults.maxNodes,
        warnings,
      ),
      maxRenderedPoints: readInteger(
        params,
        "maxRenderedPoints",
        50_000,
        1_000_000,
        50_000,
        defaults.maxRenderedPoints,
        warnings,
      ),
      refinementAlgorithm: refinement.config.algorithm,
    },
    refinementConfig: refinement.config,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}

/** Create canonical query parameters for a reproducible non-sensitive configuration. */
export function writePlaygroundUrlConfig(
  config: PlaygroundUrlConfig,
  refinementConfig: PlaygroundRefinementConfig,
  sourceUrl?: string,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("renderer", config.renderer);
  params.set("backend", config.backend);
  params.set("colorMode", config.colorMode);
  params.set("pointSize", String(config.pointSize));
  params.set("maxNodes", String(config.maxNodes));
  params.set("maxRenderedPoints", String(config.maxRenderedPoints));
  const withRefinement = writePlaygroundRefinementConfig(params, refinementConfig);
  if (sourceUrl && !isPotentiallySensitiveSource(sourceUrl)) {
    withRefinement.set("sourceUrl", new URL(sourceUrl).href);
  }
  return withRefinement;
}

import type {
  WorkbenchBackend,
  WorkbenchRefinementAlgorithm,
  WorkbenchRenderer,
} from "../../shared/workbench-config";
import {
  getAvailableChoices,
  getOptionDefinition,
  NPM_0_6_CAPABILITIES,
  NPM_0_6_MANIFEST,
} from "../../shared/schema/index.ts";
import { isPotentiallySensitiveSource } from "./integrationCode.ts";
import {
  readPlaygroundRefinementConfig,
  writePlaygroundRefinementConfig,
  type PlaygroundRefinementConfig,
} from "./refinementConfig.ts";
import {
  PLAYGROUND_DEFAULTS,
  type PlaygroundConfig,
  parseClassificationCodes,
} from "./playgroundConfig.ts";

export type PlaygroundUrlConfig = PlaygroundConfig;

export const defaultPlaygroundUrlConfig: PlaygroundUrlConfig = {
  renderer: "cesium",
  ...PLAYGROUND_DEFAULTS,
};

function getOptionChoices<Choice extends string>(
  optionId: string,
): ReadonlySet<Choice> {
  const option = getOptionDefinition(optionId);
  if (!option) return new Set();
  return new Set(
    getAvailableChoices(option, {
      manifest: NPM_0_6_MANIFEST,
      renderer: "cesium",
      runtimeCapabilities: NPM_0_6_CAPABILITIES,
    }).map(({ value }) => value as Choice),
  );
}

const renderers = getOptionChoices<WorkbenchRenderer>("renderer.engine");
const backends = getOptionChoices<WorkbenchBackend>("adapter.backend");
const colorModes = getOptionChoices<PlaygroundConfig["colorMode"]>("rendering.colorMode");
const refinementAlgorithms = getOptionChoices<WorkbenchRefinementAlgorithm>(
  "streaming.refinementAlgorithm",
);

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
  if (key === "refinementAlgorithm") {
    warnings.push(`Unknown refinement algorithm “${value}”; using Foveated.`);
  } else {
    warnings.push(`Unknown ${key} value; using ${fallback}.`);
  }
  return fallback;
}

function readNumber(
  params: URLSearchParams,
  key: string,
  fallback: number,
  valid: (value: number) => boolean,
  warnings: string[],
): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!valid(value)) {
    warnings.push(`Invalid ${key}; using the documented Playground default.`);
    return fallback;
  }
  return value;
}

function readClassificationFilter(
  params: URLSearchParams,
  warnings: string[],
): PlaygroundConfig["classificationFilter"] {
  const hasInclude = params.has("classificationInclude");
  const hasExclude = params.has("classificationExclude");
  if (!hasInclude && !hasExclude) return undefined;
  try {
    return {
      ...(hasInclude
        ? { include: parseClassificationCodes(params.get("classificationInclude") ?? "") }
        : {}),
      ...(hasExclude
        ? { exclude: parseClassificationCodes(params.get("classificationExclude") ?? "") }
        : {}),
    };
  } catch {
    warnings.push(
      "Invalid classification filter; no classification filter was restored.",
    );
    return undefined;
  }
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
  const refinementAlgorithm = readEnum(
    params,
    "refinementAlgorithm",
    refinementAlgorithms,
    defaults.refinementAlgorithm,
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
      pointSize: readNumber(
        params,
        "pointSize",
        defaults.pointSize,
        (value) => Number.isFinite(value) && value > 0,
        warnings,
      ),
      maxRenderedPoints: readNumber(
        params,
        "maxRenderedPoints",
        defaults.maxRenderedPoints,
        (value) => Number.isSafeInteger(value) && value > 0,
        warnings,
      ),
      maxPointCacheBytes: readNumber(
        params,
        "maxPointCacheBytes",
        defaults.maxPointCacheBytes,
        (value) => Number.isSafeInteger(value) && value >= 0,
        warnings,
      ),
      maxNodes: readNumber(
        params,
        "maxNodes",
        defaults.maxNodes,
        (value) => Number.isSafeInteger(value) && value > 0,
        warnings,
      ),
      maxDepth: readNumber(
        params,
        "maxDepth",
        defaults.maxDepth,
        (value) => Number.isSafeInteger(value) && value >= 0,
        warnings,
      ),
      maxScreenSpaceError: readNumber(
        params,
        "maxScreenSpaceError",
        defaults.maxScreenSpaceError,
        (value) => Number.isFinite(value) && value > 0,
        warnings,
      ),
      maxRenderDistanceMeters: readNumber(
        params,
        "maxRenderDistanceMeters",
        defaults.maxRenderDistanceMeters,
        (value) => Number.isFinite(value) && value > 0,
        warnings,
      ),
      refinementAlgorithm,
      classificationFilter: readClassificationFilter(params, warnings),
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
  params.set("maxRenderedPoints", String(config.maxRenderedPoints));
  params.set("maxPointCacheBytes", String(config.maxPointCacheBytes));
  params.set("maxNodes", String(config.maxNodes));
  params.set("maxDepth", String(config.maxDepth));
  params.set("maxScreenSpaceError", String(config.maxScreenSpaceError));
  params.set(
    "maxRenderDistanceMeters",
    String(config.maxRenderDistanceMeters),
  );
  if (config.classificationFilter?.include !== undefined) {
    params.set(
      "classificationInclude",
      parseClassificationCodes(config.classificationFilter.include.join(",")).join(","),
    );
  }
  if (config.classificationFilter?.exclude !== undefined) {
    params.set(
      "classificationExclude",
      parseClassificationCodes(config.classificationFilter.exclude.join(",")).join(","),
    );
  }
  params.set("refinementAlgorithm", config.refinementAlgorithm);
  const withRefinement = writePlaygroundRefinementConfig(params, refinementConfig);
  if (sourceUrl && !isPotentiallySensitiveSource(sourceUrl)) {
    withRefinement.set("sourceUrl", new URL(sourceUrl).href);
  }
  return withRefinement;
}

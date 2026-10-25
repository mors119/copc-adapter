export type PlaygroundFocusMode =
  | "auto-center"
  | "center-boost"
  | "follow-pointer"
  | "pinned";

export type PlaygroundRefinementConfig = {
  focusMode: PlaygroundFocusMode;
  focusEnabled: boolean;
  showGuide: boolean;
  center: { x: number; y: number };
  radius: number;
  detailBias: number;
};

export const defaultPlaygroundRefinementConfig: PlaygroundRefinementConfig = {
  focusMode: "auto-center",
  focusEnabled: false,
  showGuide: true,
  center: { x: 0.5, y: 0.5 },
  radius: 0.15,
  detailBias: 1.5,
};

const focusModes = new Set<PlaygroundFocusMode>([
  "auto-center",
  "center-boost",
  "follow-pointer",
  "pinned",
]);

function readBoundedNumber(
  params: URLSearchParams,
  key: string,
  minimum: number,
  maximum: number,
  fallback: number,
  errors: string[],
  minimumExclusive = false,
): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const value = Number(raw);
  const aboveMinimum = minimumExclusive ? value > minimum : value >= minimum;
  if (!Number.isFinite(value) || !aboveMinimum || value > maximum) {
    errors.push(
      `${key} must be ${minimumExclusive ? "greater than" : "at least"} ${minimum} and at most ${maximum}.`,
    );
    return fallback;
  }
  return value;
}

/** Parse safe Focus Lens settings from a Playground URL. */
export function readPlaygroundRefinementConfig(params: URLSearchParams): {
  config: PlaygroundRefinementConfig;
  warning?: string;
} {
  const errors: string[] = [];
  const defaults = defaultPlaygroundRefinementConfig;
  const rawMode = params.get("focusMode") as PlaygroundFocusMode | null;
  let focusMode = defaults.focusMode;
  if (rawMode !== null) {
    if (focusModes.has(rawMode)) focusMode = rawMode;
    else errors.push(`Unknown focus mode “${rawMode}”; using Auto center.`);
  }

  const enabledValue = params.get("focusEnabled");
  const guideValue = params.get("showFocusGuide");
  if (
    enabledValue !== null &&
    enabledValue !== "true" &&
    enabledValue !== "false"
  ) {
    errors.push("focusEnabled must be true or false.");
  }
  if (guideValue !== null && guideValue !== "true" && guideValue !== "false") {
    errors.push("showFocusGuide must be true or false.");
  }

  const focusEnabled = focusMode !== "auto-center" && enabledValue === "true";
  return {
    config: {
      focusMode,
      focusEnabled,
      showGuide:
        guideValue === null || (guideValue !== "true" && guideValue !== "false")
          ? defaults.showGuide
          : guideValue === "true",
      center: {
        x: readBoundedNumber(params, "focusX", 0, 1, defaults.center.x, errors),
        y: readBoundedNumber(params, "focusY", 0, 1, defaults.center.y, errors),
      },
      radius: Number(
        readBoundedNumber(
          params,
          "focusRadius",
          0.01,
          1,
          defaults.radius,
          errors,
        ).toFixed(4),
      ),
      detailBias: Number(
        readBoundedNumber(
          params,
          "focusBias",
          1,
          2,
          defaults.detailBias,
          errors,
        ).toFixed(2),
      ),
    },
    ...(errors.length > 0 ? { warning: errors.join(" ") } : {}),
  };
}

/** Replace only the public, non-source Focus Lens settings in the current URL. */
export function writePlaygroundRefinementConfig(
  params: URLSearchParams,
  config: PlaygroundRefinementConfig,
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set("focusMode", config.focusMode);
  next.set("focusEnabled", String(config.focusEnabled));
  next.set("showFocusGuide", String(config.showGuide));
  next.set("focusX", config.center.x.toFixed(4));
  next.set("focusY", config.center.y.toFixed(4));
  next.set("focusRadius", config.radius.toFixed(4));
  next.set("focusBias", config.detailBias.toFixed(2));
  return next;
}

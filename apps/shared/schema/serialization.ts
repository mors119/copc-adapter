import {
  getAvailableChoices,
  getSupportedOptions,
  resolveOptionDefault,
} from "./capabilities.ts";
import { isOptionConditionMet, OPTION_SCHEMA } from "./options.ts";
import { validateOptionValue } from "./validation.ts";
import type {
  CapabilityContext,
  SchemaOption,
} from "./types.ts";

export type SchemaDeserializationResult = {
  readonly values: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
};

function parseScalar(option: SchemaOption, raw: string): unknown {
  switch (option.validation.kind) {
    case "enum":
      return raw;
    case "number":
      return raw.trim() === "" ? Number.NaN : Number(raw);
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      return raw;
    default:
      return raw;
  }
}

function parseCodes(raw: string): number[] {
  if (raw.trim() === "") return [];
  return raw.split(",").map((part) => {
    const trimmed = part.trim();
    if (!/^\d+$/u.test(trimmed)) return Number.NaN;
    return Number(trimmed);
  });
}

function appendOption(
  params: URLSearchParams,
  option: SchemaOption,
  value: unknown,
): void {
  if (value === undefined || value === null) return;
  const validationErrors = validateOptionValue(option, value);
  if (validationErrors.length > 0) {
    throw new TypeError(validationErrors.join(" "));
  }

  switch (option.serialization.kind) {
    case "none":
      return;
    case "scalar":
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        params.set(option.serialization.key, String(value));
      }
      return;
    case "classification-filter": {
      const filter = value as {
        include?: readonly number[];
        exclude?: readonly number[];
      };
      if (filter.include !== undefined) {
        params.set(
          option.serialization.includeKey,
          filter.include.join(","),
        );
      }
      if (filter.exclude !== undefined) {
        params.set(
          option.serialization.excludeKey,
          filter.exclude.join(","),
        );
      }
      return;
    }
    case "string-array": {
      const wildcard =
        option.validation.kind === "string-array"
          ? option.validation.wildcard
          : undefined;
      if (
        value === wildcard ||
        (Array.isArray(value) &&
          value.every((item) => typeof item === "string"))
      ) {
        params.set(
          option.serialization.key,
          typeof value === "string" ? value : JSON.stringify(value),
        );
      }
      return;
    }
    case "focus-lens": {
      const focus = value as {
        center: { x: number; y: number };
        radius: number;
        detailBias: number;
      };
      params.set(option.serialization.keys.centerX, String(focus.center.x));
      params.set(option.serialization.keys.centerY, String(focus.center.y));
      params.set(option.serialization.keys.radius, String(focus.radius));
      params.set(
        option.serialization.keys.detailBias,
        String(focus.detailBias),
      );
      return;
    }
  }
}

/** Serialize schema-backed state. Source values are deliberately never shared. */
export function serializeSchemaValues(
  values: Readonly<Record<string, unknown>>,
  context: Omit<CapabilityContext, "values">,
): URLSearchParams {
  const params = new URLSearchParams();
  for (const option of getSupportedOptions({ ...context, values })) {
    if (!isOptionConditionMet(option, values)) continue;
    appendOption(params, option, values[option.id]);
  }
  return params;
}

/**
 * Restore package defaults plus query overrides. Callers may supply
 * application defaults to preserve intentional demo defaults.
 */
export function deserializeSchemaValues(
  params: URLSearchParams,
  context: Omit<CapabilityContext, "values">,
  baseValues: Readonly<Record<string, unknown>> = {},
): SchemaDeserializationResult {
  const values: Record<string, unknown> = { ...baseValues };
  const warnings: string[] = [];

  for (const option of getSupportedOptions(context)) {
    if (Object.hasOwn(values, option.id)) continue;
    const defaultValue = resolveOptionDefault(option.id, context.manifest);
    if (defaultValue !== undefined) values[option.id] = defaultValue;
  }

  for (const option of getSupportedOptions(context)) {
    const serialization = option.serialization;
    if (serialization.kind === "none") continue;

    let candidate: unknown;
    let present = false;
    if (serialization.kind === "scalar") {
      const raw = params.get(serialization.key);
      if (raw !== null) {
        present = true;
        candidate = parseScalar(option, raw);
      }
    } else if (serialization.kind === "classification-filter") {
      const includeRaw = params.get(serialization.includeKey);
      const excludeRaw = params.get(serialization.excludeKey);
      if (includeRaw !== null || excludeRaw !== null) {
        present = true;
        candidate = {
          ...(includeRaw === null ? {} : { include: parseCodes(includeRaw) }),
          ...(excludeRaw === null ? {} : { exclude: parseCodes(excludeRaw) }),
        };
      }
    } else if (serialization.kind === "string-array") {
      const wildcard =
        option.validation.kind === "string-array"
          ? option.validation.wildcard
          : undefined;
      const raw = params.get(serialization.key);
      if (raw !== null) {
        present = true;
        if (raw === wildcard && wildcard !== undefined) {
          candidate = wildcard;
        } else {
          try {
            candidate = JSON.parse(raw);
          } catch {
            candidate = raw;
          }
        }
      }
    } else if (serialization.kind === "focus-lens") {
      const { keys } = serialization;
      const raw = [
        params.get(keys.centerX),
        params.get(keys.centerY),
        params.get(keys.radius),
        params.get(keys.detailBias),
      ];
      if (raw.some((part) => part !== null)) {
        present = true;
        if (raw.every((part) => part !== null)) {
          candidate = {
            type: "screen-circle",
            center: { x: Number(raw[0]), y: Number(raw[1]) },
            radius: Number(raw[2]),
            detailBias: Number(raw[3]),
          };
        } else {
          candidate = null;
        }
      }
    }

    if (!present) continue;
    const errors = validateOptionValue(option, candidate);
    if (
      typeof candidate === "string" &&
      option.choices !== undefined &&
      !getAvailableChoices(option, context).some(
        (choice) => choice.value === candidate,
      )
    ) {
      errors.push(option.label + " choice " + candidate + " is unavailable.");
    }
    if (errors.length > 0) {
      warnings.push("Invalid " + option.label + " share state; default used.");
      continue;
    }
    values[option.id] = candidate;
  }

  const resolvedOptions = new Set(
    getSupportedOptions({ ...context, values }).map(({ id }) => id),
  );
  for (const option of OPTION_SCHEMA) {
    if (Object.hasOwn(values, option.id) && !resolvedOptions.has(option.id)) {
      delete values[option.id];
      warnings.push(
        option.label +
          " is unavailable for the selected package, renderer, or configuration; omitted.",
      );
    }
  }

  return { values, warnings };
}

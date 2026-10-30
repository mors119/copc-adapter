import {
  getAvailableChoices,
  getOptionDefault,
  getSupportedOptions,
  isOptionAvailable,
  resolveOptionDefault,
} from "./capabilities.ts";
import { isOptionConditionMet, OPTION_SCHEMA } from "./options.ts";
import {
  getSchemaConstraintViolations,
  validateOptionValue,
  validateSchemaValues,
} from "./validation.ts";
import type {
  CapabilityContext,
  SchemaFocusLens,
  SchemaHostValidators,
  SchemaOption,
} from "./types.ts";

export const MAX_SCHEMA_SHARE_QUERY_LENGTH = 8_192;
export const MAX_SCHEMA_SHARE_PARAMETER_LENGTH = 2_048;

export type SchemaDeserializationResult = {
  readonly values: Readonly<Record<string, unknown>>;
  readonly warnings: readonly string[];
};

type ReadParameterResult =
  | { readonly present: false }
  | { readonly present: true; readonly valid: false }
  | { readonly present: true; readonly valid: true; readonly value: string };

type CandidateResult = {
  readonly present: boolean;
  readonly valid: boolean;
  readonly candidate?: unknown;
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

function serializationKeys(option: SchemaOption): readonly string[] {
  const serialization = option.serialization;
  switch (serialization.kind) {
    case "scalar":
    case "string-array":
    case "json":
      return [serialization.key];
    case "classification-filter":
      return [
        serialization.includeKey,
        serialization.excludeKey,
        serialization.clearKey,
      ];
    case "focus-lens":
      return [...Object.values(serialization.keys), serialization.clearKey];
    case "none":
      return [];
  }
}

function readParameter(
  params: URLSearchParams,
  key: string,
  label: string,
  warnings: string[],
): ReadParameterResult {
  const all = params.getAll(key);
  if (all.length === 0) return { present: false };
  if (all.length !== 1) {
    warnings.push("Repeated " + label + " share-state key; value ignored.");
    return { present: true, valid: false };
  }
  const value = all[0];
  if (
    value.length > MAX_SCHEMA_SHARE_PARAMETER_LENGTH ||
    value.includes("\uFFFD")
  ) {
    warnings.push("Malformed or oversized " + label + " share-state value; ignored.");
    return { present: true, valid: false };
  }
  return { present: true, valid: true, value };
}

function appendOption(
  params: URLSearchParams,
  option: SchemaOption,
  value: unknown,
  hasValue: boolean,
): void {
  if (!hasValue || option.serialization.kind === "none") return;
  const serialization = option.serialization;

  if (value === undefined) {
    if (serialization.kind === "focus-lens") {
      params.set(serialization.clearKey, "true");
    }
    return;
  }
  if (value === null) {
    if (serialization.kind === "classification-filter") {
      params.set(serialization.clearKey, "true");
      return;
    }
    if (serialization.kind === "json") {
      params.set(serialization.key, "null");
      return;
    }
    throw new TypeError(option.label + " cannot be null in share state.");
  }

  switch (serialization.kind) {
    case "scalar":
      if (
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        params.set(serialization.key, String(value));
      }
      return;
    case "classification-filter": {
      const filter = value as {
        include?: readonly number[];
        exclude?: readonly number[];
      };
      if (filter.include !== undefined) {
        params.set(serialization.includeKey, filter.include.join(","));
      }
      if (filter.exclude !== undefined) {
        params.set(serialization.excludeKey, filter.exclude.join(","));
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
          serialization.key,
          typeof value === "string" ? value : JSON.stringify(value),
        );
      }
      return;
    }
    case "json": {
      const encoded = JSON.stringify(value);
      if (encoded === undefined) {
        throw new TypeError(option.label + " cannot be represented in share state.");
      }
      if (encoded.length > MAX_SCHEMA_SHARE_PARAMETER_LENGTH) {
        throw new RangeError(option.label + " exceeds the bounded share-state size.");
      }
      params.set(serialization.key, encoded);
      return;
    }
    case "focus-lens": {
      const focus = value as SchemaFocusLens;
      params.set(serialization.keys.centerX, String(focus.center.x));
      params.set(serialization.keys.centerY, String(focus.center.y));
      params.set(serialization.keys.radius, String(focus.radius));
      params.set(serialization.keys.detailBias, String(focus.detailBias));
      return;
    }
  }
}

function parseCandidate(
  params: URLSearchParams,
  option: SchemaOption,
  warnings: string[],
): CandidateResult {
  const serialization = option.serialization;
  if (serialization.kind === "none") return { present: false, valid: true };

  if (serialization.kind === "scalar") {
    const raw = readParameter(params, serialization.key, option.label, warnings);
    return raw.present
      ? raw.valid
        ? { present: true, valid: true, candidate: parseScalar(option, raw.value) }
        : { present: true, valid: false }
      : { present: false, valid: true };
  }

  if (serialization.kind === "json") {
    const raw = readParameter(params, serialization.key, option.label, warnings);
    if (!raw.present) return { present: false, valid: true };
    if (!raw.valid) return { present: true, valid: false };
    try {
      return { present: true, valid: true, candidate: JSON.parse(raw.value) };
    } catch {
      warnings.push("Malformed " + option.label + " JSON share-state value; ignored.");
      return { present: true, valid: false };
    }
  }

  if (serialization.kind === "classification-filter") {
    const include = readParameter(params, serialization.includeKey, option.label, warnings);
    const exclude = readParameter(params, serialization.excludeKey, option.label, warnings);
    const clear = readParameter(params, serialization.clearKey, option.label, warnings);
    const present = include.present || exclude.present || clear.present;
    if (!present) return { present: false, valid: true };
    if ([include, exclude, clear].some((part) => part.present && !part.valid)) {
      return { present: true, valid: false };
    }
    if (clear.present) {
      if (
        clear.valid &&
        clear.value === "true" &&
        !include.present &&
        !exclude.present
      ) {
        return { present: true, valid: true, candidate: null };
      }
      warnings.push("Conflicting or invalid " + option.label + " clear marker; value ignored.");
      return { present: true, valid: false };
    }
    return {
      present: true,
      valid: true,
      candidate: {
        ...(include.present && include.valid ? { include: parseCodes(include.value) } : {}),
        ...(exclude.present && exclude.valid ? { exclude: parseCodes(exclude.value) } : {}),
      },
    };
  }

  if (serialization.kind === "string-array") {
    const raw = readParameter(params, serialization.key, option.label, warnings);
    if (!raw.present) return { present: false, valid: true };
    if (!raw.valid) return { present: true, valid: false };
    const wildcard =
      option.validation.kind === "string-array"
        ? option.validation.wildcard
        : undefined;
    if (raw.value === wildcard && wildcard !== undefined) {
      return { present: true, valid: true, candidate: wildcard };
    }
    try {
      return { present: true, valid: true, candidate: JSON.parse(raw.value) };
    } catch {
      return { present: true, valid: true, candidate: raw.value };
    }
  }

  const keys = serialization.keys;
  const parts = {
    centerX: readParameter(params, keys.centerX, option.label, warnings),
    centerY: readParameter(params, keys.centerY, option.label, warnings),
    radius: readParameter(params, keys.radius, option.label, warnings),
    detailBias: readParameter(params, keys.detailBias, option.label, warnings),
    clear: readParameter(params, serialization.clearKey, option.label, warnings),
  };
  const present = Object.values(parts).some((part) => part.present);
  if (!present) return { present: false, valid: true };
  if (Object.values(parts).some((part) => part.present && !part.valid)) {
    return { present: true, valid: false };
  }
  if (parts.clear.present) {
    if (
      parts.clear.valid &&
      parts.clear.value === "true" &&
      !parts.centerX.present &&
      !parts.centerY.present &&
      !parts.radius.present &&
      !parts.detailBias.present
    ) {
      return { present: true, valid: true, candidate: undefined };
    }
    warnings.push("Conflicting or invalid " + option.label + " clear marker; value ignored.");
    return { present: true, valid: false };
  }
  if (
    !parts.centerX.present ||
    !parts.centerY.present ||
    !parts.radius.present ||
    !parts.detailBias.present
  ) {
    warnings.push("Incomplete " + option.label + " share state; value ignored.");
    return { present: true, valid: false };
  }
  return {
    present: true,
    valid: true,
    candidate: {
      type: "screen-circle",
      center: {
        x: Number("value" in parts.centerX ? parts.centerX.value : ""),
        y: Number("value" in parts.centerY ? parts.centerY.value : ""),
      },
      radius: Number("value" in parts.radius ? parts.radius.value : ""),
      detailBias: Number("value" in parts.detailBias ? parts.detailBias.value : ""),
    },
  };
}

function hasShareKey(params: URLSearchParams, option: SchemaOption): boolean {
  return serializationKeys(option).some((key) => params.has(key));
}

function chooseRenderer(
  requested: unknown,
  context: Omit<CapabilityContext, "values">,
  schema: readonly SchemaOption[],
): requested is CapabilityContext["renderer"] {
  const option = schema.find(({ id }) => id === "renderer.engine");
  if (!option || validateOptionValue(option, requested).length > 0) return false;
  const capability = "renderer." + String(requested);
  if (!context.manifest.capabilities.includes(capability)) return false;
  return (
    context.runtimeCapabilities === undefined ||
    context.runtimeCapabilities.includes(capability)
  );
}

function setDefault(
  values: Record<string, unknown>,
  option: SchemaOption,
  context: Omit<CapabilityContext, "values">,
  schema: readonly SchemaOption[],
  resolveDerived = true,
): void {
  const defaultEntry = getOptionDefault(option.id, context.manifest);
  if (defaultEntry?.kind === "value") values[option.id] = defaultEntry.value;
  else if (resolveDerived && defaultEntry?.kind === "derived") {
    const resolved = resolveOptionDefault(
      option.id,
      context.manifest,
      new Set(),
      schema,
      values,
    );
    if (resolved !== undefined) values[option.id] = resolved;
  }
}

function validateChoice(
  option: SchemaOption,
  candidate: unknown,
  context: Omit<CapabilityContext, "values">,
  schema: readonly SchemaOption[],
): string[] {
  const errors = validateOptionValue(option, candidate);
  if (
    errors.length === 0 &&
    typeof candidate === "string" &&
    option.choices !== undefined &&
    !getAvailableChoices(option, context, schema).some(
      (choice) => choice.value === candidate,
    )
  ) {
    errors.push(option.label + " choice " + candidate + " is unavailable.");
  }
  return errors;
}

/** Serialize supported, active, share-safe values. Source and resources are omitted. */
export function serializeSchemaValues(
  values: Readonly<Record<string, unknown>>,
  context: Omit<CapabilityContext, "values">,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
  hostValidators: SchemaHostValidators = {},
): URLSearchParams {
  const supported = getSupportedOptions(context, schema);
  const supportedIds = new Set(supported.map(({ id }) => id));
  const fullContext: CapabilityContext = { ...context, values };

  for (const option of schema) {
    if (!Object.hasOwn(values, option.id) || values[option.id] === undefined) continue;
    if (!supportedIds.has(option.id)) {
      if (option.serialization.kind !== "none") {
        throw new TypeError(option.label + " is unsupported and cannot be shared.");
      }
      continue;
    }
    if (!isOptionAvailable(option, fullContext, schema)) {
      if (option.serialization.kind !== "none") {
        throw new TypeError(option.label + " is unavailable and cannot be shared.");
      }
    }
  }

  const serializableOptions = supported.filter(
    (option) =>
      option.serialization.kind !== "none" &&
      isOptionAvailable(option, fullContext, schema) &&
      isOptionConditionMet(option, values, (dependencyId) =>
        resolveOptionDefault(
          dependencyId,
          context.manifest,
          new Set(),
          schema,
          values,
        ),
      ),
  );
  const validationValues = Object.fromEntries(
    serializableOptions.flatMap((option) =>
      Object.hasOwn(values, option.id) ? [[option.id, values[option.id]]] : [],
    ),
  );
  const errors = validateSchemaValues(
    validationValues,
    context,
    serializableOptions,
    hostValidators,
    { requireRequired: false },
  );
  if (errors.length > 0) {
    throw new TypeError("Cannot share invalid configuration: " + errors.join(" "));
  }

  const params = new URLSearchParams();
  for (const option of serializableOptions) {
    appendOption(
      params,
      option,
      values[option.id],
      Object.hasOwn(values, option.id),
    );
  }
  if (params.toString().length > MAX_SCHEMA_SHARE_QUERY_LENGTH) {
    throw new RangeError("Share state exceeds the 8192-character limit.");
  }
  return params;
}

/**
 * Restore defaults, caller values, and safe query overrides. Invalid or
 * unavailable query values are ignored with a warning and never reach state.
 */
export function deserializeSchemaValues(
  params: URLSearchParams,
  context: Omit<CapabilityContext, "values">,
  baseValues: Readonly<Record<string, unknown>> = {},
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
  hostValidators: SchemaHostValidators = {},
): SchemaDeserializationResult {
  const values: Record<string, unknown> = {};
  const warnings: string[] = [];
  const oversized = params.toString().length > MAX_SCHEMA_SHARE_QUERY_LENGTH;
  if (oversized) warnings.push("Share state exceeds the 8192-character limit; query overrides ignored.");

  const rendererOption = schema.find(({ id }) => id === "renderer.engine");
  let renderer = context.renderer;
  let rendererSelected = false;
  const baseRenderer = baseValues["renderer.engine"];
  if (baseRenderer !== undefined) {
    if (chooseRenderer(baseRenderer, context, schema)) {
      renderer = baseRenderer;
      rendererSelected = true;
    }
    else warnings.push("Renderer from base state is unsupported; active renderer used.");
  }
  if (!oversized && rendererOption) {
    const rendererRaw = readParameter(
      params,
      rendererOption.serialization.kind === "scalar"
        ? rendererOption.serialization.key
        : "renderer",
      rendererOption.label,
      warnings,
    );
    if (rendererRaw.present) {
      if (rendererRaw.valid) {
        const candidate = parseScalar(rendererOption, rendererRaw.value);
        if (chooseRenderer(candidate, context, schema)) {
          renderer = candidate;
          rendererSelected = true;
        }
        else warnings.push("Renderer choice is unsupported; active renderer used.");
      }
    }
  }
  const activeContext = { ...context, renderer };
  const supported = getSupportedOptions(activeContext, schema);
  const supportedIds = new Set(supported.map(({ id }) => id));

  // Materialize concrete defaults first. Derived defaults wait until after
  // caller and query values have established their effective source values.
  for (const option of supported) {
    if (!Object.hasOwn(baseValues, option.id)) {
      setDefault(values, option, activeContext, schema, false);
    }
  }
  if (rendererSelected) values["renderer.engine"] = renderer;
  for (const [id, value] of Object.entries(baseValues)) {
    const option = schema.find((candidate) => candidate.id === id);
    if (!option) {
      warnings.push("Unregistered base option " + id + " omitted.");
      continue;
    }
    if (id === "renderer.engine") {
      if (value !== undefined && chooseRenderer(value, context, schema)) {
        values[id] = renderer;
      }
      continue;
    }
    if (!supportedIds.has(id)) {
      if (value !== undefined) {
        warnings.push(option.label + " is unsupported for the selected renderer; omitted.");
      }
      continue;
    }
    values[id] = value;
  }

  // Caller-provided bases are values too; reject bad ones before URL overrides.
  for (const option of supported) {
    if (!Object.hasOwn(baseValues, option.id)) continue;
    const candidate = values[option.id];
    const available = isOptionAvailable(option, { ...activeContext, values }, schema);
    const errors = available
      ? validateChoice(option, candidate, activeContext, schema)
      : [option.label + " is unavailable under the selected configuration."];
    if (errors.length > 0) {
      warnings.push("Invalid " + option.label + " base value; package default used.");
      delete values[option.id];
      setDefault(values, option, activeContext, schema, false);
    }
  }

  for (const option of supported) {
    if (Object.hasOwn(values, option.id)) continue;
    const entry = getOptionDefault(option.id, activeContext.manifest);
    if (entry?.kind === "derived") setDefault(values, option, activeContext, schema);
  }

  // Keep the base state valid before applying any query so a bad share value
  // can roll back to a known, usable configuration.
  for (const violation of getSchemaConstraintViolations(values, activeContext, schema)) {
    const option = schema.find(({ id }) => id === violation.optionId);
    const other = schema.find(({ id }) => id === violation.otherOptionId);
    if (option) {
      delete values[option.id];
      setDefault(values, option, activeContext, schema);
    }
    if (other) {
      delete values[other.id];
      setDefault(values, other, activeContext, schema);
    }
    warnings.push("Inconsistent base values for " + (option?.label ?? violation.optionId) + "; package defaults used.");
  }
  const baselineValues = { ...values };

  const queryCandidates = new Map<string, unknown>();
  const queryOptionIds = new Set<string>();
  if (!oversized) {
    const knownKeys = new Set(schema.flatMap(serializationKeys));
    const unknownKeys = new Set(
      [...params.keys()].filter((key) => !knownKeys.has(key)),
    );
    for (const key of unknownKeys) {
      warnings.push("Unsupported share-state field " + key + " ignored.");
    }

    for (const option of schema) {
      if (option.id === "renderer.engine" || !hasShareKey(params, option)) continue;
      if (!supportedIds.has(option.id)) {
        warnings.push(option.label + " is unsupported for the selected package or renderer; omitted.");
        continue;
      }
      const parsed = parseCandidate(params, option, warnings);
      if (!parsed.present || !parsed.valid) continue;
      const errors = validateChoice(option, parsed.candidate, activeContext, schema);
      if (errors.length > 0) {
        warnings.push("Invalid " + option.label + " share state; base value used.");
        continue;
      }
      queryCandidates.set(option.id, parsed.candidate);
      queryOptionIds.add(option.id);
    }

    for (const [id, candidate] of queryCandidates) values[id] = candidate;

    // Availability dependencies are checked after every query value has been
    // parsed, so parameter ordering cannot change backend/attribute behavior.
    for (const id of queryOptionIds) {
      const option = schema.find((candidate) => candidate.id === id);
      if (option && !isOptionAvailable(option, { ...activeContext, values }, schema)) {
        delete values[id];
        warnings.push(option.label + " is unavailable under the selected configuration; base value used.");
      }
      if (
        option &&
        !isOptionConditionMet(option, values, (dependencyId) =>
          resolveOptionDefault(
            dependencyId,
            activeContext.manifest,
            new Set(),
            schema,
            values,
          ),
        )
      ) {
        delete values[id];
        if (Object.hasOwn(baselineValues, id)) values[id] = baselineValues[id];
        warnings.push(option.label + " is inactive under the selected configuration; base value used.");
      }
    }

    // Derived values are resolved after all effective values. Omitted entries
    // intentionally stay absent for the adapter to derive at construction.
    for (const option of supported) {
      if (
        getOptionDefault(option.id, activeContext.manifest)?.kind === "derived" &&
        !Object.hasOwn(baseValues, option.id) &&
        !queryOptionIds.has(option.id)
      ) {
        delete values[option.id];
        if (!Object.hasOwn(values, option.id)) {
          setDefault(values, option, activeContext, schema);
        }
      }
    }

    for (const violation of getSchemaConstraintViolations(values, activeContext, schema)) {
      const option = schema.find(({ id }) => id === violation.optionId);
      const other = schema.find(({ id }) => id === violation.otherOptionId);
      if (option) {
        delete values[option.id];
        if (Object.hasOwn(baselineValues, option.id)) values[option.id] = baselineValues[option.id];
        else setDefault(values, option, activeContext, schema);
      }
      if (other) {
        delete values[other.id];
        if (Object.hasOwn(baselineValues, other.id)) values[other.id] = baselineValues[other.id];
        else setDefault(values, other, activeContext, schema);
      }
      warnings.push("Inconsistent " + (option?.label ?? violation.optionId) + " share state; base values used.");
    }
  }

  // If the target renderer changed, stale renderer-only base state is removed.
  for (const [id, value] of Object.entries(values)) {
    if (id === "renderer.engine" || value === undefined) continue;
    if (!supportedIds.has(id)) {
      delete values[id];
      warnings.push((schema.find((option) => option.id === id)?.label ?? id) + " is unavailable for the selected renderer; omitted.");
    }
  }

  const finalErrors = validateSchemaValues(
    values,
    activeContext,
    schema,
    hostValidators,
    { requireRequired: false },
  );
  if (finalErrors.length > 0) {
    warnings.push("Restored state still requires host validation: " + finalErrors.join(" "));
  }

  return { values, warnings };
}

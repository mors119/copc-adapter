import {
  getAvailableChoices,
  getSupportedOptions,
  isOptionAvailable,
  resolveOptionDefault,
} from "./capabilities.ts";
import { OPTION_SCHEMA, isOptionConditionMet } from "./options.ts";
import type {
  CapabilityContext,
  SchemaFocusLens,
  SchemaHostValidators,
  SchemaOption,
} from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlobLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.size === "number" &&
    Number.isFinite(value.size) &&
    typeof value.slice === "function"
  );
}

function validateFocusLens(value: unknown): value is SchemaFocusLens {
  if (!isRecord(value) || value.type !== "screen-circle") return false;
  if (!isRecord(value.center)) return false;
  const x = value.center.x;
  const y = value.center.y;
  const radius = value.radius;
  const detailBias = value.detailBias;
  return (
    typeof x === "number" &&
    Number.isFinite(x) &&
    x >= 0 &&
    x <= 1 &&
    typeof y === "number" &&
    Number.isFinite(y) &&
    y >= 0 &&
    y <= 1 &&
    typeof radius === "number" &&
    Number.isFinite(radius) &&
    radius > 0 &&
    radius <= 1 &&
    typeof detailBias === "number" &&
    Number.isFinite(detailBias) &&
    detailBias >= 1 &&
    detailBias <= 2
  );
}

/** Validate one UI value using schema constraints; adapter checks remain authoritative. */
export function validateOptionValue(
  option: SchemaOption,
  value: unknown,
  hostValidators: SchemaHostValidators = {},
): string[] {
  if (value === undefined) {
    return option.optional ? [] : [option.label + " is required."];
  }
  if (value === null) {
    return option.nullable ? [] : [option.label + " cannot be null."];
  }

  const errors: string[] = [];
  const validation = option.validation;
  switch (validation.kind) {
    case "source":
      if (
        !(typeof value === "string" && value.trim().length > 0) &&
        !isBlobLike(value)
      ) {
        errors.push(option.label + " must be a non-empty URL or a File/Blob.");
      }
      break;
    case "enum": {
      const choices = option.choices ?? [];
      const values = choices.map(({ value: choiceValue }) => choiceValue);
      if (typeof value !== "string" || !values.includes(value)) {
        errors.push(
          option.label + " must be one of: " + values.join(", ") + ".",
        );
      }
      break;
    }
    case "string-array":
      if (
        value !== validation.wildcard &&
        (!Array.isArray(value) ||
          value.some(
            (item) =>
              typeof item !== "string" ||
              item.trim().length === 0,
          ))
      ) {
        errors.push(
          option.label +
            " must be a list of non-empty dimension names or " +
            (validation.wildcard ?? "a supported wildcard") +
            ".",
        );
      }
      break;
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(option.label + " must be a finite number.");
        break;
      }
      if (option.valueType === "integer" && !Number.isSafeInteger(value)) {
        errors.push(option.label + " must be a safe integer.");
      }
      if (
        validation.minimum !== undefined &&
        (validation.minimumExclusive
          ? value <= validation.minimum
          : value < validation.minimum)
      ) {
        errors.push(
          option.label +
            " must be " +
            (validation.minimumExclusive ? "greater than " : "at least ") +
            validation.minimum +
            ".",
        );
      }
      if (
        validation.maximum !== undefined &&
        (validation.maximumExclusive
          ? value >= validation.maximum
          : value > validation.maximum)
      ) {
        errors.push(
          option.label +
            " must be " +
            (validation.maximumExclusive ? "less than " : "at most ") +
            validation.maximum +
            ".",
        );
      }
      break;
    }
    case "boolean":
      if (typeof value !== "boolean") {
        errors.push(option.label + " must be a boolean.");
      }
      break;
    case "classification-filter":
      if (!isRecord(value)) {
        errors.push(option.label + " must be an include/exclude object.");
        break;
      }
      if (Object.keys(value).some((key) => key !== "include" && key !== "exclude")) {
        errors.push(option.label + " contains an unsupported field.");
      }
      for (const key of ["include", "exclude"] as const) {
        const codes = value[key];
        if (codes === undefined) continue;
        if (
          !Array.isArray(codes) ||
          codes.some(
            (code) =>
              typeof code !== "number" ||
              !Number.isSafeInteger(code) ||
              code < validation.itemMinimum ||
              code > validation.itemMaximum,
          )
        ) {
          errors.push(
            option.label +
              " " +
              key +
              " values must be integers from " +
              validation.itemMinimum +
              " to " +
              validation.itemMaximum +
              ".",
          );
        }
      }
      break;
    case "focus-lens":
      if (!validateFocusLens(value)) {
        errors.push(
          option.label +
            " must have a normalized screen-circle center, radius in (0, 1], and detail bias from 1 to 2.",
        );
      }
      break;
    case "vertical-grid":
      if (!hostValidators.isLoadedVerticalGrid?.(value)) {
        errors.push(
          option.label +
            " must be a loaded and verified GTX grid accepted by the host.",
        );
      }
      break;
  }
  return errors;
}

export type SchemaValidationOptions = {
  /** Permit partial state while validating serialized/shareable values. */
  readonly requireRequired?: boolean;
};

export type SchemaConstraintViolation = {
  readonly optionId: string;
  readonly otherOptionId: string;
};

/** Evaluate cross-option relationships using explicit values before defaults. */
export function getSchemaConstraintViolations(
  values: Readonly<Record<string, unknown>>,
  context: Omit<CapabilityContext, "values">,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
): readonly SchemaConstraintViolation[] {
  const supported = getSupportedOptions(context, schema);
  const supportedIds = new Set(supported.map(({ id }) => id));
  const fullContext: CapabilityContext = { ...context, values };
  const violations: SchemaConstraintViolation[] = [];

  for (const option of supported) {
    if (!isOptionAvailable(option, fullContext, schema)) continue;
    if (
      !isOptionConditionMet(option, values, (dependencyId) =>
        resolveOptionDefault(
          dependencyId,
          context.manifest,
          new Set(),
          schema,
          values,
        ),
      )
    ) continue;
    for (const constraint of option.constraints ?? []) {
      const other = schema.find(({ id }) => id === constraint.otherOptionId);
      if (!other || !supportedIds.has(other.id)) continue;
      const configuredValue = values[option.id];
      const value = configuredValue !== undefined
        ? configuredValue
        : resolveOptionDefault(option.id, context.manifest, new Set(), schema, values);
      const configuredOtherValue = values[other.id];
      const otherValue = configuredOtherValue !== undefined
        ? configuredOtherValue
        : resolveOptionDefault(other.id, context.manifest, new Set(), schema, values);
      if (
        constraint.kind === "less-than-or-equal" &&
        typeof value === "number" &&
        typeof otherValue === "number" &&
        value > otherValue
      ) {
        violations.push({ optionId: option.id, otherOptionId: other.id });
      }
    }
  }
  return violations;
}

/**
 * Validate normalized state keyed by schema option ID. Unsupported values are
 * errors; hidden values may remain in pending state but must not be emitted.
 */
export function validateSchemaValues(
  values: Readonly<Record<string, unknown>>,
  context: Omit<CapabilityContext, "values">,
  schema: readonly SchemaOption[] = OPTION_SCHEMA,
  hostValidators: SchemaHostValidators = {},
  options: SchemaValidationOptions = {},
): string[] {
  const supported = getSupportedOptions(context, schema);
  const supportedIds = new Set(supported.map(({ id }) => id));
  const schemaIds = new Set(schema.map(({ id }) => id));
  const errors: string[] = [];
  const fullContext: CapabilityContext = { ...context, values };

  for (const id of Object.keys(values)) {
    if (!schemaIds.has(id)) errors.push("Unregistered option " + id + ".");
  }

  for (const option of schema) {
    const hasValue = Object.hasOwn(values, option.id);
    const value = values[option.id];
    if (!hasValue && options.requireRequired === false) continue;
    if (!supportedIds.has(option.id)) {
      if (hasValue && value !== undefined) {
        errors.push(
          option.label +
            " is unsupported by the selected package, renderer, or active runtime.",
        );
      } else if (!hasValue && options.requireRequired !== false && !option.optional) {
        errors.push(option.label + " is required.");
      }
      continue;
    }
    if (!isOptionAvailable(option, fullContext, schema)) {
      if (hasValue && value !== undefined) {
        errors.push(
          option.label + " is unavailable under the selected configuration.",
        );
      }
      continue;
    }
    errors.push(...validateOptionValue(option, value, hostValidators));

    if (
      typeof value === "string" &&
      option.choices !== undefined &&
      !getAvailableChoices(option, context, schema).some(
        (choice) => choice.value === value,
      )
    ) {
      errors.push(
        option.label +
          " choice " +
          value +
          " is unavailable in the active runtime.",
      );
    }
  }

  for (const violation of getSchemaConstraintViolations(values, context, schema)) {
    const option = schema.find(({ id }) => id === violation.optionId);
    const other = schema.find(({ id }) => id === violation.otherOptionId);
    errors.push(
      (option?.label ?? violation.optionId) +
        " must not exceed " +
        (other?.label ?? violation.otherOptionId) +
        ".",
    );
  }

  return errors;
}

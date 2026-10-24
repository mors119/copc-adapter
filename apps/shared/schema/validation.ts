import {
  getAvailableChoices,
  getSupportedOptions,
  resolveOptionDefault,
} from "./capabilities.ts";
import { OPTION_SCHEMA } from "./options.ts";
import type { CapabilityContext, SchemaOption } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBlobLike(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.size === "number" &&
    typeof value.slice === "function"
  );
}

function validateFocusLens(value: unknown): boolean {
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
    case "enum":
    {
      const choices = option.choices ?? [];
      const values = choices.map(({ value: choiceValue }) => choiceValue);
      if (
        typeof value !== "string" ||
        !values.includes(value)
      ) {
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
      for (const key of ["include", "exclude"] as const) {
        const codes = value[key];
        if (codes === undefined) continue;
        if (
          !Array.isArray(codes) ||
          codes.some(
            (code) =>
              typeof code !== "number" ||
              !Number.isInteger(code) ||
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
      if (!isRecord(value)) {
        errors.push(option.label + " must be a loaded vertical-grid object.");
      }
      break;
  }
  return errors;
}

/**
 * Validate a normalized state record keyed by schema option id.
 * This does not replace package constructor or runtime validation.
 */
export function validateSchemaValues(
  values: Readonly<Record<string, unknown>>,
  context: Omit<CapabilityContext, "values">,
): string[] {
  const options = getSupportedOptions({ ...context, values });
  const availableIds = new Set(options.map(({ id }) => id));
  const errors: string[] = [];
  const schema: readonly SchemaOption[] = OPTION_SCHEMA;

  for (const option of schema) {
    const value = values[option.id];
    if (value === undefined && option.optional) continue;
    if (!availableIds.has(option.id)) {
      if (value !== undefined && value !== null) {
        errors.push(
          option.label +
            " is unavailable for the selected package, renderer, or capabilities.",
        );
      }
      continue;
    }
    errors.push(...validateOptionValue(option, value));

    if (
      typeof value === "string" &&
      option.choices !== undefined &&
      !getAvailableChoices(option, context).some(
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

  for (const option of options) {
    for (const constraint of option.constraints ?? []) {
      const value =
        values[option.id] ??
        resolveOptionDefault(option.id, context.manifest);
      const otherValue =
        values[constraint.otherOptionId] ??
        resolveOptionDefault(constraint.otherOptionId, context.manifest);
      if (
        constraint.kind === "less-than-or-equal" &&
        typeof value === "number" &&
        typeof otherValue === "number" &&
        value > otherValue
      ) {
        const otherLabel =
          schema.find((item) => item.id === constraint.otherOptionId)
            ?.label ?? constraint.otherOptionId;
        errors.push(option.label + " must not exceed " + otherLabel + ".");
      }
    }
  }
  return errors;
}

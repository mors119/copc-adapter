export type UiSegmentOption<Value extends string> = {
  readonly value: Value;
  readonly label: string;
  readonly disabled?: boolean;
  readonly title?: string;
};

export type UiSegmentedControl<Value extends string> = {
  /** Return the currently selected option. */
  getValue(): Value;
  /** Update the selected option without firing the user's change callback. */
  setValue(value: Value): void;
  /** Replace available choices and keep the selection on an enabled option. */
  setOptions(options: readonly UiSegmentOption<Value>[]): void;
  /** Remove the control from the document. */
  destroy(): void;
};

/**
 * Choose the next enabled radio option for standard segmented-control keys.
 * Returns `undefined` when the key does not move selection or no option is enabled.
 */
export function nextSegmentedValue<Value extends string>(
  options: readonly UiSegmentOption<Value>[],
  current: Value,
  key: string,
): Value | undefined {
  const enabled = options.filter((option) => !option.disabled);
  if (enabled.length === 0) return undefined;

  const currentIndex = enabled.findIndex((option) => option.value === current);
  if (key === 'Home') return enabled[0]?.value;
  if (key === 'End') return enabled.at(-1)?.value;
  if (key !== 'ArrowRight' && key !== 'ArrowDown'
    && key !== 'ArrowLeft' && key !== 'ArrowUp') {
    return undefined;
  }

  const start = currentIndex < 0 ? 0 : currentIndex;
  const direction = key === 'ArrowRight' || key === 'ArrowDown' ? 1 : -1;
  return enabled[(start + direction + enabled.length) % enabled.length]?.value;
}

/** Mount an accessible radio-style segmented control into an app-owned container. */
export function mountSegmentedControl<Value extends string>(
  target: HTMLElement,
  options: {
    readonly label: string;
    readonly value: Value;
    readonly choices: readonly UiSegmentOption<Value>[];
    readonly onChange: (value: Value) => void;
    readonly className?: string;
  },
): UiSegmentedControl<Value> {
  const group = document.createElement('div');
  group.className = options.className
    ? `ui-segmented ${options.className}`
    : 'ui-segmented';
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', options.label);

  let choices = [...options.choices];
  let value = options.value;
  const buttons = new Map<Value, HTMLButtonElement>();

  const sync = (): void => {
    const selectedIsEnabled = choices.some((choice) =>
      choice.value === value && !choice.disabled);
    if (!selectedIsEnabled) {
      value = choices.find((choice) => !choice.disabled)?.value ?? value;
    }

    for (const choice of choices) {
      let button = buttons.get(choice.value);
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.setAttribute('role', 'radio');
        button.addEventListener('click', () => select(choice.value, true));
        button.addEventListener('keydown', (event) => {
          const next = nextSegmentedValue(choices, value, event.key);
          if (next === undefined) return;
          event.preventDefault();
          select(next, true);
          buttons.get(next)?.focus();
        });
        buttons.set(choice.value, button);
      }
      button.textContent = choice.label;
      button.setAttribute('aria-checked', String(choice.value === value));
      button.tabIndex = choice.value === value ? 0 : -1;
      button.disabled = choice.disabled ?? false;
      if (choice.title) button.title = choice.title;
      else button.removeAttribute('title');
    }

    for (const [choiceValue, button] of buttons) {
      if (!choices.some((choice) => choice.value === choiceValue)) {
        button.remove();
        buttons.delete(choiceValue);
      }
    }
    group.replaceChildren(...choices.map((choice) => buttons.get(choice.value)!));
  };

  const select = (next: Value, notify: boolean): void => {
    const choice = choices.find((candidate) => candidate.value === next);
    if (!choice || choice.disabled || value === next) return;
    value = next;
    sync();
    if (notify) options.onChange(next);
  };

  target.replaceChildren(group);
  sync();

  return {
    getValue: () => value,
    setValue(next) {
      if (!choices.some((choice) => choice.value === next && !choice.disabled)) return;
      value = next;
      sync();
    },
    setOptions(nextChoices) {
      choices = [...nextChoices];
      sync();
    },
    destroy() {
      group.remove();
      buttons.clear();
    },
  };
}

export type UiRangeScale = {
  readonly min: number;
  readonly max: number;
  readonly step: number;
};

/** Clamp and step-snap a slider value using the range's configured scale. */
export function normalizeRangeValue(value: number, scale: UiRangeScale): number {
  if (!Number.isFinite(value) || !Number.isFinite(scale.min)
    || !Number.isFinite(scale.max) || !Number.isFinite(scale.step)
    || scale.step <= 0 || scale.max < scale.min) {
    throw new RangeError('A slider value and scale must be finite with a positive step.');
  }
  const bounded = Math.min(scale.max, Math.max(scale.min, value));
  const steps = Math.round((bounded - scale.min) / scale.step);
  const snapped = scale.min + steps * scale.step;
  const precision = Math.max(
    decimalPlaces(scale.min),
    decimalPlaces(scale.step),
  );
  return Number(Math.min(scale.max, Math.max(scale.min, snapped)).toFixed(precision));
}

/** Format controls with consistent locale grouping and stable decimal precision. */
export function formatUiNumber(value: number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat(undefined, {
    maximumFractionDigits,
    useGrouping: true,
  }).format(value);
}

export type UiSlider = {
  /** Return the value currently previewed by the native range input. */
  getValue(): number;
  /** Sync a new applied value into the slider without firing callbacks. */
  setValue(value: number): void;
  /** Disable interaction while preserving the currently displayed value. */
  setDisabled(disabled: boolean): void;
  /** Remove the slider from the document. */
  destroy(): void;
};

/**
 * Mount a native range control. `onPreview` runs during dragging; `onCommit`
 * runs once the user releases the pointer or confirms a keyboard value.
 */
export function mountSlider(
  target: HTMLElement,
  options: {
    readonly id?: string;
    readonly label: string;
    readonly min: number;
    readonly max: number;
    readonly step: number;
    readonly value: number;
    readonly formatValue?: (value: number) => string;
    readonly onPreview?: (value: number) => void;
    readonly onCommit: (value: number) => void;
  },
): UiSlider {
  const scale = { min: options.min, max: options.max, step: options.step };
  const id = options.id ?? `ui-range-${++sliderId}`;
  const wrapper = document.createElement('div');
  wrapper.className = 'ui-slider';
  const heading = document.createElement('div');
  heading.className = 'ui-slider__heading';
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = options.label;
  const output = document.createElement('output');
  output.htmlFor = id;
  const input = document.createElement('input');
  input.id = id;
  input.type = 'range';
  input.min = String(options.min);
  input.max = String(options.max);
  input.step = String(options.step);
  input.setAttribute('aria-label', options.label);
  heading.append(label, output);
  wrapper.append(heading, input);
  target.replaceChildren(wrapper);

  const format = options.formatValue ?? ((value: number) => formatUiNumber(value));
  let value = normalizeRangeValue(options.value, scale);
  const sync = (): void => {
    input.value = String(value);
    output.value = format(value);
    output.textContent = format(value);
  };
  input.addEventListener('input', () => {
    value = normalizeRangeValue(Number(input.value), scale);
    sync();
    options.onPreview?.(value);
  });
  input.addEventListener('change', () => options.onCommit(value));
  sync();

  return {
    getValue: () => value,
    setValue(next) {
      value = normalizeRangeValue(next, scale);
      sync();
    },
    setDisabled(disabled) {
      input.disabled = disabled;
    },
    destroy() {
      wrapper.remove();
    },
  };
}

let sliderId = 0;

function decimalPlaces(value: number): number {
  const text = value.toString().toLowerCase();
  const [coefficient, exponentText] = text.split('e');
  const fractionDigits = coefficient?.split('.')[1]?.length ?? 0;
  const exponent = exponentText ? Number(exponentText) : 0;
  return Math.max(0, Math.min(12, fractionDigits - exponent));
}

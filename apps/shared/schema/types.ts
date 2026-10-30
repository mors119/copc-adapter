/** Renderer names understood by the shared Workbench schema. */
export type SchemaRenderer = "cesium" | "three";

/** Renderer-neutral form of the public normalized screen-space focus value. */
export type SchemaFocusLens = {
  readonly type: "screen-circle";
  readonly center: Readonly<{ x: number; y: number }>;
  readonly radius: number;
  readonly detailBias: number;
};

/** WGS 84 ECEF XYZ coordinate in metres. */
export type SchemaEcefPoint = readonly [number, number, number];

/** Public Cesium clipping input, expressed only in WGS 84 ECEF metres. */
export type SchemaClippingVolume =
  | {
      readonly type: "planes";
      readonly coordinateSystem: "wgs84-ecef-meters";
      readonly planes: readonly {
        readonly normal: SchemaEcefPoint;
        readonly point: SchemaEcefPoint;
      }[];
    }
  | {
      readonly type: "box";
      readonly coordinateSystem: "wgs84-ecef-meters";
      readonly minimum: SchemaEcefPoint;
      readonly maximum: SchemaEcefPoint;
    };

/** Public Cesium style filter shape accepted by `setStyle()`. */
export type SchemaClassificationFilter = {
  readonly include?: readonly number[];
  readonly exclude?: readonly number[];
};

/** Configuration sections used for shared panel grouping. */
export type SchemaSection =
  | "source"
  | "renderer"
  | "backend"
  | "style"
  | "streaming"
  | "lod"
  | "focus"
  | "filtering"
  | "attributes"
  | "coordinates"
  | "performance"
  | "cache"
  | "interaction";

/** Semantic value kinds supported by generic and specialized controls. */
export type SchemaValueType =
  | "input-source"
  | "enum"
  | "string-array"
  | "number"
  | "integer"
  | "boolean"
  | "classification-filter"
  | "focus-lens"
  | "clipping-volume"
  | "vertical-grid";

/** Control renderers registered by the shared Workbench. */
export type SchemaControl =
  | "source"
  | "renderer"
  | "select"
  | "attribute-selection"
  | "number"
  | "toggle"
  | "classification-filter"
  | "focus-lens"
  | "opacity"
  | "clipping-volume"
  | "vertical-grid"
  | "cesium-renderer"
  | "action"
  | "terrain-alignment";

export type SchemaApplyMode =
  | "host"
  | "constructor"
  | "runtime"
  | "operation";

export type SchemaValidation =
  | {
      readonly kind: "source";
    }
  | {
      readonly kind: "enum";
    }
  | {
      readonly kind: "string-array";
      readonly wildcard?: string;
    }
  | {
      readonly kind: "number";
      readonly finite: true;
      readonly minimum?: number;
      readonly minimumExclusive?: boolean;
      readonly maximum?: number;
      readonly maximumExclusive?: boolean;
    }
  | {
      readonly kind: "boolean";
    }
  | {
      readonly kind: "classification-filter";
      readonly itemMinimum: 0;
      readonly itemMaximum: 255;
    }
  | {
      readonly kind: "focus-lens";
    }
  | {
      readonly kind: "clipping-volume";
      readonly maximumPlanes: 6;
    }
  | {
      readonly kind: "vertical-grid";
    };

export type SchemaCodeGeneration =
  | {
      readonly kind: "constructor-option";
    }
  | {
      readonly kind: "runtime-method";
      readonly property?: string;
    }
  | {
      readonly kind: "specialized";
      readonly handler: string;
    }
  | {
      readonly kind: "none";
    };

export type SchemaSerialization =
  | {
      readonly kind: "scalar";
      readonly key: string;
    }
  | {
      readonly kind: "classification-filter";
      readonly includeKey: string;
      readonly excludeKey: string;
      /** Explicit marker for a runtime clear (distinct from an omitted filter). */
      readonly clearKey: string;
    }
  | {
      readonly kind: "focus-lens";
      readonly keys: Readonly<{
        centerX: string;
        centerY: string;
        radius: string;
        detailBias: string;
      }>;
      /** Explicit marker for clearing the runtime focus lens. */
      readonly clearKey: string;
    }
  | {
      readonly kind: "clipping-volume";
      readonly key: string;
      /** Explicit marker for clearing the active volume. */
      readonly clearKey: string;
    }
  | {
      readonly kind: "string-array";
      readonly key: string;
    }
  | {
      readonly kind: "none";
    };

export type SchemaChoice = {
  readonly value: string;
  readonly label: string;
  readonly requiredCapabilities?: readonly string[];
};

export type SchemaCondition = {
  readonly optionId: string;
  readonly equals: string | number | boolean;
};

export type SchemaCrossFieldConstraint = {
  readonly kind: "less-than-or-equal";
  readonly otherOptionId: string;
};

/** Presentation hints for schema-generated controls, not adapter constraints. */
export type SchemaControlPresentation = {
  /** Stable host-independent DOM id for the input or control group. */
  readonly controlId?: string;
  /** Optional wrapper id used by existing accessibility and browser contracts. */
  readonly containerId?: string;
  readonly ariaLabel?: string;
  readonly widget?: "native" | "segmented";
  readonly inputId?: string;
  /** A convenience slider range; the number input still accepts the API contract. */
  readonly slider?: {
    readonly id: string;
    readonly label: string;
    readonly minimum: number;
    readonly maximum: number;
    readonly step: number;
    readonly unit?: string;
  };
  /** Convert between an input display unit and the adapter's canonical value. */
  readonly displayScale?: {
    readonly factor: number;
    readonly unit: string;
    readonly fractionDigits?: number;
  };
};

export type SchemaProfileKey = string;

/** One user-facing setting, its adapter mapping, and host capability contract. */
export type SchemaOption = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly section: SchemaSection;
  /** Dot path in normalized Workbench state. */
  readonly statePath: string;
  /** Public constructor or style path; omitted for host-owned settings. */
  readonly apiPath?: string;
  readonly valueType: SchemaValueType;
  readonly control: SchemaControl;
  readonly presentation?: SchemaControlPresentation;
  readonly choices?: readonly SchemaChoice[];
  readonly validation: SchemaValidation;
  readonly constraints?: readonly SchemaCrossFieldConstraint[];
  readonly optional?: boolean;
  /** Null is distinct from omission when an adapter API uses null to clear state. */
  readonly nullable?: boolean;
  readonly renderers: readonly SchemaRenderer[];
  readonly requiredCapabilities?: readonly string[];
  readonly condition?: SchemaCondition;
  /** Unlike a visibility condition, this condition makes the value unsupported. */
  readonly availabilityCondition?: SchemaCondition;
  /** Explanation shown when a declared option is unavailable in this host. */
  readonly packageUnavailableMessage?: string;
  /** Explanation shown when the selected renderer cannot apply this option. */
  readonly rendererUnavailableMessage?: string;
  readonly stability: "stable" | "experimental";
  readonly applyMode:
    | SchemaApplyMode
    | Readonly<Partial<Record<SchemaRenderer, SchemaApplyMode>>>;
  readonly runtimeMethod?: string;
  readonly codeGeneration: SchemaCodeGeneration;
  readonly serialization: SchemaSerialization;
  /** Explicit defaults keyed by verified package origin and version. */
  readonly defaults: Readonly<Partial<Record<SchemaProfileKey, SchemaDefault>>>;
};

/** A shared Workbench action backed by an adapter or host capability. */
export type SchemaActionDefinition = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly section: SchemaSection;
  readonly control: "action" | "terrain-alignment";
  readonly renderers: readonly SchemaRenderer[];
  readonly requiredCapabilities: readonly string[];
  readonly stability: "stable" | "experimental";
};

export type SchemaDefault =
  | {
      readonly kind: "value";
      readonly value: unknown;
    }
  | {
      /** Preserve the adapter's own default by omitting this option. */
      readonly kind: "omitted";
    }
  | {
      /** A documented default derived from another adapter option. */
      readonly kind: "derived";
      readonly from: string;
      readonly operation: "multiply";
      readonly factor: number;
    };

/** Package provenance is part of capability resolution, not inferred from a label. */
/** Candidate tarballs are a distinct source and never inherit npm/workspace profiles. */
export type PackageOrigin = "npm" | "workspace" | "candidate";

export type AdapterManifest = {
  readonly origin: PackageOrigin;
  readonly version: string;
  readonly supportedOptionIds: readonly string[];
  /** Sparse release-specific exclusions for otherwise supported renderer options. */
  readonly unsupportedOptionIdsByRenderer?: Readonly<
    Partial<Record<SchemaRenderer, readonly string[]>>
  >;
  readonly capabilities: readonly string[];
  readonly defaults: Readonly<Record<string, SchemaDefault>>;
};

export type CapabilityContext = {
  readonly manifest: AdapterManifest;
  readonly renderer: SchemaRenderer;
  /** Capabilities reported by the active host/renderer instance. */
  readonly runtimeCapabilities?: readonly string[];
  readonly values?: Readonly<Record<string, unknown>>;
};

/** Specialized runtime checks stay with the app host that owns the resource. */
export type SchemaHostValidators = {
  /** True only for a loaded and verified library GTX grid instance. */
  readonly isLoadedVerticalGrid?: (value: unknown) => boolean;
};

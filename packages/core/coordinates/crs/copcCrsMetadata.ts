/** How directly a CRS diagnostic value is stated by the source metadata. */
export type CopcCrsEvidenceCertainty = "explicit" | "inferred" | "unknown";

/** Normalized coordinate unit information read from source WKT. */
export type CopcCrsUnitDiagnostic = {
  /** Whether this unit measures angle, length, or could not be resolved. */
  kind: "angular" | "linear" | "unknown";
  /** Unit name copied from the WKT declaration. */
  name?: string;
  /** Conversion factor to radians or metres, when explicitly declared. */
  toSi?: number;
  /** Recognized unit family, including the two distinct foot definitions. */
  standard?: "degree" | "metre" | "international-foot" | "us-survey-foot" | "other";
  /** Whether the source states this unit or it remains unknown. */
  certainty: CopcCrsEvidenceCertainty;
};

/** CRS name and identifier copied from a WKT CRS element. */
export type CopcCrsIdentityDiagnostic = {
  /** CRS name from WKT. */
  name: string;
  /** Authority name from a direct CRS identifier, when present. */
  authority?: string;
  /** Authority code from a direct CRS identifier, when present. */
  code?: string;
  /** Literal CRS identity is source evidence, even when it is not registered. */
  certainty: "explicit";
};

/** One compact, source-attributed fact supporting a diagnostic value. */
export type CopcCrsEvidence = {
  /** Diagnostic field supported by this evidence. */
  field: "horizontal" | "vertical" | "units" | "axis-order" | "wkt";
  /** Evidence was read from the source's retained CRS WKT. */
  source: "wkt";
  /** Small literal excerpt such as a CRS identifier, unit or axis declaration. */
  value: string;
  /** How directly the excerpt establishes the normalized value. */
  certainty: CopcCrsEvidenceCertainty;
};

/** Stable machine-readable issue found while interpreting source CRS metadata. */
export type CopcCrsDiagnosticReasonCode =
  | "missing-wkt"
  | "malformed-wkt"
  | "unsupported-wkt-syntax"
  | "missing-horizontal-crs"
  | "ambiguous-horizontal-crs"
  | "conflicting-identifiers"
  | "conflicting-source-wkt"
  | "conflicting-axis-units"
  | "inconsistent-unit-declaration"
  | "missing-horizontal-unit"
  | "unsupported-horizontal-unit"
  | "missing-vertical-unit"
  | "unsupported-vertical-unit"
  | "unknown-vertical-reference";

/** A stable CRS diagnostic reason and its concise explanation. */
export type CopcCrsDiagnosticReason = {
  /** Stable reason code for application logic and regression tests. */
  code: CopcCrsDiagnosticReasonCode;
  /** Human-readable explanation that may be shown in developer diagnostics. */
  message: string;
};

/**
 * Renderer-neutral interpretation of COPC source CRS metadata.
 *
 * This reports source evidence, not the output coordinate system and not a
 * guarantee that a backend can transform every recognized WKT definition.
 */
export type CopcCrsMetadataDiagnostic = {
  /** Schema version for stable consumer-side interpretation. */
  version: 1;
  /** Source WKT parsing capability; transform support remains backend-specific. */
  wkt: {
    format: "WKT1" | "WKT2" | "unknown";
    metadataSupport: "supported" | "unsupported" | "malformed" | "missing";
    transformSupport: "backend-dependent";
    source: "vlr" | "evlr" | "unknown";
    conflictingSources: boolean;
  };
  /** Source horizontal coordinate reference facts. */
  horizontal: {
    identity?: CopcCrsIdentityDiagnostic;
    axisOrder: {
      order:
        | "east-north"
        | "north-east"
        | "longitude-latitude"
        | "latitude-longitude"
        | "unknown";
      certainty: CopcCrsEvidenceCertainty;
    };
    units: CopcCrsUnitDiagnostic;
  };
  /** Source vertical reference facts, separate from adapter output height. */
  vertical: {
    identity?: CopcCrsIdentityDiagnostic;
    units: CopcCrsUnitDiagnostic;
    heightKind: {
      value: "ellipsoidal" | "gravity-related/orthometric" | "local/unknown";
      certainty: CopcCrsEvidenceCertainty;
    };
  };
  /** Literal source evidence used by this diagnostic. The full WKT remains in metadata.wkt. */
  evidence: readonly CopcCrsEvidence[];
  /** Stable reasons for unknown, conflicting, malformed or unsupported facts. */
  reasons: readonly CopcCrsDiagnosticReason[];
};

/** Location and consistency of WKT records carried by LAS metadata. */
export type CopcCrsWktProvenance = {
  /** First WKT record chosen by the backend's VLR-before-EVLR precedence. */
  selected: "vlr" | "evlr" | "unknown";
  /** Locations where a WKT record was present, in source order. */
  available: readonly ("vlr" | "evlr")[];
  /** True when both locations declare different WKT text. */
  conflicting: boolean;
};

type MutableCopcCrsMetadataDiagnostic = Omit<CopcCrsMetadataDiagnostic, "evidence" | "reasons"> & {
  evidence: CopcCrsEvidence[];
  reasons: CopcCrsDiagnosticReason[];
};

type WktSection = { keyword: string; text: string };
type ParsedUnit = { kind: "angular" | "linear"; name: string; toSi: number };
type ParsedIdentity = {
  name: string;
  authority?: string;
  code?: string;
  conflict: boolean;
};

const WKT1_ROOTS = new Set(["GEOGCS", "PROJCS", "VERT_CS", "COMPD_CS", "GEOCCS", "LOCAL_CS"]);
const WKT1_CRS = new Set(["GEOGCS", "PROJCS", "VERT_CS", "COMPD_CS"]);
const WKT2_ROOTS = new Set([
  "GEOGCRS", "GEODCRS", "PROJCRS", "VERTCRS", "COMPOUNDCRS",
  "BOUNDCRS", "ENGCRS", "PARAMETRICCRS", "TIMECRS", "DERIVEDPROJCRS",
]);
const WKT2_CRS = new Set(["GEOGCRS", "GEODCRS", "PROJCRS", "VERTCRS", "COMPOUNDCRS"]);

function findSectionEnd(source: string, start: number): number | undefined {
  let depth = 0;
  let quoted = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === "[") {
      depth += 1;
    } else if (!quoted && character === "]") {
      depth -= 1;
      if (depth === 0) return index;
      if (depth < 0) return undefined;
    }
  }
  return undefined;
}

function rootSection(wkt: string): WktSection | undefined {
  const match = /^\s*([A-Z][A-Z0-9_]*)\s*\[/i.exec(wkt);
  if (!match) return undefined;
  const start = wkt.indexOf("[", match.index + match[0].indexOf(match[1]));
  const end = findSectionEnd(wkt, start);
  if (end === undefined || wkt.slice(end + 1).trim() !== "") return undefined;
  return { keyword: match[1].toUpperCase(), text: wkt.slice(match.index + match[0].indexOf(match[1]), end + 1) };
}

function directSections(section: string): WktSection[] {
  const result: WktSection[] = [];
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < section.length; index += 1) {
    const character = section[index];
    if (character === '"') {
      if (quoted && section[index + 1] === '"') index += 1;
      else quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (depth === 1 && /[A-Z]/i.test(character)) {
      const match = /^([A-Z][A-Z0-9_]*)\s*\[/i.exec(section.slice(index));
      if (match) {
        const open = index + match[0].lastIndexOf("[");
        const end = findSectionEnd(section, open);
        if (end === undefined) return result;
        result.push({ keyword: match[1].toUpperCase(), text: section.slice(index, end + 1) });
        index = end;
        continue;
      }
    }
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
    }
  }
  return result;
}

function quotedName(section: string): string | undefined {
  return /^\s*[A-Z][A-Z0-9_]*\s*\[\s*"((?:""|[^"])*)"/i.exec(section)?.[1]?.replaceAll('""', '"');
}

function parseIdentity(section: string): ParsedIdentity | undefined {
  const name = quotedName(section);
  if (!name) return undefined;
  const identifiers = directSections(section)
    .filter(({ keyword }) => keyword === "ID" || keyword === "AUTHORITY")
    .map(({ text }) => /^(?:ID|AUTHORITY)\s*\[\s*"([^"]+)"\s*,\s*(?:"([^"]+)"|(\d+))/i.exec(text))
    .filter((item): item is RegExpExecArray => item !== null)
    .map((item) => ({ authority: item[1], code: item[2] ?? item[3] }));
  const unique = new Set(identifiers.map(({ authority, code }) => `${authority.toUpperCase()}:${code}`));
  return {
    name,
    ...(identifiers[0] ? { authority: identifiers[0].authority, code: identifiers[0].code } : {}),
    conflict: unique.size > 1,
  };
}

function parseUnit(section: string, keywords: readonly string[]): ParsedUnit | undefined {
  const root = /^\s*([A-Z][A-Z0-9_]*)\s*\[/i.exec(section);
  const candidates = [
    ...(root ? [{ keyword: root[1].toUpperCase(), text: section.trim() }] : []),
    ...allSections(section),
  ];
  for (const { keyword, text } of candidates) {
    if (!keywords.includes(keyword)) continue;
    const match = /^(?:UNIT|LENGTHUNIT|ANGLEUNIT)\s*\[\s*"((?:""|[^"])*)"\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i.exec(text);
    if (!match) continue;
    const toSi = Number(match[2]);
    if (!Number.isFinite(toSi) || toSi <= 0) continue;
    return {
      kind: keyword === "ANGLEUNIT" ? "angular" : keywords.includes("ANGLEUNIT") && !keywords.includes("LENGTHUNIT") ? "angular" : "linear",
      name: match[1].replaceAll('""', '"'),
      toSi,
    };
  }
  return undefined;
}

function allSections(section: string): WktSection[] {
  const result: WktSection[] = [];
  let quoted = false;
  for (let index = 0; index < section.length; index += 1) {
    const character = section[index];
    if (character === '"') {
      if (quoted && section[index + 1] === '"') index += 1;
      else quoted = !quoted;
      continue;
    }
    if (quoted || !/[A-Z]/i.test(character)) continue;
    const match = /^([A-Z][A-Z0-9_]*)\s*\[/i.exec(section.slice(index));
    if (!match || (index > 0 && /[A-Z0-9_]/i.test(section[index - 1]))) continue;
    const open = index + match[1].length;
    let bracket = open;
    while (/\s/.test(section[bracket] ?? "")) bracket += 1;
    const end = findSectionEnd(section, bracket);
    if (end === undefined) continue;
    result.push({ keyword: match[1].toUpperCase(), text: section.slice(index, end + 1) });
    index += match[1].length - 1;
  }
  return result;
}

function unitDiagnostic(unit: ParsedUnit | undefined): CopcCrsUnitDiagnostic {
  if (!unit) return { kind: "unknown", certainty: "unknown" };
  const normalizedName = unit.name.toLowerCase().replaceAll("_", " ").trim();
  let standard: CopcCrsUnitDiagnostic["standard"] = "other";
  if (unit.kind === "angular" && (normalizedName === "degree" || normalizedName === "degrees")) standard = "degree";
  else if (unit.kind === "linear" && ["metre", "meter", "metres", "meters"].includes(normalizedName) && unit.toSi === 1) standard = "metre";
  else if (unit.kind === "linear" && Math.abs(unit.toSi - 0.3048) < 1e-12) standard = "international-foot";
  else if (unit.kind === "linear" && Math.abs(unit.toSi - 0.304800609601219) < 1e-14) standard = "us-survey-foot";
  return { kind: unit.kind, name: unit.name, toSi: unit.toSi, standard, certainty: "explicit" };
}

function isUnitDeclarationConsistent(unit: ParsedUnit): boolean {
  const name = unit.name.toLowerCase().replaceAll("_", " ").trim();
  const expected =
    name === "degree" || name === "degrees"
      ? Math.PI / 180
      : ["metre", "meter", "metres", "meters"].includes(name)
        ? 1
        : ["foot", "feet", "international foot", "international feet"].includes(name)
          ? 0.3048
          : ["us survey foot", "us survey feet"].includes(name)
            ? 0.304800609601219
            : undefined;
  return expected === undefined || Math.abs(unit.toSi - expected) <= Math.max(1e-14, expected * 1e-12);
}

function parseAxis(section: string): { name: string; direction: string } | undefined {
  const match = /^AXIS\s*\[\s*"((?:""|[^"])*)"\s*,\s*"?([A-Z]+)"?/i.exec(section);
  return match ? { name: match[1].replaceAll('""', '"'), direction: match[2].toUpperCase() } : undefined;
}

function axisOrder(axes: readonly { name: string; direction: string }[]): CopcCrsMetadataDiagnostic["horizontal"]["axisOrder"] {
  const directions = axes.slice(0, 2).map(({ direction }) => direction);
  if (directions.length !== 2) return { order: "unknown", certainty: "unknown" };
  const order = directions.join("-");
  const names = axes.slice(0, 2).map(({ name }) => name.toLowerCase());
  if (names[0].includes("longitude") && names[1].includes("latitude")) return { order: "longitude-latitude", certainty: "explicit" };
  if (names[0].includes("latitude") && names[1].includes("longitude")) return { order: "latitude-longitude", certainty: "explicit" };
  if (order === "EAST-NORTH") return { order: "east-north", certainty: "explicit" };
  if (order === "NORTH-EAST") return { order: "north-east", certainty: "explicit" };
  return { order: "unknown", certainty: "unknown" };
}

function emptyDiagnostic(): MutableCopcCrsMetadataDiagnostic {
  return {
    version: 1,
    wkt: { format: "unknown", metadataSupport: "missing", transformSupport: "backend-dependent", source: "unknown", conflictingSources: false },
    horizontal: { axisOrder: { order: "unknown", certainty: "unknown" }, units: { kind: "unknown", certainty: "unknown" } },
    vertical: { units: { kind: "unknown", certainty: "unknown" }, heightKind: { value: "local/unknown", certainty: "unknown" } },
    evidence: [],
    reasons: [],
  };
}

function identityDiagnostic(identity: ParsedIdentity): CopcCrsIdentityDiagnostic {
  return { name: identity.name, ...(identity.authority ? { authority: identity.authority } : {}), ...(identity.code ? { code: identity.code } : {}), certainty: "explicit" };
}

function addReason(diagnostic: MutableCopcCrsMetadataDiagnostic, code: CopcCrsDiagnosticReasonCode, message: string): void {
  if (!diagnostic.reasons.some((reason) => reason.code === code)) diagnostic.reasons.push({ code, message });
}

function isHorizontal(keyword: string): boolean {
  return ["GEOGCS", "PROJCS", "GEOGCRS", "GEODCRS", "PROJCRS"].includes(keyword);
}

function isVertical(keyword: string): boolean {
  return keyword === "VERT_CS" || keyword === "VERTCRS";
}

function unresolvedUnit(keywords: readonly string[]): ParsedUnit {
  return {
    kind: keywords.includes("ANGLEUNIT") && !keywords.includes("LENGTHUNIT")
      ? "angular"
      : "linear",
    name: "__unsupported_units__",
    toSi: Number.NaN,
  };
}

function declaredUnit(section: string, keyword: string, axis?: string): ParsedUnit | undefined {
  const isGeographic = ["GEOGCS", "GEOGCRS", "GEODCRS"].includes(keyword);
  const targets = isGeographic ? ["ANGLEUNIT", "UNIT"] : ["LENGTHUNIT", "UNIT"];
  if (axis) {
    const axisUnit = parseUnit(axis, targets);
    if (axisUnit) return axisUnit;
    if (allSections(axis).some(({ keyword: child }) => targets.includes(child))) {
      return unresolvedUnit(targets);
    }
  }
  const axes = directSections(section).filter(({ keyword: child }) => child === "AXIS");
  const axisDeclarations = axes.map(({ text }) => ({
    hasUnit: allSections(text).some(({ keyword: child }) => targets.includes(child)),
    unit: parseUnit(text, targets),
  }));
  const direct = directSections(section).filter(({ keyword: child }) => targets.includes(child));
  const directUnit = direct.length > 0 ? parseUnit(direct[0].text, targets) : undefined;
  if (!axisDeclarations.some(({ hasUnit }) => hasUnit)) {
    return direct.length > 0 ? directUnit ?? unresolvedUnit(targets) : undefined;
  }
  if (axisDeclarations.some(({ hasUnit, unit }) => !hasUnit || !unit)) {
    return unresolvedUnit(targets);
  }
  const axisUnits = axisDeclarations.map(({ unit }) => unit!);
  const first = axisUnits[0];
  const inconsistentAxisUnits = axisUnits.some((unit) =>
    unit.kind !== first.kind ||
    Math.abs(unit.toSi - first.toSi) > Math.max(1e-14, first.toSi * 1e-12),
  );
  if (inconsistentAxisUnits) return { ...first, name: "__conflicting_units__" };
  if (direct.length > 0) {
    if (!directUnit) return unresolvedUnit(targets);
    if (
      directUnit.kind !== first.kind ||
      Math.abs(directUnit.toSi - first.toSi) > Math.max(1e-14, first.toSi * 1e-12)
    ) {
      return { ...first, name: "__conflicting_units__" };
    }
  }
  return first;
}

function hasCoordinateUnitDeclaration(section: string, keyword: string): boolean {
  const geographic = ["GEOGCS", "GEOGCRS", "GEODCRS"].includes(keyword);
  const targets = geographic ? ["ANGLEUNIT", "UNIT"] : ["LENGTHUNIT", "UNIT"];
  const direct = directSections(section);
  return (
    direct.some(({ keyword: child }) => targets.includes(child)) ||
    direct
      .filter(({ keyword: child }) => child === "AXIS")
      .some(({ text }) => allSections(text).some(({ keyword: child }) => targets.includes(child)))
  );
}

/**
 * Resolve source CRS facts from retained COPC WKT without using coordinate
 * ranges, output coordinates, or dataset location as CRS evidence.
 *
 * @param wkt Original source WKT, when present.
 * @returns A versioned diagnostic. Missing or unsupported facts stay unknown.
 */
export function resolveCopcCrsMetadata(
  wkt: string | undefined,
  provenance?: CopcCrsWktProvenance,
): CopcCrsMetadataDiagnostic {
  const diagnostic = emptyDiagnostic();
  if (provenance) {
    diagnostic.wkt.source = provenance.selected;
    diagnostic.wkt.conflictingSources = provenance.conflicting;
    diagnostic.evidence.push({
      field: "wkt",
      source: "wkt",
      value: `selected=${provenance.selected}; available=${provenance.available.join(",") || "none"}`,
      certainty: provenance.conflicting ? "inferred" : "explicit",
    });
    if (provenance.conflicting) {
      addReason(diagnostic, "conflicting-source-wkt", `Multiple WKT records contain different CRS definitions; the first ${provenance.selected.toUpperCase()} value takes precedence.`);
    }
  }
  if (!wkt?.trim()) {
    addReason(diagnostic, "missing-wkt", "The source does not provide CRS WKT.");
    return diagnostic;
  }

  const root = rootSection(wkt);
  if (!root) {
    diagnostic.wkt.metadataSupport = "malformed";
    addReason(diagnostic, "malformed-wkt", "The source CRS WKT is malformed or has trailing content.");
    return diagnostic;
  }
  const wkt1 = WKT1_ROOTS.has(root.keyword);
  const wkt2 = WKT2_ROOTS.has(root.keyword);
  diagnostic.wkt.format = wkt1 ? "WKT1" : wkt2 ? "WKT2" : "unknown";
  if (!WKT1_CRS.has(root.keyword) && !WKT2_CRS.has(root.keyword)) {
    diagnostic.wkt.metadataSupport = "unsupported";
    addReason(diagnostic, "unsupported-wkt-syntax", `The metadata resolver does not support root WKT element ${root.keyword}.`);
    return diagnostic;
  }

  const rootChildren = directSections(root.text);
  const horizontalSections = rootChildren.filter(({ keyword }) => isHorizontal(keyword));
  const verticalSections = rootChildren.filter(({ keyword }) => isVertical(keyword));
  const rootIsHorizontal = isHorizontal(root.keyword);
  const horizontal = rootIsHorizontal
    ? root
    : horizontalSections.length === 1
      ? horizontalSections[0]
      : undefined;
  const vertical = isVertical(root.keyword)
    ? root
    : verticalSections.length === 1
      ? verticalSections[0]
      : undefined;
  if (horizontalSections.length > 1 && !rootIsHorizontal) {
    addReason(diagnostic, "ambiguous-horizontal-crs", "The compound CRS contains more than one horizontal CRS component.");
  }
  if (!horizontal) addReason(diagnostic, "missing-horizontal-crs", "The WKT does not identify one supported horizontal CRS component.");
  if (verticalSections.length > 1 && !isVertical(root.keyword)) {
    addReason(diagnostic, "unknown-vertical-reference", "The compound CRS contains more than one vertical CRS component.");
  }

  if (horizontal) {
    const identity = parseIdentity(horizontal.text);
    if (!identity) {
      diagnostic.wkt.metadataSupport = "malformed";
      addReason(diagnostic, "malformed-wkt", "The horizontal CRS does not contain a quoted name.");
      return diagnostic;
    }
    if (identity.conflict) {
      diagnostic.horizontal.identity = { name: identity.name, certainty: "explicit" };
      diagnostic.evidence.push({ field: "horizontal", source: "wkt", value: `${identity.name}; conflicting direct identifiers`, certainty: "explicit" });
      addReason(diagnostic, "conflicting-identifiers", "The horizontal CRS declares conflicting direct identifiers.");
    }
    else {
      diagnostic.horizontal.identity = identityDiagnostic(identity);
      diagnostic.evidence.push({ field: "horizontal", source: "wkt", value: identity.authority && identity.code ? `${identity.authority}:${identity.code}` : identity.name, certainty: "explicit" });
    }
    const axes = directSections(horizontal.text).filter(({ keyword }) => keyword === "AXIS").map(({ text }) => parseAxis(text)).filter((axis): axis is { name: string; direction: string } => axis !== undefined);
    diagnostic.horizontal.axisOrder = axisOrder(axes);
    if (diagnostic.horizontal.axisOrder.certainty === "explicit") diagnostic.evidence.push({ field: "axis-order", source: "wkt", value: axes.slice(0, 2).map(({ direction }) => direction.toLowerCase()).join(","), certainty: "explicit" });
    const horizontalUnit = declaredUnit(horizontal.text, horizontal.keyword);
    if (horizontalUnit?.name === "__conflicting_units__") {
      addReason(diagnostic, "conflicting-axis-units", "Horizontal coordinate axes declare inconsistent units.");
    } else if (horizontalUnit?.name === "__unsupported_units__") {
      addReason(diagnostic, "unsupported-horizontal-unit", "A horizontal coordinate axis declares a unit that cannot be normalized safely.");
    } else if (horizontalUnit) {
      diagnostic.horizontal.units = unitDiagnostic(horizontalUnit);
      diagnostic.evidence.push({ field: "units", source: "wkt", value: `${horizontalUnit.name} (${horizontalUnit.toSi})`, certainty: "explicit" });
      if (!isUnitDeclarationConsistent(horizontalUnit)) {
        diagnostic.horizontal.units = { ...diagnostic.horizontal.units, standard: "other" };
        addReason(diagnostic, "inconsistent-unit-declaration", "A horizontal unit name conflicts with its declared conversion factor.");
      }
    } else {
      const code = hasCoordinateUnitDeclaration(horizontal.text, horizontal.keyword)
        ? "unsupported-horizontal-unit"
        : "missing-horizontal-unit";
      addReason(diagnostic, code, code === "missing-horizontal-unit"
        ? "The horizontal CRS does not declare its coordinate unit."
        : "The horizontal CRS declares a unit that cannot be normalized safely.");
    }
  }

  if (vertical) {
    const identity = parseIdentity(vertical.text);
    if (!identity) {
      diagnostic.wkt.metadataSupport = "malformed";
      addReason(diagnostic, "malformed-wkt", "The vertical CRS does not contain a quoted name.");
      return diagnostic;
    }
    if (identity.conflict) {
      diagnostic.vertical.identity = { name: identity.name, certainty: "explicit" };
      diagnostic.evidence.push({ field: "vertical", source: "wkt", value: `${identity.name}; conflicting direct identifiers`, certainty: "explicit" });
      addReason(diagnostic, "conflicting-identifiers", "The vertical CRS declares conflicting direct identifiers.");
    }
    else {
      diagnostic.vertical.identity = identityDiagnostic(identity);
      diagnostic.evidence.push({ field: "vertical", source: "wkt", value: identity.authority && identity.code ? `${identity.authority}:${identity.code}` : identity.name, certainty: "explicit" });
    }
    const axisSection = directSections(vertical.text).find(({ keyword }) => keyword === "AXIS")?.text;
    const axis = axisSection ? parseAxis(axisSection) : undefined;
    const verticalUnit = declaredUnit(vertical.text, vertical.keyword, axisSection);
    if (verticalUnit?.name === "__conflicting_units__") {
      addReason(diagnostic, "conflicting-axis-units", "Vertical coordinate axes declare inconsistent units.");
    } else if (verticalUnit?.name === "__unsupported_units__") {
      addReason(diagnostic, "unsupported-vertical-unit", "The vertical coordinate axis declares a unit that cannot be normalized safely.");
    } else if (verticalUnit) {
      diagnostic.vertical.units = unitDiagnostic(verticalUnit);
      diagnostic.evidence.push({ field: "units", source: "wkt", value: `${verticalUnit.name} (${verticalUnit.toSi})`, certainty: "explicit" });
      if (!isUnitDeclarationConsistent(verticalUnit)) {
        diagnostic.vertical.units = { ...diagnostic.vertical.units, standard: "other" };
        addReason(diagnostic, "inconsistent-unit-declaration", "A vertical unit name conflicts with its declared conversion factor.");
      }
    } else {
      const code = hasCoordinateUnitDeclaration(vertical.text, vertical.keyword)
        ? "unsupported-vertical-unit"
        : "missing-vertical-unit";
      addReason(diagnostic, code, code === "missing-vertical-unit"
        ? "The vertical CRS does not declare its coordinate unit."
        : "The vertical CRS declares a unit that cannot be normalized safely.");
    }
    const semanticText = `${identity.name} ${axis?.name ?? ""}`.toLowerCase();
    if (/ellipsoid/.test(semanticText)) {
      diagnostic.vertical.heightKind = { value: "ellipsoidal", certainty: "explicit" };
      diagnostic.evidence.push({ field: "vertical", source: "wkt", value: axis?.name ?? identity.name, certainty: "explicit" });
    } else if (/orthometric|gravity[- ]related/.test(semanticText)) {
      diagnostic.vertical.heightKind = { value: "gravity-related/orthometric", certainty: "explicit" };
      diagnostic.evidence.push({ field: "vertical", source: "wkt", value: axis?.name ?? identity.name, certainty: "explicit" });
    } else if (!identity.conflict && identity.authority?.toUpperCase() === "EPSG" && ["5703", "6360", "5773", "3855"].includes(identity.code ?? "")) {
      diagnostic.vertical.heightKind = { value: "gravity-related/orthometric", certainty: "inferred" };
      diagnostic.evidence.push({ field: "vertical", source: "wkt", value: `EPSG:${identity.code}`, certainty: "inferred" });
    } else {
      addReason(diagnostic, "unknown-vertical-reference", "The vertical CRS does not establish ellipsoidal or gravity-related height semantics.");
    }
  } else if (horizontal?.keyword === "GEOGCRS" || horizontal?.keyword === "GEODCRS") {
    const identity = parseIdentity(horizontal.text);
    const axes = directSections(horizontal.text).filter(({ keyword }) => keyword === "AXIS").map(({ text }) => parseAxis(text)).filter((axis): axis is { name: string; direction: string } => axis !== undefined);
    const cs = directSections(horizontal.text).find(({ keyword }) => keyword === "CS")?.text.match(/^CS\s*\[\s*"?([A-Z_]+)"?\s*,\s*(\d+)/i);
    if (!identity?.conflict && identity?.authority?.toUpperCase() === "EPSG" && identity.code === "4979" && cs?.[1].toLowerCase() === "ellipsoidal" && Number(cs[2]) === 3 && axes.length === 3 && axes.some(({ direction }) => direction === "UP")) {
      diagnostic.vertical.heightKind = { value: "ellipsoidal", certainty: "explicit" };
      const heightAxis = directSections(horizontal.text).filter(({ keyword }) => keyword === "AXIS")[2]?.text;
      const heightUnit = heightAxis ? parseUnit(heightAxis, ["LENGTHUNIT"]) : undefined;
      if (heightUnit) diagnostic.vertical.units = unitDiagnostic(heightUnit);
      diagnostic.evidence.push({ field: "vertical", source: "wkt", value: "EPSG:4979, ellipsoidal 3D CRS with UP axis", certainty: "explicit" });
    } else {
      addReason(diagnostic, "unknown-vertical-reference", "The geographic CRS does not explicitly identify a supported vertical component.");
    }
  } else {
    addReason(diagnostic, "unknown-vertical-reference", "The source does not declare a vertical CRS component.");
  }

  if (diagnostic.wkt.metadataSupport !== "malformed") diagnostic.wkt.metadataSupport = "supported";
  return diagnostic;
}

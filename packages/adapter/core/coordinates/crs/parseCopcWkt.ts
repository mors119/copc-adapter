export function extractHorizontalWkt(wkt: string): string {
  const projected =
    findWktSectionWithOffset(wkt, "PROJCS[") ??
    findWktSectionWithOffset(wkt, "PROJCRS[");
  if (!projected) {
    throw new Error("COPC WKT does not contain a projected horizontal CRS");
  }
  return projected.section;
}

/** Extract the horizontal CRS component from supported WKT1 and WKT2 forms. */
export function extractHorizontalCrsWkt(wkt: string): string {
  const rootStart = wkt.search(/\S/);
  const rootCompound = findWktSectionWithOffset(wkt, "COMPOUNDCRS[");
  const compoundGeographic = rootCompound
    ? findDirectWktSections(rootCompound.section, ["GEOGCRS["])[0]?.section
    : undefined;
  const rootGeographic3d = findWktSectionWithOffset(wkt, "GEOGCRS[");
  const horizontal = [
    findWktSectionWithOffset(wkt, "PROJCS["),
    findWktSectionWithOffset(wkt, "PROJCRS["),
    findWktSectionWithOffset(wkt, "GEOGCS["),
    rootGeographic3d?.start === rootStart ? rootGeographic3d : undefined,
    rootCompound && compoundGeographic
      ? {
          start: rootCompound.start + rootCompound.section.indexOf(compoundGeographic),
          section: compoundGeographic,
        }
      : undefined,
  ]
    .filter((match): match is WktSectionMatch => match !== undefined)
    .sort((left, right) => left.start - right.start)[0];
  if (!horizontal) {
    throw new Error("COPC WKT does not contain a supported horizontal CRS");
  }
  return horizontal.section;
}

export type HorizontalAxisDirection = "east" | "west" | "north" | "south";
export type HorizontalAxisDirections = readonly [
  HorizontalAxisDirection,
  HorizontalAxisDirection,
];

/**
 * Read the first two horizontal axis directions in their declared CRS order.
 *
 * Missing axes retain the adapter's established X/Y tuple behavior. When axes
 * are present, only one east/west and one north/south axis are transformable.
 */
export function getHorizontalAxisDirections(
  wkt: string,
): HorizontalAxisDirections | undefined {
  const horizontalWkt = extractHorizontalCrsWkt(wkt);
  const axes = findDirectWktSections(horizontalWkt, ["AXIS["]);
  if (axes.length === 0) return undefined;
  if (axes.length < 2) {
    throw new Error("COPC horizontal CRS must declare two transformable axes");
  }
  const orderedAxes = axes
    .map(({ section }, index) => {
      const orderSection = findDirectWktSections(section, ["ORDER["])[0]?.section;
      const orderMatch = orderSection?.match(/^ORDER\s*\[\s*(\d+)\s*\]/i);
      if (orderSection && !orderMatch) {
        throw new Error("COPC horizontal CRS declares invalid axis order");
      }
      const direction = section
        .match(/^AXIS\s*\[\s*"(?:""|[^"])*"\s*,\s*"?([A-Z]+)"?/i)?.[1]
        ?.toLowerCase();
      return {
        order: orderMatch ? Number(orderMatch[1]) : index + 1,
        direction,
      };
    })
    .sort((left, right) => left.order - right.order);
  if (
    orderedAxes.some((axis, index) => !Number.isSafeInteger(axis.order) || axis.order < 1 ||
      (index > 0 && axis.order === orderedAxes[index - 1].order))
  ) {
    throw new Error("COPC horizontal CRS declares invalid axis order");
  }
  const directions = orderedAxes.slice(0, 2).map(({ direction }) => direction);
  const supported = new Set(["east", "west", "north", "south"]);
  const [first, second] = directions;
  if (
    !first ||
    !second ||
    !supported.has(first) ||
    !supported.has(second)
  ) {
    throw new Error("COPC horizontal CRS declares an unsupported axis direction");
  }
  const horizontalDirections = [first, second] as HorizontalAxisDirections;
  if (
    horizontalDirections.filter((direction) => direction === "east" || direction === "west").length !== 1 ||
    horizontalDirections.filter((direction) => direction === "north" || direction === "south").length !== 1
  ) {
    throw new Error("COPC horizontal CRS axes must contain one east/west and one north/south direction");
  }
  return horizontalDirections;
}

export function extractHorizontalUnitScale(wkt: string): number {
  const horizontalWkt = findWktSectionWithOffset(wkt, "PROJCS[")
    ? extractHorizontalWkt(wkt)
    : extractHorizontalCrsWkt(wkt);
  const geographic = /^(?:GEOGCS|GEOGCRS)\s*\[/i.test(horizontalWkt);

  let depth = 0;
  let inString = false;

  for (let index = 0; index < horizontalWkt.length; index += 1) {
    const character = horizontalWkt[index];

    if (character === '"') {
      inString = !inString;
      continue;
    }

    if (inString) {
      continue;
    }

    if (character === "[") {
      depth += 1;
      continue;
    }

    if (character === "]") {
      depth -= 1;
      continue;
    }

    // Ignore nested units and read only the horizontal CRS's own unit.
    if (
      depth === 1 &&
      /^UNIT\s*\[/i.test(horizontalWkt.slice(index))
    ) {
      const unitText = horizontalWkt.slice(index);

      const match = unitText.match(
        /^UNIT\s*\[\s*"[^"]+"\s*,\s*([0-9.]+(?:e[+-]?\d+)?)/i,
      );

      if (!match) {
        if (geographic) {
          throw new Error("COPC geographic WKT has an invalid angular unit");
        }
        return 1;
      }

      const unitScale = Number(match[1]);
      if (!Number.isFinite(unitScale) || unitScale <= 0) {
        if (geographic) {
          throw new Error("COPC geographic WKT has an invalid angular unit");
        }
        return 1;
      }

      // A single scalar is used by the renderer-neutral LoD estimates. For
      // angular coordinates, use a conservative metres-per-radian upper
      // bound (the polar meridional radius) rather than interpreting degrees
      // as metres. This is intentionally an estimate, not a local projection.
      return geographic ? unitScale * 6_400_000 : unitScale;
    }
  }

  if (/^GEOGCRS\s*\[/i.test(horizontalWkt)) {
    const angleUnit = findWktSection(horizontalWkt, "ANGLEUNIT[");
    const match = angleUnit?.match(
      /^ANGLEUNIT\s*\[\s*"[^"]+"\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)/i,
    );
    const unitScale = Number(match?.[1]);
    if (!Number.isFinite(unitScale) || unitScale <= 0) {
      throw new Error("COPC geographic WKT has an invalid angular unit");
    }
    return unitScale * 6_400_000;
  }

  if (geographic) {
    throw new Error("COPC geographic WKT does not declare an angular unit");
  }

  if (/^PROJCRS\s*\[/i.test(horizontalWkt)) {
    const axes = findDirectWktSections(horizontalWkt, ["AXIS["])
      .map(({ section }, index) => {
        const direction = section
          .match(/^AXIS\s*\[\s*"(?:""|[^"])*"\s*,\s*"?([A-Z]+)"?/i)?.[1]
          ?.toLowerCase();
        const orderSection = findDirectWktSections(section, ["ORDER["])[0]?.section;
        const order = Number(orderSection?.match(/^ORDER\s*\[\s*(\d+)\s*\]/i)?.[1] ?? index + 1);
        return { section, direction, order };
      })
      .sort((left, right) => left.order - right.order);
    const horizontalAxes = axes.filter(({ direction }) =>
      direction === "east" || direction === "west" || direction === "north" || direction === "south",
    );
    if (horizontalAxes.length !== 2) {
      throw new Error("COPC projected WKT2 must declare exactly two horizontal axes");
    }
    const axisUnits = horizontalAxes
      .map(({ section }) => findDirectWktSections(section, ["LENGTHUNIT["])[0]?.section);
    if (axisUnits.length === 0 || axisUnits.some((unit) => unit === undefined)) {
      throw new Error("COPC projected WKT2 does not declare a length unit for every axis");
    }
    const factors = axisUnits.map((unit) => parseLengthUnitFactor(unit!, "LENGTHUNIT"));
    if (factors.some((factor) => Math.abs(factor - factors[0]) > Math.max(1e-14, factors[0] * 1e-12))) {
      throw new Error("COPC projected WKT2 declares conflicting axis units");
    }
    return factors[0];
  }

  return 1;
}

export function extractVerticalUnitScale(wkt: string): number {
  return extractExplicitVerticalUnitScale(wkt) ?? 1;
}

export type VerticalCrsIdentity = {
  /** WKT name assigned to the vertical coordinate reference system. */
  name: string;
  /** Identifier attached directly to the vertical CRS, when present. */
  authority?: string;
  code?: string;
  /** Explicit direction of the vertical axis, when the WKT declares one. */
  axisDirection?: string;
  /** Whether this vertical CRS definition carries dynamic-frame metadata. */
  dynamic: boolean;
};

/** Identity and coordinate-system details from the root of a WKT2 CRS. */
export type RootCrsIdentity = {
  type: string;
  name: string;
  authority?: string;
  code?: string;
  coordinateSystemType?: string;
  coordinateSystemDimension?: number;
  axisDirections: string[];
};

/** True only for an explicitly identified, three-dimensional ellipsoidal WGS 84 CRS. */
export function isWgs84Geographic3dCrs(
  identity: RootCrsIdentity | undefined,
): boolean {
  return (
    identity?.type === "GEOGCRS" &&
    identity.authority?.toUpperCase() === "EPSG" &&
    identity.code === "4979" &&
    identity.coordinateSystemType === "ellipsoidal" &&
    identity.coordinateSystemDimension === 3 &&
    identity.axisDirections.length === 3 &&
    identity.axisDirections.includes("UP")
  );
}

function findWktSectionStart(
  source: string,
  index: number,
  keyword: string,
): number | undefined {
  const name = keyword.endsWith("[") ? keyword.slice(0, -1) : keyword;
  if (index > 0 && /[A-Z0-9_]/i.test(source[index - 1])) {
    return undefined;
  }
  if (
    source.slice(index, index + name.length).toUpperCase() !==
    name.toUpperCase()
  ) {
    return undefined;
  }

  let bracket = index + name.length;
  while (/\s/.test(source[bracket] ?? "")) bracket += 1;
  return source[bracket] === "[" ? bracket : undefined;
}

function findWktSection(wkt: string, keyword: string): string | undefined {
  return findWktSectionWithOffset(wkt, keyword)?.section;
}

type WktSectionMatch = { start: number; section: string };

function findWktSectionWithOffset(
  wkt: string,
  keyword: string,
): WktSectionMatch | undefined {
  let inString = false;
  let start = -1;
  let openBracket = -1;
  const keywordName = keyword.endsWith("[") ? keyword.slice(0, -1) : keyword;
  for (let index = 0; index <= wkt.length - keywordName.length; index += 1) {
    const character = wkt[index];
    if (character === '"') {
      if (inString && wkt[index + 1] === '"') {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    const bracket = findWktSectionStart(wkt, index, keyword);
    if (bracket !== undefined) {
      start = index;
      openBracket = bracket;
      break;
    }
  }
  if (start < 0) return undefined;

  let depth = 0;
  inString = false;
  for (let index = openBracket; index < wkt.length; index += 1) {
    const character = wkt[index];
    if (character === '"') {
      if (inString && wkt[index + 1] === '"') {
        index += 1;
        continue;
      }
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (character === "[") depth += 1;
    else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return { start, section: wkt.slice(start, index + 1) };
      }
    }
  }
  throw new Error(`Failed to parse ${keyword.slice(0, -1)} from WKT`);
}

function findDirectWktSections(
  wktSection: string,
  keywords: readonly string[],
): Array<{ keyword: string; section: string }> {
  const matches: Array<{ keyword: string; section: string }> = [];
  let inString = false;
  let depth = 0;
  for (let index = 0; index < wktSection.length; index += 1) {
    const keyword = !inString && depth === 1
      ? keywords.find((candidate) =>
          findWktSectionStart(wktSection, index, candidate) !== undefined,
        )
      : undefined;
    if (keyword) {
      const section = findWktSection(wktSection.slice(index), keyword);
      if (!section) throw new Error(`Failed to parse direct ${keyword.slice(0, -1)} from WKT`);
      matches.push({ keyword, section });
      index += section.length - 1;
      continue;
    }

    const character = wktSection[index];
    if (character === '"') {
      if (inString && wktSection[index + 1] === '"') {
        index += 1;
        continue;
      }
      inString = !inString;
    } else if (!inString && character === "[") {
      depth += 1;
    } else if (!inString && character === "]") {
      depth -= 1;
    }
  }
  return matches;
}

/**
 * Read the vertical CRS identity without guessing from horizontal CRS or
 * country. This supports WKT1 `VERT_CS` and WKT2 `VERTCRS` sections.
 */
export function getVerticalCrsIdentity(
  wkt: string,
): VerticalCrsIdentity | undefined {
  const section = findWktSection(wkt, "VERT_CS[") ?? findWktSection(wkt, "VERTCRS[");
  if (!section) return undefined;
  const nameMatch = section.match(/^\s*(?:VERT_CS|VERTCRS)\s*\[\s*"((?:""|[^"])*)"/i);
  if (!nameMatch) {
    throw new Error("Vertical CRS WKT does not begin with a quoted name");
  }
  const identifiers = findDirectWktSections(section, ["AUTHORITY[", "ID["])
    .map(({ section: identifierSection }) =>
      identifierSection.match(
        /^(?:AUTHORITY|ID)\s*\[\s*"([^"]+)"\s*,\s*(?:"([^"]+)"|(\d+))/i,
      ),
    )
    .filter((match): match is RegExpMatchArray => match !== null);
  const identifier = identifiers.at(-1);
  const axes = findDirectWktSections(section, ["AXIS["]);
  const axisDirection = axes[0]?.section.match(
    /^AXIS\s*\[\s*"(?:""|[^"])*"\s*,\s*"?([A-Z]+)"?\s*(?:,|\])/i,
  )?.[1]?.toUpperCase();
  if (axes.length > 0 && !axisDirection) {
    throw new Error("Vertical CRS WKT has a malformed axis declaration");
  }
  return {
    name: nameMatch[1].replaceAll('""', '"'),
    ...(identifier
      ? {
          authority: identifier[1],
          code: identifier[2] ?? identifier[3],
        }
      : {}),
    ...(axisDirection ? { axisDirection } : {}),
    dynamic: /(?:^|,)\s*DYNAMIC\s*\[|FRAMEEPOCH\s*\[/i.test(section),
  };
}

/**
 * Read the root WKT2 CRS identity and its direct coordinate-system axes.
 * Nested datum and ellipsoid identifiers are deliberately excluded.
 */
export function getRootCrsIdentity(wkt: string): RootCrsIdentity | undefined {
  const rootMatch = /^\s*([A-Z][A-Z0-9_]*)\s*\[/i.exec(wkt);
  if (!rootMatch) return undefined;
  const type = rootMatch[1].toUpperCase();
  const rootStart = wkt.search(/\S/);
  const root = findWktSectionWithOffset(wkt, `${type}[`);
  if (!root || root.start !== rootStart) return undefined;

  const nameMatch = root.section.match(
    /^\s*[A-Z][A-Z0-9_]*\s*\[\s*"((?:""|[^"])*)"/i,
  );
  if (!nameMatch) {
    throw new Error("Root CRS WKT does not begin with a quoted name");
  }

  const directSections = findDirectWktSections(root.section, [
    "ID[",
    "AUTHORITY[",
    "CS[",
    "AXIS[",
  ]);
  const identifiers = directSections
    .filter(({ keyword }) => keyword === "ID[" || keyword === "AUTHORITY[")
    .map(({ section }) =>
      section.match(
        /^(?:ID|AUTHORITY)\s*\[\s*"([^"]+)"\s*,\s*(?:"([^"]+)"|(\d+))/i,
      ),
    )
    .filter((match): match is RegExpMatchArray => match !== null);
  const identifier = identifiers.at(-1);
  const coordinateSystem = directSections.find(({ keyword }) => keyword === "CS[")
    ?.section.match(
      /^CS\s*\[\s*"?([A-Z_]+)"?\s*,\s*(\d+)/i,
    );
  const axes = directSections
    .filter(({ keyword }) => keyword === "AXIS[")
    .map(({ section }) =>
      section.match(
        /^AXIS\s*\[\s*"(?:""|[^"])*"\s*,\s*"?([A-Z]+)"?\s*(?:,|\])/i,
      )?.[1]?.toUpperCase(),
    );
  if (axes.some((direction) => direction === undefined)) {
    throw new Error("Root CRS WKT has a malformed axis declaration");
  }

  return {
    type,
    name: nameMatch[1].replaceAll('""', '"'),
    ...(identifier
      ? {
          authority: identifier[1],
          code: identifier[2] ?? identifier[3],
        }
      : {}),
    ...(coordinateSystem
      ? {
          coordinateSystemType: coordinateSystem[1].toLowerCase(),
          coordinateSystemDimension: Number(coordinateSystem[2]),
        }
      : {}),
    axisDirections: axes.filter(
      (direction): direction is string => direction !== undefined,
    ),
  };
}

/**
 * Return the explicitly declared WKT1/WKT2 vertical unit scale in metres.
 *
 * The legacy `extractVerticalUnitScale` keeps its metre fallback for existing
 * rendering behavior. A requested datum conversion must use this strict
 * helper instead so an absent or malformed unit is never assumed to be metres.
 */
export function extractExplicitVerticalUnitScale(wkt: string): number | undefined {
  const wkt1 = findWktSection(wkt, "VERT_CS[");
  const section = wkt1 ?? findWktSection(wkt, "VERTCRS[");
  if (!section) return projectedUpAxisUnitScale(wkt);
  const unitKeyword = wkt1 ? "UNIT[" : "LENGTHUNIT[";
  const unitName = wkt1 ? "UNIT" : "LENGTHUNIT";
  const rootUnits = findDirectWktSections(section, [unitKeyword])
    .map(({ section: unit }) => parseLengthUnitFactor(unit, unitName));
  const axes = findDirectWktSections(section, ["AXIS["]);
  const axisUnits = axes.map(({ section: axis }) =>
    findDirectWktSections(axis, [unitKeyword])[0]?.section,
  );
  if (axisUnits.some((unit) => unit === undefined) && axisUnits.some((unit) => unit !== undefined)) {
    throw new Error("COPC vertical WKT must declare a unit for every axis");
  }
  const factors = [
    ...rootUnits,
    ...axisUnits.filter((unit): unit is string => unit !== undefined)
      .map((unit) => parseLengthUnitFactor(unit, unitName)),
  ];
  if (factors.length === 0) return undefined;
  if (factors.some((factor) => Math.abs(factor - factors[0]) > Math.max(1e-14, factors[0] * 1e-12))) {
    throw new Error("COPC vertical WKT declares conflicting units");
  }
  return factors[0];
}

function projectedUpAxisUnitScale(wkt: string): number | undefined {
  if (!findWktSection(wkt, "PROJCRS[")) return undefined;
  const projected = extractHorizontalCrsWkt(wkt);
  if (!/^PROJCRS\s*\[/i.test(projected)) return undefined;
  const direct = findDirectWktSections(projected, ["CS[", "AXIS["]);
  const coordinateSystem = direct.find(({ keyword }) => keyword === "CS[")?.section
    .match(/^CS\s*\[\s*"?([A-Z_]+)"?\s*,\s*(\d+)/i);
  const axes = direct.filter(({ keyword }) => keyword === "AXIS[")
    .map(({ section }, index) => {
      const direction = section
        .match(/^AXIS\s*\[\s*"(?:""|[^"])*"\s*,\s*"?([A-Z]+)"?/i)?.[1]
        ?.toUpperCase();
      const orderSection = findDirectWktSections(section, ["ORDER["])[0]?.section;
      const order = Number(orderSection?.match(/^ORDER\s*\[\s*(\d+)\s*\]/i)?.[1] ?? index + 1);
      return { section, direction, order };
    })
    .sort((left, right) => left.order - right.order);
  const eastWestDirections = ["EAST", "WEST"];
  const northSouthDirections = ["NORTH", "SOUTH"];
  const hasEastNorthOrder = eastWestDirections.includes(axes[0]?.direction ?? "") &&
    northSouthDirections.includes(axes[1]?.direction ?? "");
  const hasNorthEastOrder = northSouthDirections.includes(axes[0]?.direction ?? "") &&
    eastWestDirections.includes(axes[1]?.direction ?? "");
  const isCartesian3d = coordinateSystem?.[1].toLowerCase() === "cartesian" &&
    Number(coordinateSystem[2]) === 3 && axes.length === 3;
  if (isCartesian3d && axes.some((axis) => axis.direction === "DOWN")) {
    throw new Error(
      "COPC projected 3D WKT with a DOWN axis is unsupported because depth sign normalization is not available",
    );
  }
  if (
    !isCartesian3d ||
    axes[0]?.order !== 1 || axes[1]?.order !== 2 || (!hasEastNorthOrder && !hasNorthEastOrder) ||
    axes[2]?.order !== 3 || axes[2].direction !== "UP"
  ) return undefined;
  const unit = findDirectWktSections(axes[2].section, ["LENGTHUNIT["])[0]?.section;
  if (!unit) {
    throw new Error(
      "COPC projected 3D WKT UP axis does not declare a LENGTHUNIT",
    );
  }
  return parseLengthUnitFactor(unit, "LENGTHUNIT");
}

function parseLengthUnitFactor(unit: string, keyword: "UNIT" | "LENGTHUNIT"): number {
  const match = unit.match(
    new RegExp(`^${keyword}\\s*\\[\\s*"(?:""|[^"])*"\\s*,\\s*([+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)(?:e[+-]?\\d+)?)(?=\\s*(?:,|\\]))`, "i"),
  );
  if (!match) throw new Error("COPC WKT has an invalid linear unit declaration");
  const factor = Number(match[1]);
  if (!Number.isFinite(factor) || factor <= 0) {
    throw new Error("COPC WKT linear unit scale must be finite and positive");
  }
  return factor;
}

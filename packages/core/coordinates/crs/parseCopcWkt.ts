export function extractHorizontalWkt(wkt: string): string {
  const projected = findWktSectionWithOffset(wkt, "PROJCS[");
  if (!projected) {
    throw new Error("COPC WKT does not contain a projected horizontal CRS");
  }
  return projected.section;
}

/** Extract the horizontal WKT1 CRS, whether geographic or projected. */
export function extractHorizontalCrsWkt(wkt: string): string {
  const horizontal = [
    findWktSectionWithOffset(wkt, "PROJCS["),
    findWktSectionWithOffset(wkt, "GEOGCS["),
  ]
    .filter((match): match is WktSectionMatch => match !== undefined)
    .sort((left, right) => left.start - right.start)[0];
  if (!horizontal) {
    throw new Error("COPC WKT does not contain a supported horizontal CRS");
  }
  return horizontal.section;
}

export function extractHorizontalUnitScale(wkt: string): number {
  const horizontalWkt = findWktSectionWithOffset(wkt, "PROJCS[")
    ? extractHorizontalWkt(wkt)
    : extractHorizontalCrsWkt(wkt);
  const geographic = /^GEOGCS\s*\[/i.test(horizontalWkt);

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

  if (geographic) {
    throw new Error("COPC geographic WKT does not declare an angular unit");
  }

  return 1;
}

export function extractVerticalUnitScale(wkt: string): number {
  const match = wkt.match(
    /VERT_CS\[[\s\S]*?UNIT\["[^"]+",([0-9.]+(?:e-?\d+)?)(?:,AUTHORITY|\])/i,
  );

  if (!match) {
    return 1;
  }

  return Number(match[1]);
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
 * Return the explicitly declared WKT1 vertical unit scale in metres.
 *
 * The legacy `extractVerticalUnitScale` keeps its metre fallback for existing
 * rendering behavior. A requested datum conversion must use this strict
 * helper instead so an absent or malformed unit is never assumed to be metres.
 */
export function extractExplicitVerticalUnitScale(wkt: string): number | undefined {
  const section = findWktSection(wkt, "VERT_CS[");
  if (!section) return undefined;
  const unit = findDirectWktSections(section, ["UNIT["])[0]?.section;
  if (!unit) return undefined;
  const match = unit.match(
    /^UNIT\s*\[\s*"[^"]+"\s*,\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(?=\s*(?:,|\]))/i,
  );
  if (!match) throw new Error("COPC vertical WKT has an invalid unit");
  const scale = Number(match[1]);
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new Error("COPC vertical WKT unit scale must be finite and positive");
  }
  return scale;
}

export function extractHorizontalWkt(wkt: string): string {
  const start = wkt.indexOf("PROJCS[");

  if (start === -1) {
    throw new Error("COPC WKT does not contain a projected horizontal CRS");
  }

  let depth = 0;

  for (let index = start; index < wkt.length; index += 1) {
    const character = wkt[index];

    if (character === "[") {
      depth += 1;
    }

    if (character === "]") {
      depth -= 1;

      if (depth === 0) {
        return wkt.slice(start, index + 1);
      }
    }
  }

  throw new Error("Failed to parse projected CRS from COPC WKT");
}

/** Extract the horizontal WKT1 CRS, whether geographic or projected. */
export function extractHorizontalCrsWkt(wkt: string): string {
  const startTokens = ["PROJCS[", "GEOGCS["];
  const starts = startTokens
    .map((token) => ({ token, index: wkt.indexOf(token) }))
    .filter((entry) => entry.index >= 0)
    .sort((left, right) => left.index - right.index);
  const start = starts[0];
  if (!start) {
    throw new Error("COPC WKT does not contain a supported horizontal CRS");
  }

  let depth = 0;
  let inString = false;
  for (let index = start.index; index < wkt.length; index += 1) {
    const character = wkt[index];
    if (character === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) {
        return wkt.slice(start.index, index + 1);
      }
    }
  }

  throw new Error("Failed to parse horizontal CRS from COPC WKT");
}

export function extractHorizontalUnitScale(wkt: string): number {
  const horizontalWkt = wkt.includes("PROJCS[")
    ? extractHorizontalWkt(wkt)
    : extractHorizontalCrsWkt(wkt);
  const geographic = horizontalWkt.startsWith("GEOGCS[");

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
      horizontalWkt.slice(index).toUpperCase().startsWith("UNIT[")
    ) {
      const unitText = horizontalWkt.slice(index);

      const match = unitText.match(
        /^UNIT\["[^"]+",\s*([0-9.]+(?:e[+-]?\d+)?)/i,
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

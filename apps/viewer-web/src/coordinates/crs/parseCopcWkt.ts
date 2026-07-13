export function extractHorizontalWkt(wkt: string): string {
  const start = wkt.indexOf('PROJCS[');

  if (start === -1) {
    throw new Error('COPC WKT does not contain a projected horizontal CRS');
  }

  let depth = 0;

  for (let index = start; index < wkt.length; index += 1) {
    const character = wkt[index];

    if (character === '[') {
      depth += 1;
    }

    if (character === ']') {
      depth -= 1;

      if (depth === 0) {
        return wkt.slice(start, index + 1);
      }
    }
  }

  throw new Error('Failed to parse projected CRS from COPC WKT');
}

export function extractHorizontalUnitScale(wkt: string): number {
  const horizontalWkt = extractHorizontalWkt(wkt);
  const match = horizontalWkt.match(
    /UNIT\["[^"]+",([0-9.]+(?:e-?\d+)?)(?:,AUTHORITY|\])/i,
  );

  if (!match) {
    return 1;
  }

  return Number(match[1]);
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

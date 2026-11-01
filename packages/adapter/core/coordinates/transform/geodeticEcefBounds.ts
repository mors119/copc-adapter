import type { Wgs84EcefBounds } from "../types";

/** Axis-aligned WGS 84 geodetic region; longitude/latitude use degrees. */
export type Wgs84GeodeticRegion = Readonly<{
  minimumLongitudeDegrees: number;
  maximumLongitudeDegrees: number;
  minimumLatitudeDegrees: number;
  maximumLatitudeDegrees: number;
  minimumEllipsoidalHeightMeters: number;
  maximumEllipsoidalHeightMeters: number;
}>;

/** Vertical-grid extrema and a derived IEEE-754 interpolation error bound. */
export type VerticalCorrectionInterval = Readonly<{
  minimumMeters: number;
  maximumMeters: number;
  numericalErrorBoundMeters: number;
}>;

type Interval = Readonly<{ minimum: number; maximum: number }>;

const NEXT_FLOAT_BUFFER = new ArrayBuffer(8);
const NEXT_FLOAT_VIEW = new DataView(NEXT_FLOAT_BUFFER);
const WGS84_SEMI_MAJOR_AXIS_METERS = 6_378_137;
const WGS84_FIRST_ECCENTRICITY_SQUARED = 6.6943799901413165e-3;
const PI_INTERVAL: Interval = {
  minimum: nextDown(Math.PI),
  maximum: nextUp(Math.PI),
};

function nextUp(value: number): number {
  if (Number.isNaN(value) || value === Number.POSITIVE_INFINITY) return value;
  if (value === 0) return Number.MIN_VALUE;
  NEXT_FLOAT_VIEW.setFloat64(0, value, false);
  const bits = NEXT_FLOAT_VIEW.getBigUint64(0, false);
  NEXT_FLOAT_VIEW.setBigUint64(0, value > 0 ? bits + 1n : bits - 1n, false);
  return NEXT_FLOAT_VIEW.getFloat64(0, false);
}

function nextDown(value: number): number {
  if (Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return value;
  if (value === 0) return -Number.MIN_VALUE;
  NEXT_FLOAT_VIEW.setFloat64(0, value, false);
  const bits = NEXT_FLOAT_VIEW.getBigUint64(0, false);
  NEXT_FLOAT_VIEW.setBigUint64(0, value > 0 ? bits - 1n : bits + 1n, false);
  return NEXT_FLOAT_VIEW.getFloat64(0, false);
}

function point(value: number): Interval {
  if (!Number.isFinite(value)) throw new RangeError("Interval input must be finite");
  return { minimum: value, maximum: value };
}

function add(left: Interval, right: Interval): Interval {
  return {
    minimum: nextDown(left.minimum + right.minimum),
    maximum: nextUp(left.maximum + right.maximum),
  };
}

function negate(value: Interval): Interval {
  return { minimum: -value.maximum, maximum: -value.minimum };
}

function subtract(left: Interval, right: Interval): Interval {
  return add(left, negate(right));
}

function multiply(left: Interval, right: Interval): Interval {
  const products = [
    left.minimum * right.minimum,
    left.minimum * right.maximum,
    left.maximum * right.minimum,
    left.maximum * right.maximum,
  ];
  return {
    minimum: nextDown(Math.min(...products)),
    maximum: nextUp(Math.max(...products)),
  };
}

function divide(numerator: Interval, denominator: Interval): Interval {
  if (denominator.minimum <= 0 && denominator.maximum >= 0) {
    throw new RangeError("Interval division by a range containing zero");
  }
  const reciprocal: Interval = {
    minimum: nextDown(1 / denominator.maximum),
    maximum: nextUp(1 / denominator.minimum),
  };
  return multiply(numerator, reciprocal);
}

function square(value: Interval): Interval {
  const maximumAbsolute = Math.max(Math.abs(value.minimum), Math.abs(value.maximum));
  const maximum = nextUp(maximumAbsolute * maximumAbsolute);
  if (value.minimum <= 0 && value.maximum >= 0) {
    return { minimum: 0, maximum };
  }
  const minimumAbsolute = Math.min(Math.abs(value.minimum), Math.abs(value.maximum));
  return {
    minimum: Math.max(0, nextDown(minimumAbsolute * minimumAbsolute)),
    maximum,
  };
}

type PositiveBinaryParts = Readonly<{ significand: bigint; exponent: number }>;

function positiveBinaryParts(value: number): PositiveBinaryParts {
  NEXT_FLOAT_VIEW.setFloat64(0, value, false);
  const bits = NEXT_FLOAT_VIEW.getBigUint64(0, false);
  const exponentBits = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & 0x000f_ffff_ffff_ffffn;
  if (exponentBits === 0) return { significand: fraction, exponent: -1074 };
  return {
    significand: (1n << 52n) | fraction,
    exponent: exponentBits - 1023 - 52,
  };
}

/** Compare the exact real square of a non-negative double with another double. */
function compareExactSquare(left: number, right: number): -1 | 0 | 1 {
  const leftParts = positiveBinaryParts(left);
  const rightParts = positiveBinaryParts(right);
  const leftSignificand = leftParts.significand * leftParts.significand;
  const leftExponent = leftParts.exponent * 2;
  if (leftExponent >= rightParts.exponent) {
    const scaledLeft = leftSignificand << BigInt(leftExponent - rightParts.exponent);
    return scaledLeft < rightParts.significand ? -1 : scaledLeft > rightParts.significand ? 1 : 0;
  }
  const scaledRight = rightParts.significand << BigInt(rightParts.exponent - leftExponent);
  return leftSignificand < scaledRight ? -1 : leftSignificand > scaledRight ? 1 : 0;
}

function numberFromPositiveBits(bits: bigint): number {
  NEXT_FLOAT_VIEW.setBigUint64(0, bits, false);
  return NEXT_FLOAT_VIEW.getFloat64(0, false);
}

function floorSquareRootBySearch(value: number): number {
  let lowerBits = 0n;
  let upperBits = 0x7fef_ffff_ffff_ffffn;
  while (lowerBits < upperBits) {
    const middleBits = lowerBits + ((upperBits - lowerBits + 1n) >> 1n);
    const candidate = numberFromPositiveBits(middleBits);
    if (compareExactSquare(candidate, value) <= 0) lowerBits = middleBits;
    else upperBits = middleBits - 1n;
  }
  return numberFromPositiveBits(lowerBits);
}

/** Return the greatest binary64 value whose exact square does not exceed value. */
function floorSquareRoot(value: number): number {
  if (value === 0) return 0;
  const approximation = Math.sqrt(value);
  if (Number.isFinite(approximation) && approximation >= 0) {
    const comparison = compareExactSquare(approximation, value);
    if (comparison <= 0) {
      const next = nextUp(approximation);
      if (compareExactSquare(next, value) > 0) return approximation;
    } else {
      const previous = nextDown(approximation);
      if (previous >= 0 && compareExactSquare(previous, value) <= 0) return previous;
    }
  }
  // ECMAScript only specifies Math.sqrt as an implementation approximation.
  // The integer search is an exact fallback if it is more than one adjacent
  // representable number from the correct enclosure.
  return floorSquareRootBySearch(value);
}

function squareRoot(value: Interval): Interval {
  if (value.minimum < 0) throw new RangeError("Square root interval is negative");
  const minimum = floorSquareRoot(value.minimum);
  const maximumFloor = floorSquareRoot(value.maximum);
  return {
    minimum,
    maximum: compareExactSquare(maximumFloor, value.maximum) === 0
      ? maximumFloor
      : nextUp(maximumFloor),
  };
}

function scale(value: Interval, scalar: number): Interval {
  return multiply(value, point(scalar));
}

function absoluteMaximum(value: Interval): number {
  return Math.max(Math.abs(value.minimum), Math.abs(value.maximum));
}

function taylorRemainder(maximumAbsolute: number, degree: number): number {
  let bound = 1;
  for (let power = 0; power < degree; power += 1) {
    bound = nextUp(bound * maximumAbsolute);
  }
  for (let divisor = 2; divisor <= degree; divisor += 1) {
    bound = nextUp(bound / divisor);
  }
  return bound;
}

function reducedSineCosine(value: Interval): readonly [Interval, Interval] {
  const center = value.minimum + (value.maximum - value.minimum) / 2;
  const quarterTurn = Math.PI / 2;
  const turns = Math.round(center / quarterTurn);
  const halfPi = scale(PI_INTERVAL, 0.5);
  const reduced = subtract(value, scale(halfPi, turns));
  const largestArgument = absoluteMaximum(reduced);
  if (largestArgument > 1) {
    throw new RangeError("Certified trigonometric reduction exceeded its interval");
  }

  const squared = square(reduced);
  let sineTerm = reduced;
  let sine = reduced;
  let cosineTerm = point(1);
  let cosine = point(1);
  for (let index = 0; index < 13; index += 1) {
    sineTerm = negate(
      divide(
        multiply(sineTerm, squared),
        point((2 * index + 2) * (2 * index + 3)),
      ),
    );
    sine = add(sine, sineTerm);

    cosineTerm = negate(
      divide(
        multiply(cosineTerm, squared),
        point((2 * index + 1) * (2 * index + 2)),
      ),
    );
    cosine = add(cosine, cosineTerm);
  }

  const sineError = taylorRemainder(largestArgument, 28);
  const cosineError = taylorRemainder(largestArgument, 27);
  sine = add(sine, { minimum: -sineError, maximum: sineError });
  cosine = add(cosine, { minimum: -cosineError, maximum: cosineError });

  switch (((turns % 4) + 4) % 4) {
    case 0:
      return [sine, cosine];
    case 1:
      return [cosine, negate(sine)];
    case 2:
      return [negate(sine), negate(cosine)];
    default:
      return [negate(cosine), sine];
  }
}

function radiansForDegrees(degrees: number): Interval {
  return divide(multiply(point(degrees), PI_INTERVAL), point(180));
}

function includesCritical(
  minimumRadians: number,
  maximumRadians: number,
  critical: Interval,
): boolean {
  return critical.maximum >= minimumRadians && critical.minimum <= maximumRadians;
}

function sineRange(minimumDegrees: number, maximumDegrees: number): Interval {
  if (maximumDegrees - minimumDegrees >= 360) {
    return { minimum: -1, maximum: 1 };
  }
  const minimumRadians = radiansForDegrees(minimumDegrees);
  const maximumRadians = radiansForDegrees(maximumDegrees);
  const [minimumSine] = reducedSineCosine(minimumRadians);
  const [maximumSine] = reducedSineCosine(maximumRadians);
  let minimum = Math.min(minimumSine.minimum, maximumSine.minimum);
  let maximum = Math.max(minimumSine.maximum, maximumSine.maximum);
  const halfPi = scale(PI_INTERVAL, 0.5);
  for (let index = -4; index <= 4; index += 1) {
    const critical = scale(halfPi, 2 * index + 1);
    if (!includesCritical(minimumRadians.minimum, maximumRadians.maximum, critical)) continue;
    if (index % 2 === 0) maximum = 1;
    else minimum = -1;
  }
  return {
    minimum: Math.min(1, Math.max(-1, nextDown(minimum))),
    maximum: Math.max(-1, Math.min(1, nextUp(maximum))),
  };
}

function cosineRange(minimumDegrees: number, maximumDegrees: number): Interval {
  if (maximumDegrees - minimumDegrees >= 360) {
    return { minimum: -1, maximum: 1 };
  }
  const minimumRadians = radiansForDegrees(minimumDegrees);
  const maximumRadians = radiansForDegrees(maximumDegrees);
  const [, minimumCosine] = reducedSineCosine(minimumRadians);
  const [, maximumCosine] = reducedSineCosine(maximumRadians);
  let minimum = Math.min(minimumCosine.minimum, maximumCosine.minimum);
  let maximum = Math.max(minimumCosine.maximum, maximumCosine.maximum);
  const piInterval = PI_INTERVAL;
  for (let index = -2; index <= 2; index += 1) {
    const critical = scale(piInterval, index);
    if (!includesCritical(minimumRadians.minimum, maximumRadians.maximum, critical)) continue;
    if (index % 2 === 0) maximum = 1;
    else minimum = -1;
  }
  return {
    minimum: Math.min(1, Math.max(-1, nextDown(minimum))),
    maximum: Math.max(-1, Math.min(1, nextUp(maximum))),
  };
}

function boundedLinearHeight(
  minimumSourceHeight: number,
  maximumSourceHeight: number,
  sourceUnitToMeters: number,
  heightOffsetMeters: number,
  verticalCorrection?: VerticalCorrectionInterval,
): Interval {
  if (
    ![
      minimumSourceHeight,
      maximumSourceHeight,
      sourceUnitToMeters,
      heightOffsetMeters,
      ...(verticalCorrection
        ? [
            verticalCorrection.minimumMeters,
            verticalCorrection.maximumMeters,
            verticalCorrection.numericalErrorBoundMeters,
          ]
        : []),
    ].every(Number.isFinite) ||
    minimumSourceHeight > maximumSourceHeight ||
    sourceUnitToMeters <= 0 ||
    (verticalCorrection &&
      (verticalCorrection.minimumMeters > verticalCorrection.maximumMeters ||
        verticalCorrection.numericalErrorBoundMeters < 0))
  ) {
    throw new RangeError("Vertical transform bounds are invalid");
  }
  let result = multiply(
    { minimum: minimumSourceHeight, maximum: maximumSourceHeight },
    point(sourceUnitToMeters),
  );
  if (verticalCorrection) {
    result = add(result, {
      minimum: nextDown(
        verticalCorrection.minimumMeters - verticalCorrection.numericalErrorBoundMeters,
      ),
      maximum: nextUp(
        verticalCorrection.maximumMeters + verticalCorrection.numericalErrorBoundMeters,
      ),
    });
  }
  return add(result, point(heightOffsetMeters));
}

/**
 * Bound the source Z conversion, optional bilinear-grid correction, and
 * uniform ellipsoidal-height offset with outward interval arithmetic.
 */
export function getWgs84EllipsoidalHeightBounds(
  minimumSourceHeight: number,
  maximumSourceHeight: number,
  sourceUnitToMeters: number,
  heightOffsetMeters: number,
  verticalCorrection?: VerticalCorrectionInterval,
): Readonly<{ minimum: number; maximum: number }> {
  return Object.freeze(
    boundedLinearHeight(
      minimumSourceHeight,
      maximumSourceHeight,
      sourceUnitToMeters,
      heightOffsetMeters,
      verticalCorrection,
    ),
  );
}

/**
 * Derive a conservative error allowance for the four weighted bilinear
 * samples, their products, and sequential sum. `operationCount` uses 32
 * rounded operations, exceeding the sampler's actual product/sum path.
 */
export function getBilinearInterpolationErrorBoundMeters(
  minimumValueMeters: number,
  maximumValueMeters: number,
): number {
  if (
    !Number.isFinite(minimumValueMeters) ||
    !Number.isFinite(maximumValueMeters) ||
    minimumValueMeters > maximumValueMeters
  ) {
    throw new RangeError("Vertical-grid extrema are invalid");
  }
  const unitRoundoff = Number.EPSILON / 2;
  const operationCount = 32;
  const gammaNumerator = nextUp(operationCount * unitRoundoff);
  const gammaDenominator = nextDown(1 - operationCount * unitRoundoff);
  const gamma = nextUp(gammaNumerator / gammaDenominator);
  const bound = nextUp(gamma * Math.max(Math.abs(minimumValueMeters), Math.abs(maximumValueMeters)));
  return Number.isFinite(bound) ? bound : Number.POSITIVE_INFINITY;
}

function validateRegion(region: Wgs84GeodeticRegion): void {
  const values = [
    region.minimumLongitudeDegrees,
    region.maximumLongitudeDegrees,
    region.minimumLatitudeDegrees,
    region.maximumLatitudeDegrees,
    region.minimumEllipsoidalHeightMeters,
    region.maximumEllipsoidalHeightMeters,
  ];
  if (!values.every(Number.isFinite)) {
    throw new RangeError("WGS 84 geodetic bounds must be finite");
  }
  if (
    region.minimumLongitudeDegrees > region.maximumLongitudeDegrees ||
    region.minimumLatitudeDegrees > region.maximumLatitudeDegrees ||
    region.minimumEllipsoidalHeightMeters > region.maximumEllipsoidalHeightMeters
  ) {
    throw new RangeError("WGS 84 geodetic bounds have reversed axes");
  }
  if (
    region.minimumLongitudeDegrees < -360 ||
    region.maximumLongitudeDegrees > 360 ||
    region.minimumLatitudeDegrees < -90 ||
    region.maximumLatitudeDegrees > 90
  ) {
    throw new RangeError("Geographic cell is outside the supported angular domain");
  }
}

/**
 * Enclose a WGS 84 longitude/latitude/ellipsoidal-height box in ECEF metres.
 *
 * The derivation evaluates the geodetic ECEF equations with outward-rounded
 * interval arithmetic. Trigonometric endpoints use range reduction and Taylor
 * remainders; exact sine/cosine extrema are included when the interval crosses
 * them. Interval products intentionally retain dependency overestimation so
 * the result encloses all interior and boundary points, not just corners.
 */
export function getWgs84GeodeticEcefBounds(
  region: Wgs84GeodeticRegion,
): Readonly<Wgs84EcefBounds> {
  validateRegion(region);
  const sineLatitude = sineRange(
    region.minimumLatitudeDegrees,
    region.maximumLatitudeDegrees,
  );
  const cosineLatitude = cosineRange(
    region.minimumLatitudeDegrees,
    region.maximumLatitudeDegrees,
  );
  const sineLongitude = sineRange(
    region.minimumLongitudeDegrees,
    region.maximumLongitudeDegrees,
  );
  const cosineLongitude = cosineRange(
    region.minimumLongitudeDegrees,
    region.maximumLongitudeDegrees,
  );
  const sineLatitudeSquared = square(sineLatitude);
  const eccentricitySquared: Interval = {
    minimum: nextDown(WGS84_FIRST_ECCENTRICITY_SQUARED),
    maximum: nextUp(WGS84_FIRST_ECCENTRICITY_SQUARED),
  };
  const oneMinusEccentricity = subtract(point(1), eccentricitySquared);
  const primeVerticalDenominator = subtract(
    point(1),
    multiply(eccentricitySquared, sineLatitudeSquared),
  );
  const primeVerticalRadius = divide(
    point(WGS84_SEMI_MAJOR_AXIS_METERS),
    squareRoot(primeVerticalDenominator),
  );
  const height: Interval = {
    minimum: region.minimumEllipsoidalHeightMeters,
    maximum: region.maximumEllipsoidalHeightMeters,
  };
  const horizontalRadius = add(primeVerticalRadius, height);
  const polarRadius = add(
    multiply(primeVerticalRadius, oneMinusEccentricity),
    height,
  );
  const x = multiply(multiply(horizontalRadius, cosineLatitude), cosineLongitude);
  const y = multiply(multiply(horizontalRadius, cosineLatitude), sineLongitude);
  const z = multiply(polarRadius, sineLatitude);
  const values = [x.minimum, x.maximum, y.minimum, y.maximum, z.minimum, z.maximum];
  if (!values.every(Number.isFinite)) {
    throw new RangeError("ECEF interval exceeded the finite numeric range");
  }
  return Object.freeze({
    coordinateSystem: "wgs84-ecef-meters",
    minX: x.minimum,
    minY: y.minimum,
    minZ: z.minimum,
    maxX: x.maximum,
    maxY: y.maximum,
    maxZ: z.maximum,
  });
}

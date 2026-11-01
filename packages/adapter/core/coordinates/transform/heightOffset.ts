/** Resolve and validate a caller-supplied ellipsoidal height offset. */
export function resolveHeightOffsetMeters(value: number | undefined): number {
  const offset = value ?? 0;
  if (!Number.isFinite(offset)) {
    throw new RangeError("heightOffsetMeters must be a finite number");
  }
  return offset;
}

/** Standard LAS 1.4-R14 classes for point data record formats 6–10. */
export const LAS_1_4_CLASSIFICATION_CATALOG = [
  { code: 0, label: "Created, never classified" },
  { code: 1, label: "Unclassified" },
  { code: 2, label: "Ground" },
  { code: 3, label: "Low vegetation" },
  { code: 4, label: "Medium vegetation" },
  { code: 5, label: "High vegetation" },
  { code: 6, label: "Building" },
  { code: 7, label: "Low point (noise)" },
  { code: 8, label: "Reserved" },
  { code: 9, label: "Water" },
  { code: 10, label: "Rail" },
  { code: 11, label: "Road surface" },
  { code: 12, label: "Reserved" },
  { code: 13, label: "Wire – guard (shield)" },
  { code: 14, label: "Wire – conductor (phase)" },
  { code: 15, label: "Transmission tower" },
  { code: 16, label: "Wire-structure connector" },
  { code: 17, label: "Bridge deck" },
  { code: 18, label: "High noise" },
] as const;

/** Add a known catalog code without removing manually entered numeric codes. */
export function appendClassificationCode(
  value: string,
  code: number,
): string {
  const entries = value.trim().split(/[\s,]+/u).filter(Boolean);
  if (!entries.includes(String(code))) entries.push(String(code));
  return entries.join(", ");
}

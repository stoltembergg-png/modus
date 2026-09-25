/**
 * Compact token magnitude for timeline chrome: exact below 1000, then one
 * decimal with a k/M suffix (trailing `.0` dropped). A real `0` renders as "0";
 * negative / non-finite input has no value. Locale-free on purpose so the label
 * is deterministic across machines and test runs.
 */
export function formatTokenCount(value: number): string {
  if (!Number.isFinite(value) || value < 0) {
    return "";
  }
  if (value < 1000) {
    return String(Math.round(value));
  }
  const units: Array<{ size: number; suffix: string }> = [
    { size: 1_000_000_000, suffix: "B" },
    { size: 1_000_000, suffix: "M" },
    { size: 1_000, suffix: "k" },
  ];
  for (const { size, suffix } of units) {
    if (value < size) {
      continue;
    }
    const scaled = value / size;
    const text = scaled >= 100 ? String(Math.round(scaled)) : scaled.toFixed(1).replace(/\.0$/, "");
    return `${text}${suffix}`;
  }
  return String(Math.round(value));
}

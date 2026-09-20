// A design value is declared once in styles.css; where JS needs it as a number
// it is read from there rather than copied, so a width or duration has one source.

export function cssNumber(name: string, fallback: number): number {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name);
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : fallback;
}

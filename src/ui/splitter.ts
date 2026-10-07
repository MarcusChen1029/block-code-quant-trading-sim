/**
 * Pure geometry of the draggable splitter between the strategy pane (left) and the chart pane (right). The left
 * width is kept as a fraction of the layout width, so it adapts to window resizes; it is clamped in pixels so
 * neither pane gets unusably small.
 */
export const SPLIT = {
  /** Default left width on wide screens. */
  defaultFraction: 0.45,
  /** Smallest left pane (the Blockly toolbox + some workspace). */
  minLeftPx: 320,
  /** Smallest right pane (chart + stats). */
  minRightPx: 420,
  /** Arrow-key step, and with Shift / PageUp / PageDown. */
  step: 0.02,
  bigStep: 0.1,
};

export interface FractionRange {
  min: number;
  max: number;
}

/** Allowed fractions for a layout `widthPx` wide; on a layout too small for both minimums it stays near the middle. */
export function fractionRange(widthPx: number): FractionRange {
  if (!(widthPx > 0)) return { min: SPLIT.defaultFraction, max: SPLIT.defaultFraction };
  const min = SPLIT.minLeftPx / widthPx;
  const max = 1 - SPLIT.minRightPx / widthPx;
  if (min > max) return { min: 0.5, max: 0.5 };
  return { min, max };
}

export function clampFraction(fraction: number, widthPx: number): number {
  const { min, max } = fractionRange(widthPx);
  const f = Number.isFinite(fraction) ? fraction : SPLIT.defaultFraction;
  return Math.min(max, Math.max(min, f));
}

/** Fraction for a pointer at `clientX` over a layout starting at `leftPx`, `widthPx` wide. */
export function fractionFromPointer(clientX: number, leftPx: number, widthPx: number): number {
  return clampFraction(widthPx > 0 ? (clientX - leftPx) / widthPx : SPLIT.defaultFraction, widthPx);
}

/** New fraction for a key press on the splitter, or null when the key does not resize. */
export function fractionForKey(fraction: number, key: string, shift: boolean, widthPx: number): number | null {
  const step = shift ? SPLIT.bigStep : SPLIT.step;
  const { min, max } = fractionRange(widthPx);
  switch (key) {
    case 'ArrowLeft': return clampFraction(fraction - step, widthPx);
    case 'ArrowRight': return clampFraction(fraction + step, widthPx);
    case 'PageUp': return clampFraction(fraction - SPLIT.bigStep, widthPx);
    case 'PageDown': return clampFraction(fraction + SPLIT.bigStep, widthPx);
    case 'Home': return min;
    case 'End': return max;
    case 'Enter': return clampFraction(SPLIT.defaultFraction, widthPx);
    default: return null;
  }
}

/** A stored fraction, or null when absent / not a number strictly between 0 and 1. */
export function parseStoredFraction(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) && n > 0 && n < 1 ? n : null;
}

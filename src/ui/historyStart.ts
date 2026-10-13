/**
 * When the prices begin later than the start date that was asked for (a coin that started trading recently, or
 * limited data), a plain note saying where the test really started; null when the data covers the start date.
 * `firstCandleMs`: open time of the first candle loaded; `timeframeMs`: one candle's length.
 */
export function laterStartNote(requestedStartMs: number, firstCandleMs: number | undefined, timeframeMs: number): string | null {
  if (firstCandleMs === undefined || firstCandleMs - requestedStartMs <= timeframeMs) return null;
  const day = new Date(firstCandleMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });
  return `Prices only go back to ${day}, so the test started there. Any start date before that gives the same result.`;
}

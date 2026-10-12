/** A chart's visible logical range (bar indexes, fractional). */
export interface LogicalRange {
  from: number;
  to: number;
}

export type RangeChoice = { kind: 'fit' } | { kind: 'range'; from: number; to: number };

/** How close (in bars) an edge must be to count as "at the first / latest bar". */
const SLACK = 0.5;

/** First index whose time is >= `time` (times ascending); times.length when none. */
function lowerBound(times: readonly number[], time: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] < time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const clampIndex = (i: number, n: number) => Math.min(n - 1, Math.max(0, i));

/** True when `range` shows every bar of `times` (a fitted view). */
function showsAll(times: readonly number[], range: LogicalRange): boolean {
  return range.from <= SLACK && range.to >= times.length - 1 - SLACK;
}

function following(times: readonly number[], range: LogicalRange): boolean {
  return range.to >= times.length - 1 - SLACK;
}

/**
 * What to show after the chart's bars changed from `before` to `after` (open times, ascending) while the user
 * looked at `range`. Pure.
 * - every bar was visible -> fit again (also covers the initial catch-up, which keeps adding history);
 * - the latest bar was visible -> keep following it: same width, same margin on the right;
 * - otherwise -> the same bars stay in view: anchored on the open time of the first visible bar, so bars
 *   inserted before it (a gap fill) do not shift the view.
 */
export function preserveRange(before: readonly number[], range: LogicalRange | null, after: readonly number[]): RangeChoice {
  if (range === null || before.length === 0 || after.length === 0) return { kind: 'fit' };
  if (showsAll(before, range)) return { kind: 'fit' };
  if (following(before, range)) {
    const shift = after.length - before.length;
    return { kind: 'range', from: range.from + shift, to: range.to + shift };
  }
  const anchor = clampIndex(Math.floor(range.from), before.length);
  const moved = clampIndex(lowerBound(after, before[anchor]), after.length);
  const shift = moved - anchor;
  return { kind: 'range', from: range.from + shift, to: range.to + shift };
}

/** A view stored by bar times, so it survives a reload (bar indexes do not). */
export interface SavedView {
  following: boolean;
  fromTime: number;
  toTime: number;
  /** to - from, in bars. */
  width: number;
  /** to - last bar index (following views keep their right margin). */
  rightOffset: number;
}

/** The view to store for `range`, or null for a fitted view (fitting is the default anyway). Pure. */
export function saveView(times: readonly number[], range: LogicalRange | null): SavedView | null {
  if (range === null || times.length === 0 || showsAll(times, range)) return null;
  const last = times.length - 1;
  return {
    following: following(times, range),
    fromTime: times[clampIndex(Math.floor(range.from), times.length)],
    toTime: times[clampIndex(Math.ceil(range.to), times.length)],
    width: range.to - range.from,
    rightOffset: range.to - last,
  };
}

/**
 * The range for a saved view over `times`, or null while it cannot be placed yet (a view of older bars waits
 * until history reaches its last bar). Pure.
 */
export function restoreSavedView(saved: SavedView, times: readonly number[]): LogicalRange | null {
  if (times.length === 0) return null;
  if (saved.following) {
    const to = times.length - 1 + saved.rightOffset;
    return { from: to - saved.width, to };
  }
  if (times[times.length - 1] < saved.toTime) return null;
  const from = clampIndex(lowerBound(times, saved.fromTime), times.length);
  return { from, to: from + saved.width };
}

/** A stored view from untrusted storage, or null. */
export function parseSavedView(raw: unknown): SavedView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (typeof r.following !== 'boolean' || !num(r.fromTime) || !num(r.toTime) || !num(r.width) || !num(r.rightOffset) || r.width <= 0) return null;
  return { following: r.following, fromTime: r.fromTime, toTime: r.toTime, width: r.width, rightOffset: r.rightOffset };
}

/** Bars of margin around a trade when it is shown on the chart (at least this many on each side). */
export const TRADE_VIEW_MIN_MARGIN = 20;

/**
 * The part of the chart to show for a trade that opened at `entryMs` and closed at `exitMs`: the whole trade with a
 * margin of half its length (at least TRADE_VIEW_MIN_MARGIN bars) on each side. Null when the chart has no bars or the
 * trade lies outside them. Pure.
 */
export function rangeAroundTrade(times: readonly number[], entryMs: number, exitMs: number): LogicalRange | null {
  const n = times.length;
  if (n === 0 || exitMs < times[0] || entryMs > times[n - 1]) return null;
  const from = clampIndex(lowerBound(times, entryMs), n);
  const to = clampIndex(lowerBound(times, exitMs), n);
  const margin = Math.max(TRADE_VIEW_MIN_MARGIN, Math.round((to - from) / 2));
  return { from: from - margin, to: to + margin };
}

import type { NotFilledReason } from '../engine/broker';
import type { EngineActivity } from '../engine/engine';
import { fmtNum } from './format';
import type { HistoryNeed } from './warmup';

/** Everything the verdict sentence is built from (numbers only, so it can be tested without a run). */
export interface VerdictInput {
  /** Closed round trips. */
  tradeCount: number;
  /** A position is still open after the last bar. */
  openPosition: boolean;
  fillCount: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  wiped: boolean;
  /** Bars the engine processed (stops early on a wipe). */
  barsProcessed: number;
  /** Bars loaded for the run. */
  barsLoaded: number;
  benchmark: { returnPct: number; maxDrawdownPct: number } | null;
  activity: EngineActivity | null;
  /** Bars needed before the first order can fill (known), or unknown; null when not analysed. */
  warmup: HistoryNeed | null;
}

export type VerdictTone = 'good' | 'bad' | 'neutral' | 'warn';

export interface Verdict {
  tone: VerdictTone;
  /** The plain sentence(s) shown above the stats. */
  text: string;
  /** An optional second line (why no trades, rejected orders). */
  hint?: string;
}

/** Below this difference in return points, strategy and buy & hold count as a tie. */
export const TIE_POINTS = 0.005;

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
const signedPct = (v: number) => `${v > 0 ? '+' : ''}${fmtNum(v)}%`;

const REASON_TEXT: Record<NotFilledReason, string> = {
  'insufficient margin': 'insufficient margin (the order needed more margin than was free: lower the size or raise the leverage)',
  'nothing to reduce': 'nothing to reduce (a close/reduce order with no position to close)',
};

function notFilledTotal(a: EngineActivity): number {
  return Object.values(a.notFilled).reduce((s, n) => s + n, 0);
}

/** The most frequent not-filled reason (first in table order on ties), or null. */
export function topReason(a: EngineActivity): NotFilledReason | null {
  let best: NotFilledReason | null = null;
  for (const reason of Object.keys(REASON_TEXT) as NotFilledReason[]) {
    if (a.notFilled[reason] > 0 && (best === null || a.notFilled[reason] > a.notFilled[best])) best = reason;
  }
  return best;
}

/** "Buy & hold: +3.10%" plus how the strategy compares, or '' without a benchmark. */
function versus(input: VerdictInput, compare: boolean): string {
  const b = input.benchmark;
  if (!b || !Number.isFinite(b.returnPct)) return '';
  const head = ` Buy & hold: ${signedPct(b.returnPct)}`;
  if (!compare) return `${head} over the same bars.`;
  const diff = input.totalReturnPct - b.returnPct;
  if (Math.abs(diff) < TIE_POINTS) return `${head} — your strategy matched it.`;
  return `${head} — your strategy ${diff > 0 ? 'beat' : 'lagged'} it by ${fmtNum(Math.abs(diff))} points.`;
}

function tradesText(input: VerdictInput): string {
  if (!input.openPosition) return plural(input.tradeCount, 'trade');
  if (input.tradeCount === 0) return '1 trade (still open at the end)';
  return `${plural(input.tradeCount, 'trade')} (+1 still open at the end)`;
}

/** Why a run produced no fills at all: history too short, no orders, all rejected, or none filled. */
function noTrades(input: VerdictInput): Verdict {
  const a = input.activity;
  const bars = a ? a.barsRun : input.barsProcessed;
  const w = input.warmup;
  if (w?.known && bars < w.bars) {
    return {
      tone: 'warn',
      text: `Not enough history: ${w.label} needs ${plural(w.bars, 'bar')} before the first order can fill, but only ${plural(bars, 'bar')} ${bars === 1 ? 'was' : 'were'} loaded — move the start date earlier.`,
    };
  }
  const tail = versus(input, false);
  if (!a || a.orderRequests === 0) {
    const hint = w && !w.known
      ? `Your strategy ran on ${plural(bars, 'bar')} but never placed an order. Only ${plural(bars, 'bar')} ${bars === 1 ? 'was' : 'were'} loaded — if it needs a long warm-up, try an earlier start date; otherwise check your conditions.`
      : `Your strategy ran on ${plural(bars, 'bar')} but never placed an order — check your conditions.`;
    return { tone: 'warn', text: `No trades.${tail}`, hint };
  }
  const rejected = notFilledTotal(a);
  const reason = topReason(a);
  if (reason && rejected >= a.orderRequests) {
    return {
      tone: 'warn',
      text: `No trades.${tail}`,
      hint: `It tried ${plural(a.orderRequests, 'order')} but ${a.orderRequests === 1 ? 'it was' : 'all were'} rejected: ${REASON_TEXT[reason]}.`,
    };
  }
  return {
    tone: 'warn',
    text: `No trades.${tail}`,
    hint: `It placed ${plural(a.orderRequests, 'order')} but none filled${rejected > 0 ? ` (${rejected} rejected: ${reason})` : ''} — a limit price was never reached, or the order was placed on the last bar.`,
  };
}

/**
 * The plain-language result of a backtest, e.g. "76 trades · +7.48% return · worst drop 15.0%. Buy & hold: +3.10% —
 * your strategy beat it by 4.38 points." Pure: same input -> same text.
 */
export function buildVerdict(input: VerdictInput): Verdict {
  if (input.barsLoaded < 2) {
    return { tone: 'warn', text: `Too little history: only ${plural(input.barsLoaded, 'bar')} loaded — move the start date earlier.` };
  }
  if (input.wiped) {
    return {
      tone: 'bad',
      text: `Account wiped: equity fell to zero after ${tradesText(input)} and the run stopped at bar ${input.barsProcessed.toLocaleString('en-US')} of ${input.barsLoaded.toLocaleString('en-US')}.${versus(input, false)}`,
      hint: 'Lower the leverage or the position size, or add a stop-loss.',
    };
  }
  if (input.fillCount === 0) return noTrades(input);

  const ret = input.totalReturnPct;
  const retText = ret < 0 ? `${signedPct(ret)} return (a loss)` : `${signedPct(ret)} return`;
  const text = `${tradesText(input)} · ${retText} · worst drop ${fmtNum(input.maxDrawdownPct, 1)}%.${versus(input, true)}`;
  const b = input.benchmark;
  const beat = !b || ret - b.returnPct >= TIE_POINTS;
  const tone: VerdictTone = ret < 0 ? 'bad' : ret > 0 && beat ? 'good' : 'neutral';

  const a = input.activity;
  const rejected = a ? notFilledTotal(a) : 0;
  const reason = a ? topReason(a) : null;
  const hint = rejected > 0 && reason ? `${plural(rejected, 'order')} did not fill: ${REASON_TEXT[reason]}.` : undefined;
  return hint ? { tone, text, hint } : { tone, text };
}

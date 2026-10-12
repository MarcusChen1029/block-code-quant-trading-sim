import type { NotFilledReason } from '../engine/broker';
import type { EngineActivity } from '../engine/engine';
import { benchmarkLabel } from '../engine/benchmark';
import { fmtNum, fmtPct, fmtTime, type StatRow } from './format';
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
  /** label: what to call it ('Buy & hold (3x)' at 3x leverage); 'Buy & hold' when absent. */
  /** wipedTime: a leveraged hold that was wiped (shown as such, its return clamped at -100%). */
  benchmark: { returnPct: number; maxDrawdownPct: number; label?: string; wipedTime?: number | null } | null;
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

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;
/** Percent rounded to what is displayed (2 decimals); -0 becomes 0, so "-0.00%" can never appear. */
export const shownPct = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return r === 0 ? 0 : r;
};
/** "+5.01%", "-3.20%", "0.00%" (never signed zero), "n/a" when not a finite number. */
const signedPct = (v: number) => {
  if (!Number.isFinite(v)) return 'n/a';
  const r = shownPct(v);
  return `${r > 0 ? '+' : ''}${fmtNum(r)}%`;
};

const REASON_TEXT: Record<NotFilledReason, string> = {
  'insufficient margin': 'insufficient margin (the order needed more margin than was free: lower the size or raise the leverage)',
  'nothing to reduce': 'nothing to reduce (a close/reduce order with no position to close)',
};

function notFilledTotal(a: EngineActivity): number {
  return Object.values(a.notFilled).reduce((s, n) => s + n, 0);
}

/** "2 × insufficient margin (…); 1 × nothing to reduce (…)": every reason with its real count, most frequent first. */
function reasonsText(a: EngineActivity): string {
  return (Object.keys(REASON_TEXT) as NotFilledReason[])
    .filter((r) => a.notFilled[r] > 0)
    .sort((x, y) => a.notFilled[y] - a.notFilled[x])
    .map((r) => `${a.notFilled[r].toLocaleString('en-US')} × ${REASON_TEXT[r]}`)
    .join('; ');
}

/** The most frequent not-filled reason (first in table order on ties), or null. */
export function topReason(a: EngineActivity): NotFilledReason | null {
  let best: NotFilledReason | null = null;
  for (const reason of Object.keys(REASON_TEXT) as NotFilledReason[]) {
    if (a.notFilled[reason] > 0 && (best === null || a.notFilled[reason] > a.notFilled[best])) best = reason;
  }
  return best;
}

/**
 * The benchmark return as shown and compared: a wiped leveraged hold lost (at least) the whole balance; the force
 * close's fee can push its equity below zero, which is shown as -100% (flagged as wiped), never as "-150%".
 */
function shownBenchmarkReturn(b: { returnPct: number; wipedTime?: number | null }): number {
  return b.wipedTime != null ? Math.max(b.returnPct, -100) : b.returnPct;
}

/** The buy & hold stat cards: return, max drawdown, and when a leveraged hold was wiped. Pure. */
export function benchmarkCardRows(b: { returnPct: number; maxDrawdownPct: number; leverage: number; wipedTime: number | null }): StatRow[] {
  const name = benchmarkLabel(b.leverage);
  const wiped = b.wipedTime !== null;
  const ret = shownBenchmarkReturn(b);
  const dd = wiped ? Math.min(b.maxDrawdownPct, 100) : b.maxDrawdownPct;
  const rows: StatRow[] = [
    { label: `${name} return`, value: `${fmtPct(ret)}${wiped ? ' (wiped)' : ''}`, tone: ret > 0 ? 'pos' : ret < 0 ? 'neg' : 'neutral' },
    { label: `${name} max DD`, value: fmtPct(dd), tone: dd > 0 ? 'neg' : 'neutral' },
  ];
  if (b.wipedTime !== null) rows.push({ label: name, value: `account wiped at ${fmtTime(b.wipedTime)}`, tone: 'neg' });
  return rows;
}

/** "Buy & hold: +3.10%" plus how the strategy compares, or '' without a benchmark. */
function versus(input: VerdictInput, compare: boolean): string {
  const b = input.benchmark;
  if (!b || !Number.isFinite(b.returnPct)) return '';
  const bRet = shownBenchmarkReturn(b);
  const name = b.label ?? 'Buy & hold';
  const head = b.wipedTime != null
    ? ` ${name}: account wiped at ${fmtTime(b.wipedTime)} (${signedPct(bRet)})`
    : ` ${name}: ${signedPct(bRet)}`;
  if (!compare || !Number.isFinite(input.totalReturnPct)) return `${head} over the same bars.`;
  // Compare what the reader sees: two returns that both display as +5.01% are a tie.
  const diff = shownPct(shownPct(input.totalReturnPct) - shownPct(bRet));
  if (diff === 0) return `${head} — your strategy matched it.`;
  return `${head} — your strategy ${diff > 0 ? 'beat it' : 'fell behind it'} by ${fmtNum(Math.abs(diff))} percentage points.`;
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
      text: `Not enough history: ${w.label} needs ${w.atLeast ? 'at least ' : ''}${plural(w.bars, 'bar')} before the first order can fill, but only ${plural(bars, 'bar')} ${bars === 1 ? 'was' : 'were'} loaded — move the start date earlier.`,
    };
  }
  const tail = versus(input, false);
  if (!a || a.orderRequests === 0) {
    const hint = w?.known && w.atLeast
      ? `Your strategy ran on ${plural(bars, 'bar')} but never placed an order. Zone indicators only have values once the price forms a zone, so ${plural(bars, 'bar')} may not be enough — try an earlier start date; otherwise check your conditions.`
      : w && !w.known
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
      hint: `It tried ${plural(a.orderRequests, 'order')} but ${a.orderRequests === 1 ? 'it was' : 'all were'} rejected: ${reasonsText(a)}.`,
    };
  }
  return {
    tone: 'warn',
    text: `No trades.${tail}`,
    // Rejections lead (they are the cause for those orders); only the rest is put down to limits / the last bar.
    hint: rejected > 0
      ? `It placed ${plural(a.orderRequests, 'order')} but none filled: ${reasonsText(a)}; the other ${(a.orderRequests - rejected).toLocaleString('en-US')} never filled — a limit price was never reached, or the order was placed on the last bar.`
      : `It placed ${plural(a.orderRequests, 'order')} but none filled — a limit price was never reached, or the order was placed on the last bar.`,
  };
}

/**
 * The plain-language result of a backtest, e.g. "76 trades · +7.48% return · worst drop 15.0%. Buy & hold: +3.10% —
 * your strategy beat it by 4.38 percentage points." Pure: same input -> same text.
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

  const finite = Number.isFinite(input.totalReturnPct);
  const ret = finite ? shownPct(input.totalReturnPct) : 0;
  const retText = !finite ? 'return n/a' : ret < 0 ? `${signedPct(ret)} return (a loss)` : `${signedPct(ret)} return`;
  const text = `${tradesText(input)} · ${retText} · worst drop ${fmtNum(input.maxDrawdownPct, 1)}%.${versus(input, true)}`;
  const b = input.benchmark;
  const beat = !b || !Number.isFinite(b.returnPct) || shownPct(ret - shownPct(shownBenchmarkReturn(b))) > 0;
  const tone: VerdictTone = !finite ? 'neutral' : ret < 0 ? 'bad' : ret > 0 && beat ? 'good' : 'neutral';

  const a = input.activity;
  const rejected = a ? notFilledTotal(a) : 0;
  const hint = a && rejected > 0 ? `${plural(rejected, 'order')} did not fill: ${reasonsText(a)}.` : undefined;
  return hint ? { tone, text, hint } : { tone, text };
}

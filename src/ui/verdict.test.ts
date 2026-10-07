import { describe, it, expect } from 'vitest';
import { buildVerdict, topReason, type VerdictInput } from './verdict';

const activity = (barsRun: number, orderRequests: number, margin = 0, reduce = 0) =>
  ({ barsRun, orderRequests, notFilled: { 'insufficient margin': margin, 'nothing to reduce': reduce } });

const BASE: VerdictInput = {
  tradeCount: 76, openPosition: false, fillCount: 152, totalReturnPct: 7.48, maxDrawdownPct: 15.04, wiped: false,
  barsProcessed: 2000, barsLoaded: 2000, benchmark: { returnPct: 3.1, maxDrawdownPct: 22 }, activity: activity(2000, 152), warmup: { known: true, label: 'SMA 30', bars: 32 },
};
const v = (patch: Partial<VerdictInput>) => buildVerdict({ ...BASE, ...patch });

describe('buildVerdict', () => {
  it('profit that beat buy & hold', () => {
    expect(v({})).toEqual({ tone: 'good', text: '76 trades · +7.48% return · worst drop 15.0%. Buy & hold: +3.10% — your strategy beat it by 4.38 points.' });
  });

  it('loss that lagged buy & hold', () => {
    expect(v({ totalReturnPct: -3.2, benchmark: { returnPct: 12.5, maxDrawdownPct: 9 } })).toEqual({
      tone: 'bad', text: '76 trades · -3.20% return (a loss) · worst drop 15.0%. Buy & hold: +12.50% — your strategy lagged it by 15.70 points.',
    });
  });

  it('a profit that still lagged is neutral, not good', () => {
    expect(v({ totalReturnPct: 2, benchmark: { returnPct: 5, maxDrawdownPct: 1 } }).tone).toBe('neutral');
  });

  it('tie with buy & hold', () => {
    expect(v({ totalReturnPct: 3.102, benchmark: { returnPct: 3.1, maxDrawdownPct: 1 } }).text).toBe(
      '76 trades · +3.10% return · worst drop 15.0%. Buy & hold: +3.10% — your strategy matched it.');
  });

  it('exactly one trade (singular), and without a benchmark', () => {
    expect(v({ tradeCount: 1, fillCount: 2, benchmark: null }).text).toBe('1 trade · +7.48% return · worst drop 15.0%.');
  });

  it('one position still open at the end (buy & hold strategy)', () => {
    expect(v({ tradeCount: 0, openPosition: true, fillCount: 1, totalReturnPct: 3.05 }).text).toBe(
      '1 trade (still open at the end) · +3.05% return · worst drop 15.0%. Buy & hold: +3.10% — your strategy lagged it by 0.05 points.');
    expect(v({ openPosition: true }).text.startsWith('76 trades (+1 still open at the end) · ')).toBe(true);
  });

  it('wiped account', () => {
    expect(v({ wiped: true, tradeCount: 1, fillCount: 2, barsProcessed: 36, barsLoaded: 300, benchmark: { returnPct: -40, maxDrawdownPct: 50 } })).toEqual({
      tone: 'bad',
      text: 'Account wiped: equity fell to zero after 1 trade and the run stopped at bar 36 of 300. Buy & hold: -40.00% over the same bars.',
      hint: 'Lower the leverage or the position size, or add a stop-loss.',
    });
  });

  it('too little history to run', () => {
    expect(v({ barsLoaded: 1, barsProcessed: 1 })).toEqual({ tone: 'warn', text: 'Too little history: only 1 bar loaded — move the start date earlier.' });
  });

  it('not enough history for the slowest indicator', () => {
    expect(v({ fillCount: 0, tradeCount: 0, barsProcessed: 20, barsLoaded: 20, activity: activity(20, 0) })).toEqual({
      tone: 'warn', text: 'Not enough history: SMA 30 needs 32 bars before the first order can fill, but only 20 bars were loaded — move the start date earlier.',
    });
  });

  it('ran but never placed an order', () => {
    expect(v({ fillCount: 0, tradeCount: 0, totalReturnPct: 0, activity: activity(2000, 0) })).toEqual({
      tone: 'warn', text: 'No trades. Buy & hold: +3.10% over the same bars.',
      hint: 'Your strategy ran on 2,000 bars but never placed an order — check your conditions.',
    });
  });

  it('never placed an order and the history need is unknown: generic hint, no number', () => {
    expect(v({ fillCount: 0, tradeCount: 0, warmup: { known: false }, activity: activity(20, 0) }).hint).toBe(
      'Your strategy ran on 20 bars but never placed an order. Only 20 bars were loaded — if it needs a long warm-up, try an earlier start date; otherwise check your conditions.');
  });

  it('never placed an order, warm-up not analysed', () => {
    expect(v({ fillCount: 0, tradeCount: 0, warmup: null, activity: activity(5, 0), benchmark: null }).hint).toBe(
      'Your strategy ran on 5 bars but never placed an order — check your conditions.');
  });

  it('tried orders but all were rejected, with the top reason', () => {
    expect(v({ fillCount: 0, tradeCount: 0, activity: activity(2000, 3, 3) }).hint).toBe(
      'It tried 3 orders but all were rejected: insufficient margin (the order needed more margin than was free: lower the size or raise the leverage).');
    expect(v({ fillCount: 0, tradeCount: 0, activity: activity(2000, 1, 0, 1) }).hint).toBe(
      'It tried 1 order but it was rejected: nothing to reduce (a close/reduce order with no position to close).');
  });

  it('placed orders that never filled (pending limit / last bar)', () => {
    expect(v({ fillCount: 0, tradeCount: 0, activity: activity(2000, 2) }).hint).toBe(
      'It placed 2 orders but none filled — a limit price was never reached, or the order was placed on the last bar.');
    expect(v({ fillCount: 0, tradeCount: 0, activity: activity(2000, 3, 1) }).hint).toBe(
      'It placed 3 orders but none filled (1 rejected: insufficient margin) — a limit price was never reached, or the order was placed on the last bar.');
  });

  it('notes rejected orders on a run that did trade', () => {
    expect(v({ activity: activity(2000, 160, 8) }).hint).toBe(
      '8 orders did not fill: insufficient margin (the order needed more margin than was free: lower the size or raise the leverage).');
  });

  it('topReason picks the most frequent', () => {
    expect(topReason(activity(1, 5, 1, 3))).toBe('nothing to reduce');
    expect(topReason(activity(1, 5))).toBeNull();
  });
});

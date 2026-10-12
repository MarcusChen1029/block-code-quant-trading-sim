import { describe, expect, it } from 'vitest';
import type { Candle } from '../../src/data/types';
import type { LiveEvent } from '../../src/live/host';
import type { ClientFactory } from '../../src/live/supervisor';
import type { SessionDelta } from '../../src/live/sessionEngine';
import { MemorySessionStore } from '../../src/live/store';
import { HISTORY_CAPS, SessionManager, type SessionSnapshot } from './sessions';

const MINUTE = 60_000;

/**
 * A supervisor stand-in: on start it floods `bars` closed 1m candles as deltas, then goes live. It drives the
 * manager exactly as a real worker would, without the engine, so the test is fast and deterministic.
 */
function floodFactory(bars: number): ClientFactory {
  return (_session, _mode, onEvent) => {
    queueMicrotask(() => {
      const BATCH = 2000;
      for (let i = 0; i < bars; i += BATCH) {
        const candles: Candle[] = [];
        const equity: SessionDelta['equity'] = [];
        const trades: SessionDelta['trades'] = [];
        for (let j = i; j < Math.min(bars, i + BATCH); j++) {
          const t = j * MINUTE;
          candles.push({ time: t, open: 100, high: 101, low: 99, close: 100 + (j % 7), volume: 1 });
          equity.push({ time: t, equity: 10_000 + (j % 50) } as SessionDelta['equity'][number]);
          if (j % 3 === 0) trades.push({ entryTime: t, exitTime: t, side: 'long', entryPrice: 100, exitPrice: 101, qty: 1, pnl: 1 } as unknown as SessionDelta['trades'][number]);
        }
        const delta = {
          candles, fills: [], trades, equity, log: [{ bar: i, time: candles[0].time, level: 'info', message: `batch ${i}` }],
          stats: { finalEquity: 10_000, totalReturnPct: 0, tradeCount: 0, bars: 0 },
          position: null, lastBarTime: (Math.min(bars, i + BATCH) - 1) * MINUTE,
          barsProcessed: Math.min(bars, i + BATCH), wiped: false, activity: {},
        } as unknown as SessionDelta;
        onEvent({ type: 'delta', delta });
      }
      onEvent({ type: 'status', status: { state: 'live', lastBarTime: (bars - 1) * MINUTE, barsProcessed: bars, behindBars: 0 } } as LiveEvent);
    });
    return { stop() {}, resync() {}, debug() {}, terminate() {} } as never;
  };
}

describe('server session history is bounded', () => {
  it('a 30-day 1m session (43,200 bars) stays within the caps and a snapshot stays small', async () => {
    const bars = 30 * 24 * 60; // 43,200
    const manager = new SessionManager({ store: new MemorySessionStore(), createClient: floodFactory(bars), now: () => bars * MINUTE });
    const created = await manager.create({
      name: 'flood', symbol: 'BTCUSDT', timeframe: '1m', startMs: 0, warmupBars: 0,
      brokerConfig: { initialBalance: 10_000, leverage: 1, takerFee: 0, makerFee: 0, slippageBps: 0 },
      strategy: { kind: 'builtin-sma-cross', params: { fast: 5, slow: 20, sizePct: 50 } },
    });

    await new Promise((r) => setTimeout(r, 50)); // let the flood microtask drain
    let snap: SessionSnapshot | null = null;
    const off = manager.watch(created.id, (m) => { if (m.type === 'snapshot') snap = m.snapshot; }); // snapshot arrives synchronously
    off?.();
    expect(snap).not.toBeNull();

    expect(snap!.candles.length).toBeLessThanOrEqual(HISTORY_CAPS.candles);
    expect(snap!.candles.length).toBeGreaterThan(HISTORY_CAPS.candles / 2); // a full recent window is kept
    expect(snap!.equity.length).toBeLessThanOrEqual(HISTORY_CAPS.equity);
    expect(snap!.log.length).toBeLessThanOrEqual(HISTORY_CAPS.log);
    expect(snap!.trades.length).toBeLessThanOrEqual(HISTORY_CAPS.trades);
    // The newest bar is retained (the window is the recent tail), and the snapshot serializes to a few MB, not tens.
    expect(snap!.candles[snap!.candles.length - 1].time).toBe((bars - 1) * MINUTE);
    const bytes = Buffer.byteLength(JSON.stringify(snap));
    expect(bytes).toBeLessThan(8 * 1024 * 1024);
    await manager.close();
  });
});

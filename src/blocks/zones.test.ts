import * as Blockly from 'blockly';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Candle } from '../data/types';
import { runBacktest, type EngineConfig } from '../engine/engine';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { FairValueGaps, OrderBlocks, SwingStructure, type Zone } from '../indicators/zones';
import { LiveRunner } from '../live/runner';
import { blocksSnapshot, snapshotToSpec } from '../live/session';
import { SessionEngine } from '../live/sessionEngine';
import { FakeMarket, MINUTE, ManualTimers, Recorder, testSession } from '../live/testing';
import { buildStrategy, handleRequest } from '../worker/protocol';
import { BT } from './blockTypes';
import { compileBlocks, createBlockStrategy } from './compiler';
import { defineBlocks, indicatorBlockJson, signalBlockJson } from './definitions';
import { getIndicator } from './registry';
import { compare, ifThen, indicator, log, num, signal, value, workspace } from './testing';
import { buildToolbox } from './toolbox';
import { zoneExampleWorkspace } from './zoneExample';

const CONFIG: EngineConfig = { symbol: 'BTCUSDT', timeframe: '1h', broker: DEFAULT_BROKER_CONFIG };

/** Deterministic random walk with real candles (bodies both ways, wicks, occasional jumps): plenty of zones. */
function walk(n: number, stepMs = 3_600_000, seed = 42): Candle[] {
  let a = seed;
  const r = () => {
    a = (a * 1103515245 + 12345) % 2147483648;
    return a / 2147483648;
  };
  const out: Candle[] = [];
  let close = 100;
  for (let i = 0; i < n; i++) {
    const open = close;
    close = Math.max(5, open + (r() - 0.48) * 2.2 + (i % 53 === 0 ? (r() - 0.5) * 9 : 0));
    out.push({ time: i * stepMs, open, close, high: Math.max(open, close) + r() * 0.9, low: Math.min(open, close) - r() * 0.9, volume: 10 });
  }
  return out;
}

const CANDLES = walk(1500);
const OB = { SWING: 5, LOOKBACK: 10, USE_BODY: 0, MAX_AGE: 300, MAX_ACTIVE: 5 };
const FVG = { MIN_GAP_PCT: 0.05, MAX_AGE: 300, MAX_ACTIVE: 5 };

beforeAll(() => defineBlocks());

const fmt = (v: number) => (Number.isNaN(v) ? 'na' : String(v));
function logs(ws: unknown, candles = CANDLES): string[] {
  return runBacktest(candles, createBlockStrategy(ws), CONFIG).log.filter((l) => l.level === 'info').map((l) => l.message);
}

describe('zone blocks: definitions and toolbox', () => {
  it('ind_ blocks have an output dropdown and the params, no SOURCE input; sig_ blocks list the signals', () => {
    const ob = getIndicator('orderblock')!;
    const ind = indicatorBlockJson(ob);
    const args = ind.args0 as Array<Record<string, unknown>>;
    expect(args.find((a) => a.name === 'OUT')?.options).toEqual([
      ['nearest bullish order block top', 'bull_top'], ['nearest bullish order block bottom', 'bull_bottom'],
      ['nearest bearish order block top', 'bear_top'], ['nearest bearish order block bottom', 'bear_bottom'],
    ]);
    expect(args.filter((a) => a.type === 'input_value')).toEqual([]);
    expect(args.filter((a) => a.type === 'field_number').map((a) => a.name)).toEqual(['SWING', 'LOOKBACK', 'USE_BODY', 'MAX_AGE', 'MAX_ACTIVE']);
    const sig = signalBlockJson(ob);
    expect(sig.output).toBe('Boolean');
    expect(((sig.args0 as Array<Record<string, unknown>>).find((a) => a.name === 'SIGOUT')?.options as string[][]).map((o) => o[1]))
      .toEqual(['new_bull', 'new_bear', 'in_bull', 'in_bear', 'bull_mitigated', 'bear_mitigated']);
    expect(((signalBlockJson(getIndicator('fvg')!).args0 as Array<Record<string, unknown>>).find((a) => a.name === 'SIGOUT')?.options as string[][])[2])
      .toEqual(['Price inside bullish FVG', 'in_bull']);
    expect(((signalBlockJson(getIndicator('swing')!).args0 as Array<Record<string, unknown>>).find((a) => a.name === 'SIGOUT')?.options as string[][]).map((o) => o[0]))
      .toEqual(['Break of structure up', 'Break of structure down', 'Change of character up', 'Change of character down', 'Swing high confirmed', 'Swing low confirmed']);
    // Tooltips state the definition (fixed strings).
    expect(String(ind.tooltip)).toMatch(/LAST bearish candle/);
  });

  it('headless Blockly creates all six blocks; they sit in a Zones toolbox category, not under Indicators', () => {
    const ws = new Blockly.Workspace();
    for (const id of ['swing', 'orderblock', 'fvg']) {
      expect(ws.newBlock(`ind_${id}`).outputConnection?.getCheck()).toEqual(['Number']);
      expect(ws.newBlock(`sig_${id}`).outputConnection?.getCheck()).toEqual(['Boolean']);
    }
    ws.dispose();
    const types = (name: string) => buildToolbox().contents.find((c) => c.name === name)!.contents!.flatMap((b) => (b.kind === 'block' ? [b.type] : []));
    expect(types('Zones')).toEqual(['ind_swing', 'sig_swing', 'ind_orderblock', 'sig_orderblock', 'ind_fvg', 'sig_fvg']);
    expect(types('Indicators').some((t) => /swing|orderblock|fvg/.test(t))).toBe(false);
  });
});

describe('zone blocks: compile and run', () => {
  it('block values equal the indicator classes bar by bar (numeric outputs and signals)', () => {
    const ws = workspace({
      onBar: [
        log(indicator('orderblock', { OUT: 'bull_top', ...OB }, null)),
        log(indicator('fvg', { OUT: 'bear_bottom', ...FVG }, null)),
        log(indicator('swing', { OUT: 'last_high', LEFT: 5, RIGHT: 5 }, null)),
        log(signal('orderblock', 'in_bull', OB, null)),
        log(signal('swing', 'bos_down', { LEFT: 5, RIGHT: 5 }, null)),
      ],
    });
    // 900 bars x 5 lines stays under the run log's line cap.
    const bars = CANDLES.slice(0, 900);
    const got = logs(ws, bars);
    const ob = new OrderBlocks();
    const fvg = new FairValueGaps();
    const sw = new SwingStructure(5, 5);
    const sw2 = new SwingStructure(5, 5);
    const want: string[] = [];
    for (const c of bars) {
      const o = ob.update(c);
      const f = fvg.update(c);
      const s = sw.update(c);
      const s2 = sw2.update(c);
      want.push(fmt(o.bullTop), fmt(f.bearBottom), fmt(s.lastHigh), String(o.inBull), String(s2.bosDown));
    }
    expect(got).toEqual(want);
    expect(got.filter((l) => l === 'true').length).toBeGreaterThan(20);
  });

  it('hoisting: a zone block inside an if that is not taken still updates its state every bar', () => {
    const late = compare('GTE', value(BT.barIndex), num(1200));
    const ws = workspace({ onBar: [ifThen(late, log(indicator('orderblock', { OUT: 'bull_bottom', ...OB }, null)), log(signal('fvg', 'in_bear', FVG, null)))] });
    const got = logs(ws);
    const ob = new OrderBlocks();
    const fvg = new FairValueGaps();
    const want: string[] = [];
    CANDLES.forEach((c, i) => {
      const o = ob.update(c);
      const f = fvg.update(c);
      if (i >= 1200) want.push(fmt(o.bullBottom), String(f.inBear));
    });
    expect(got).toEqual(want);
    // Order blocks formed before bar 1200 are visible at bar 1200 (state was kept while the if was skipped).
    expect(got[0]).not.toBe('na');
  });

  it('bad parameters are compile errors naming the block', () => {
    const result = compileBlocks(workspace({ onBar: [log(indicator('orderblock', { OUT: 'bull_top', ...OB, USE_BODY: 2 }, null))] }));
    expect(!result.ok && result.errors[0].message).toBe('Order block body only (1 = yes) must be a whole number from 0 to 1');
  });
});

describe('zone example strategy', () => {
  /** Bars (index) where the example's entry condition is true at the close, from the indicator classes. */
  function entryBars(candles: Candle[]): Set<number> {
    const ob = new OrderBlocks();
    const fvg = new FairValueGaps();
    const out = new Set<number>();
    candles.forEach((c, i) => {
      const o = ob.update(c);
      const f = fvg.update(c);
      if (o.inBull && f.bullBottom > 0) out.add(i);
    });
    return out;
  }

  it('compiles, backtests deterministically, and enters only on bars where the signal was true at that bar\'s close', () => {
    const ws = zoneExampleWorkspace();
    expect(compileBlocks(ws).ok).toBe(true);
    const a = runBacktest(CANDLES, createBlockStrategy(ws), CONFIG);
    const b = runBacktest(CANDLES, createBlockStrategy(ws), CONFIG);
    expect(a.trades.length).toBeGreaterThan(3);
    expect(b.trades).toEqual(a.trades);
    expect(b.fills).toEqual(a.fills);
    const allowed = entryBars(CANDLES);
    const buys = a.fills.filter((f) => f.side === 'buy');
    expect(buys.length).toBeGreaterThan(3);
    // A market order placed on bar t fills at bar t + 1's open: the signal must have been true on bar t.
    for (const f of buys) {
      expect(allowed.has(f.bar - 1), `buy filled on bar ${f.bar}`).toBe(true);
      expect(f.price).toBeGreaterThan(0);
    }
    // Cutting the future off never changes past trading (no look-ahead): a prefix run's fills are a prefix.
    const cut = 900;
    const prefix = runBacktest(CANDLES.slice(0, cut), createBlockStrategy(ws), CONFIG);
    const pastFills = a.fills.filter((f) => f.bar < cut - 1);
    expect(prefix.fills.filter((f) => f.bar < cut - 1)).toEqual(pastFills);
  });

  it('runs in the backtest worker and in a live session engine with the same trades as the backtest', () => {
    const ws = zoneExampleWorkspace();
    const backtest = runBacktest(CANDLES, createBlockStrategy(ws), CONFIG);
    const response = handleRequest({ type: 'run', candles: CANDLES, config: CONFIG, strategy: { id: 'blocks', workspace: ws } });
    expect(response.type).toBe('result');
    if (response.type === 'result') expect(response.result.trades).toEqual(backtest.trades);
    const snapshot = blocksSnapshot(ws, [], []);
    const def = { symbol: 'BTCUSDT', timeframe: '1h' as const, brokerConfig: DEFAULT_BROKER_CONFIG, startTime: CANDLES[0].time, warmupBars: 0 };
    const engine = new SessionEngine(def, buildStrategy(snapshotToSpec(snapshot)), undefined);
    for (const c of CANDLES) expect(engine.push(c)).toBe('processed');
    expect(engine.result().trades).toEqual(backtest.trades);
  });

  it('a live session (fake market) caught up in one go equals a replay of the same bars and an incremental engine', async () => {
    const bars = walk(600, MINUTE, 7);
    const session = testSession({ startTime: 200 * MINUTE, warmupBars: 150 });
    const strategy = () => buildStrategy(snapshotToSpec(blocksSnapshot(zoneExampleWorkspace(), [], [])));
    const runFor = async (mode: 'live' | 'replay', rec: typeof session) => {
      const market = new FakeMarket(bars, MINUTE, 600 * MINUTE);
      const engine = new SessionEngine(rec, strategy(), mode === 'replay' ? (rec.lastBarTime ?? undefined) : undefined);
      const runner = new LiveRunner(engine, market, new Recorder(), {
        mode, symbol: rec.symbol, timeframe: rec.timeframe, now: () => market.now, timers: new ManualTimers(),
        yieldFn: () => Promise.resolve(), closeMarginMs: 0, batchSize: 64, random: () => 1,
      });
      runner.start();
      await runner.idle();
      runner.stop?.();
      return engine;
    };
    const live = await runFor('live', session);
    const replay = await runFor('replay', { ...session, status: 'stopped', lastBarTime: live.lastBarTime });
    const incremental = new SessionEngine(session, strategy());
    for (const c of bars) {
      if (c.time > (live.lastBarTime ?? -1)) break;
      incremental.push(c);
    }
    const core = (e: SessionEngine) => ({ trades: e.result().trades, fills: e.result().fills, finalPosition: e.result().finalPosition });
    expect(core(live).fills.length).toBeGreaterThan(0);
    expect(core(replay)).toEqual(core(live));
    expect(core(incremental)).toEqual(core(live));
  });
});

describe('zone events through the instance (what the chart draws)', () => {
  it('instances report lifecycle events matching the classes; every zone has start <= known and end after known', () => {
    for (const id of ['orderblock', 'fvg', 'swing']) {
      const def = getIndicator(id)!;
      const inst = def.create(Object.fromEntries(def.params.map((p) => [p.name, p.default])));
      const zones = new Map<number, Zone>();
      for (const c of CANDLES) {
        inst.step(NaN, c);
        for (const e of inst.zones?.() ?? []) zones.set(e.id, e);
      }
      expect(zones.size, id).toBeGreaterThan(10);
      for (const z of zones.values()) {
        expect(z.startTime).toBeLessThanOrEqual(z.knownTime);
        if (z.endTime !== null) expect(z.endTime).toBeGreaterThan(z.knownTime);
        expect(z.top).toBeGreaterThanOrEqual(z.bottom);
      }
    }
  });
});

describe('swing structure: CHoCH signals next to the stable BOS keys', () => {
  it('a saved workspace using BOS (JSON round trip) still compiles and reads bos_up / bos_down; choch_* read CHoCH', () => {
    const P = { LEFT: 3, RIGHT: 3 };
    const saved = JSON.parse(JSON.stringify(workspace({
      onBar: [log(signal('swing', 'bos_up', P, null)), log(signal('swing', 'bos_down', P, null)), log(signal('swing', 'choch_up', P, null)), log(signal('swing', 'choch_down', P, null))],
    })));
    expect(compileBlocks(saved).ok).toBe(true);
    const bars = CANDLES.slice(0, 600);
    const s = new SwingStructure(3, 3);
    const want = bars.flatMap((c) => {
      const v = s.update(c);
      return [String(v.bosUp), String(v.bosDown), String(v.chochUp), String(v.chochDown)];
    });
    const got = logs(saved, bars);
    expect(got).toEqual(want);
    // Both kinds occur, and never on the same bar for the same direction.
    expect(got.filter((l, i) => i % 4 === 2 && l === 'true').length).toBeGreaterThan(0);
    expect(got.filter((l, i) => i % 4 === 0 && l === 'true').length).toBeGreaterThan(0);
    for (let i = 0; i < got.length; i += 4) expect(got[i] === 'true' && got[i + 2] === 'true').toBe(false);
  });

  it('keys and labels: the BOS entries are unchanged, CHoCH entries are new', () => {
    const sigs = getIndicator('swing')!.signals!.map((x) => [x.key, x.label]);
    expect(sigs.slice(0, 2)).toEqual([['bos_up', 'Break of structure up'], ['bos_down', 'Break of structure down']]);
    expect(sigs).toContainEqual(['choch_up', 'Change of character up']);
    expect(sigs).toContainEqual(['choch_down', 'Change of character down']);
  });
});

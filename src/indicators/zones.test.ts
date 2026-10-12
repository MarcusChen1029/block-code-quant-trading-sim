import { describe, expect, it } from 'vitest';
import {
  FairValueGaps, FVG_DEFAULTS, ORDER_BLOCK_DEFAULTS, OrderBlocks, SwingStructure, type FvgOptions, type OrderBlockOptions, type Zone,
  type ZoneBar, type ZoneBookValue, type ZoneKind,
} from './zones';

// ---------- fixtures ----------

/** Deterministic PRNG (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const HOUR = 3_600_000;

/** Bars from a close path: open = previous close, wicks from the PRNG (optionally rounded to integers). */
function fromCloses(closes: number[], seed: number, wick = 0.6, round = false): ZoneBar[] {
  const r = rng(seed);
  const q = (v: number) => (round ? Math.round(v) : v);
  let prev = closes[0];
  return closes.map((close, i) => {
    const open = q(prev);
    const c = q(close);
    prev = close;
    return { time: i * HOUR, open, close: c, high: q(Math.max(open, c) + r() * wick), low: q(Math.min(open, c) - r() * wick) };
  });
}

function shape(name: string, n = 520): ZoneBar[] {
  const r = rng(name.length * 7919);
  const closes: number[] = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    switch (name) {
      case 'trend': p += 0.15 + (r() - 0.5) * 1.2; break;
      case 'chop': p = 100 + 6 * Math.sin(i / 5) + (r() - 0.5) * 3; break;
      case 'gaps': p += (r() - 0.5) * 1.5 + (i % 37 === 0 ? (r() < 0.5 ? -8 : 8) : 0); break;
      case 'flat': p = i % 50 < 40 ? 100 : 100 + (r() - 0.5) * 4; break;
      case 'ties': p = 100 + Math.floor(r() * 6); break;
      default: throw new Error(name);
    }
    closes.push(p);
  }
  if (name === 'flat') return fromCloses(closes, 3, 0, false).map((b, i) => (i % 50 < 40 ? { ...b, open: 100, high: 100, low: 100, close: 100 } : b));
  if (name === 'gaps') {
    // Real price gaps: every 37th bar opens far from the previous close.
    return fromCloses(closes, 5).map((b, i) => (i % 37 === 0 && i > 0 ? { ...b, open: b.close, high: b.close + 0.3, low: b.close - 0.3 } : b));
  }
  return fromCloses(closes, name.length, 0.8, name === 'ties');
}

const SHAPES = ['trend', 'chop', 'gaps', 'flat', 'ties'];

/** A handwritten bar: [open, high, low, close]. */
const bars = (rows: Array<[number, number, number, number]>): ZoneBar[] =>
  rows.map(([open, high, low, close], i) => ({ time: i * HOUR, open, high, low, close }));

// ---------- reference implementations (batch, index based; written independently of zones.ts) ----------

interface RefSwing {
  lastHigh: number[]; lastLow: number[]; highConfirmed: boolean[]; lowConfirmed: boolean[]; bosUp: boolean[]; bosDown: boolean[];
  chochUp: boolean[]; chochDown: boolean[];
  /** Every break, exactly master's (pre-CHoCH) bosUp / bosDown definition. */
  breakUp: boolean[]; breakDown: boolean[];
  /** Pivot bar index -> confirmation bar index. */
  pivotHighs: Array<[number, number]>; pivotLows: Array<[number, number]>;
}

function refSwing(b: ZoneBar[], left: number, right: number): RefSwing {
  const n = b.length;
  const isPivot = (i: number, side: 'high' | 'low') => {
    if (i - left < 0 || i + right > n - 1) return false;
    const v = (j: number) => (side === 'high' ? b[j].high : -b[j].low);
    for (let j = i - left; j < i; j++) if (v(j) >= v(i)) return false;
    for (let j = i + 1; j <= i + right; j++) if (v(j) > v(i)) return false;
    return true;
  };
  const out: RefSwing = { lastHigh: [], lastLow: [], highConfirmed: [], lowConfirmed: [], bosUp: [], bosDown: [], chochUp: [], chochDown: [], breakUp: [], breakDown: [], pivotHighs: [], pivotLows: [] };
  let lh = NaN, ll = NaN;
  let upLevel: number | null = null, downLevel: number | null = null;
  /** +1 after an upward break, -1 after a downward one, 0 before the first. */
  let last = 0;
  for (let t = 0; t < n; t++) {
    const i = t - right;
    const ph = i >= 0 && isPivot(i, 'high');
    const pl = i >= 0 && isPivot(i, 'low');
    if (ph) { lh = b[i].high; upLevel = lh; out.pivotHighs.push([i, t]); }
    if (pl) { ll = b[i].low; downLevel = ll; out.pivotLows.push([i, t]); }
    const up = upLevel !== null && b[t].close > upLevel;
    const down = downLevel !== null && b[t].close < downLevel;
    if (up) upLevel = null;
    if (down) downLevel = null;
    // The upward break is classified first, against the previous break; the downward one against the result.
    const chUp = up && last === -1;
    if (up) last = 1;
    const chDown = down && last === 1;
    if (down) last = -1;
    out.lastHigh.push(lh); out.lastLow.push(ll); out.highConfirmed.push(ph); out.lowConfirmed.push(pl);
    out.bosUp.push(up && !chUp); out.bosDown.push(down && !chDown); out.chochUp.push(chUp); out.chochDown.push(chDown);
    out.breakUp.push(up); out.breakDown.push(down);
  }
  return out;
}

interface RefZone { kind: ZoneKind; top: number; bottom: number; start: number; known: number; end: number | null; reason?: string }

/** Shared reference lifecycle over arrays. `detect(t)` returns zones that become known at bar t. */
function refBook(
  b: ZoneBar[],
  maxActive: number,
  maxAge: number,
  detect: (t: number, active: RefZone[]) => RefZone[],
): { values: Omit<ZoneBookValue, 'events'>[]; zones: RefZone[] } {
  const all: RefZone[] = [];
  let active: RefZone[] = [];
  const values: Omit<ZoneBookValue, 'events'>[] = [];
  for (let t = 0; t < b.length; t++) {
    const bar = b[t];
    let bullMit = false, bearMit = false;
    const keep: RefZone[] = [];
    for (const z of active) {
      const through = z.kind === 'bullish' ? bar.close < z.bottom : bar.close > z.top;
      if (through) { z.end = t; z.reason = 'mitigated'; if (z.kind === 'bullish') bullMit = true; else bearMit = true; }
      else if (t - z.known > maxAge) { z.end = t; z.reason = 'expired'; }
      else keep.push(z);
    }
    active = keep;
    const fresh = detect(t, active);
    for (const z of fresh) {
      active.push(z);
      all.push(z);
      const side = active.filter((a) => a.kind === z.kind);
      if (side.length > maxActive) {
        const oldest = side[0];
        oldest.end = t; oldest.reason = 'evicted';
        active = active.filter((a) => a !== oldest);
      }
    }
    const pick = (kind: ZoneKind) => {
      let best: RefZone | null = null;
      let bd = Infinity;
      for (const z of active) {
        if (z.kind !== kind) continue;
        if (kind === 'bullish' ? z.bottom > bar.close : z.top < bar.close) continue;
        const d = kind === 'bullish' ? Math.max(0, bar.close - z.top) : Math.max(0, z.bottom - bar.close);
        if (d <= bd) { bd = d; best = z; }
      }
      return best;
    };
    const bull = pick('bullish');
    const bear = pick('bearish');
    const inside = (kind: ZoneKind) => active.some((z) => z.kind === kind && bar.low <= z.top && bar.high >= z.bottom);
    values.push({
      bullTop: bull ? bull.top : NaN, bullBottom: bull ? bull.bottom : NaN, bearTop: bear ? bear.top : NaN, bearBottom: bear ? bear.bottom : NaN,
      inBull: inside('bullish'), inBear: inside('bearish'),
      newBull: fresh.some((z) => z.kind === 'bullish'), newBear: fresh.some((z) => z.kind === 'bearish'),
      bullMitigated: bullMit, bearMitigated: bearMit,
    });
  }
  return { values, zones: all };
}

function refOrderBlocks(b: ZoneBar[], o: OrderBlockOptions) {
  const s = refSwing(b, o.swingLength, o.swingLength);
  return refBook(b, o.maxActive, o.maxAgeBars, (t, active) => {
    const out: RefZone[] = [];
    for (const kind of ['bullish', 'bearish'] as const) {
      // Every break (BOS or CHoCH) forms a block.
      if (!(kind === 'bullish' ? s.bosUp[t] || s.chochUp[t] : s.bosDown[t] || s.chochDown[t])) continue;
      for (let j = t - 1; j >= Math.max(0, t - o.lookback); j--) {
        const c = b[j];
        const opposite = kind === 'bullish' ? c.close < c.open : c.close > c.open;
        if (!opposite) continue;
        if (active.some((z) => z.kind === kind && z.start === j)) break;
        const top = o.useBody ? Math.max(c.open, c.close) : c.high;
        const bottom = o.useBody ? Math.min(c.open, c.close) : c.low;
        out.push({ kind, top, bottom, start: j, known: t, end: null });
        break;
      }
    }
    return out;
  });
}

function refFvg(b: ZoneBar[], o: FvgOptions) {
  return refBook(b, o.maxActive, o.maxAgeBars, (t) => {
    if (t < 2) return [];
    const a = b[t - 2], c = b[t];
    const min = (o.minGapPct / 100) * Math.abs(c.close) - 1e-9 * Math.abs(c.close);
    if (a.high < c.low && c.low - a.high >= min) return [{ kind: 'bullish', top: c.low, bottom: a.high, start: t - 1, known: t, end: null }];
    if (a.low > c.high && a.low - c.high >= min) return [{ kind: 'bearish', top: a.low, bottom: c.high, start: t - 1, known: t, end: null }];
    return [];
  });
}

// ---------- running the real classes ----------

interface Run<V> { values: V[]; zones: Map<number, Zone> }

function run<V extends { events: Zone[] }>(make: () => { update(bar: ZoneBar): V }, b: readonly ZoneBar[]): Run<Omit<V, 'events'>> {
  const ind = make();
  const zones = new Map<number, Zone>();
  const values: Array<Omit<V, 'events'>> = [];
  for (const bar of b) {
    const { events, ...rest } = ind.update(bar);
    for (const e of events) zones.set(e.id, e);
    values.push(rest);
  }
  return { values, zones };
}

/** Zones of a full run as they stood at the close of bar t (nothing known later, no end after t). */
function zonesAsOf(zones: Map<number, Zone>, time: number): Zone[] {
  return [...zones.values()]
    .filter((z) => z.knownTime <= time)
    .map((z) => (z.endTime !== null && z.endTime > time ? { ...z, endTime: null, endReason: undefined } : z))
    .map((z) => (z.endReason === undefined ? (({ endReason: _r, ...rest }) => rest)(z) : z))
    .sort((a, b) => a.id - b.id);
}

const normalise = (zs: Iterable<Zone>) =>
  [...zs].map((z) => (z.endReason === undefined ? (({ endReason: _r, ...rest }) => rest)(z) : z)).sort((a, b) => a.id - b.id);

/** NaN-safe deep equality via JSON (NaN -> "NaN"). */
const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'number' && Number.isNaN(x) ? 'NaN' : x));

function toRefZones(zones: Map<number, Zone>, b: ZoneBar[]): RefZone[] {
  const idx = new Map(b.map((bar, i) => [bar.time, i]));
  return [...zones.values()].sort((x, y) => x.id - y.id).map((z) => ({
    kind: z.kind, top: z.top, bottom: z.bottom, start: idx.get(z.startTime)!, known: idx.get(z.knownTime)!,
    end: z.endTime === null ? null : idx.get(z.endTime)!, ...(z.endReason ? { reason: z.endReason } : {}),
  }));
}

const INDICATORS: Array<[string, () => { update(bar: ZoneBar): { events: Zone[] } }]> = [
  ['swing structure 5/5', () => new SwingStructure(5, 5)],
  ['swing structure 3/2', () => new SwingStructure(3, 2)],
  ['order blocks (defaults)', () => new OrderBlocks()],
  ['order blocks (body, swing 3, lookback 4, maxActive 2, maxAge 40)', () => new OrderBlocks({ swingLength: 3, lookback: 4, useBody: true, maxActive: 2, maxAgeBars: 40 })],
  ['FVG (defaults)', () => new FairValueGaps()],
  ['FVG (any gap, maxActive 2, maxAge 25)', () => new FairValueGaps({ minGapPct: 0, maxActive: 2, maxAgeBars: 25 })],
];

// ---------- tests ----------

describe('zone indicators: no look-ahead (prefix invariance)', () => {
  for (const shapeName of SHAPES) {
    const b = shape(shapeName);
    for (const [name, make] of INDICATORS) {
      it(`${name} on '${shapeName}' (${b.length} bars): bars[0..t] and the full series agree at every t`, () => {
        const full = run(make, b);
        let zoneCount = 0;
        for (let t = 0; t < b.length; t++) {
          const prefix = run(make, b.slice(0, t + 1));
          expect(json(prefix.values[t]), `outputs at bar ${t}`).toBe(json(full.values[t]));
          expect(json(normalise(prefix.zones.values())), `zones at bar ${t}`).toBe(json(zonesAsOf(full.zones, b[t].time)));
          zoneCount = prefix.zones.size;
        }
        // The fixture exercises the indicator (flat fixtures may legitimately produce few zones).
        if (shapeName !== 'flat') expect(zoneCount).toBeGreaterThan(0);
      });
    }
  }
});

describe('zone indicators match the reference implementations on every fixture', () => {
  for (const shapeName of SHAPES) {
    const b = shape(shapeName);
    it(`swing structure on '${shapeName}'`, () => {
      for (const [l, r] of [[5, 5], [3, 2], [1, 1]]) {
        const ref = refSwing(b, l, r);
        const got = run(() => new SwingStructure(l, r), b).values;
        expect(json(got.map((v) => v.lastHigh))).toBe(json(ref.lastHigh));
        expect(json(got.map((v) => v.lastLow))).toBe(json(ref.lastLow));
        expect(got.map((v) => v.highConfirmed)).toEqual(ref.highConfirmed);
        expect(got.map((v) => v.lowConfirmed)).toEqual(ref.lowConfirmed);
        expect(got.map((v) => v.bosUp)).toEqual(ref.bosUp);
        expect(got.map((v) => v.bosDown)).toEqual(ref.bosDown);
        expect(got.map((v) => v.chochUp)).toEqual(ref.chochUp);
        expect(got.map((v) => v.chochDown)).toEqual(ref.chochDown);
      }
    });
    it(`order blocks on '${shapeName}'`, () => {
      for (const o of [ORDER_BLOCK_DEFAULTS, { swingLength: 3, lookback: 4, useBody: true, maxActive: 2, maxAgeBars: 40 }]) {
        const ref = refOrderBlocks(b, o);
        const got = run(() => new OrderBlocks(o), b);
        expect(json(got.values)).toBe(json(ref.values));
        expect(json(toRefZones(got.zones, b))).toBe(json(ref.zones));
      }
    });
    it(`fair value gaps on '${shapeName}'`, () => {
      for (const o of [FVG_DEFAULTS, { minGapPct: 0, maxActive: 2, maxAgeBars: 25 }, { minGapPct: 1, maxActive: 5, maxAgeBars: 300 }]) {
        const ref = refFvg(b, o);
        const got = run(() => new FairValueGaps(o), b);
        expect(json(got.values)).toBe(json(ref.values));
        expect(json(toRefZones(got.zones, b))).toBe(json(ref.zones));
      }
    });
  }
});

describe('swing structure definition', () => {
  // highs: 1 2 5 3 2 4 6 ...: pivot high at bar 2 (left 2 / right 2), confirmed on bar 4.
  const b = bars([
    [1, 1, 0.5, 1], [1, 2, 0.8, 1.8], [1.8, 5, 1.5, 3], [3, 3, 2, 2.5], [2.5, 2, 1, 1.2], [1.2, 4, 1.1, 3.9], [3.9, 6, 3.8, 5.5],
    [5.5, 7, 5.2, 6.5], [6.5, 6.6, 6, 6.1],
  ]);

  it('a pivot at bar i is unknown before bar i + right, then reported (and signalled) exactly on that bar', () => {
    const v = run(() => new SwingStructure(2, 2), b).values;
    expect(v.slice(0, 4).every((x) => Number.isNaN(x.lastHigh))).toBe(true);
    expect(v[4].lastHigh).toBe(5);
    expect(v.map((x) => x.highConfirmed)).toEqual([false, false, false, false, true, false, false, false, false]);
  });

  it('break of structure fires once per level: the first close above 5 (bar 6), not again on bar 7', () => {
    const v = run(() => new SwingStructure(2, 2), b).values;
    expect(v.map((x) => x.bosUp)).toEqual([false, false, false, false, false, false, true, false, false]);
  });

  it('a flat top marks its first bar; an equal close is not a break', () => {
    const flat = bars([[1, 1, 0.5, 1], [1, 2, 1, 2], [2, 5, 2, 4], [4, 5, 3, 4], [4, 3, 2, 3], [3, 4, 3, 5], [5, 5, 4, 5], [5, 6, 5, 5.01]]);
    const r = run(() => new SwingStructure(2, 2), flat);
    expect(r.values.map((x) => x.highConfirmed)).toEqual([false, false, false, false, true, false, false, false]);
    const level = [...r.zones.values()].find((z) => z.label === 'SH')!;
    expect(level.startTime).toBe(2 * HOUR); // bar 2, not bar 3
    // close 5 on bars 5/6 equals the level: no break; 5.01 on bar 7 breaks it.
    expect(r.values.map((x) => x.bosUp)).toEqual([false, false, false, false, false, false, false, true]);
    expect(level.endReason).toBe('broken');
    expect(level.endTime).toBe(7 * HOUR);
  });

  it('pivot confirmation delay holds on every fixture: outputs never show a pivot before i + right', () => {
    for (const shapeName of SHAPES) {
      const b2 = shape(shapeName);
      const ref = refSwing(b2, 5, 3);
      const v = run(() => new SwingStructure(5, 3), b2).values;
      for (const [i, t] of ref.pivotHighs) {
        expect(t).toBe(i + 3);
        expect(v[t].highConfirmed).toBe(true);
        expect(v[t].lastHigh).toBe(b2[i].high);
      }
      // highConfirmed only ever fires on confirmation bars.
      const confirmBars = new Set(ref.pivotHighs.map(([, t]) => t));
      v.forEach((x, t) => expect(x.highConfirmed).toBe(confirmBars.has(t)));
    }
  });

  it('bearish mirror: a close below the last swing low fires bosDown once', () => {
    const m = bars([
      [9, 9.5, 9, 9], [9, 9, 8, 8.2], [8.2, 8.5, 5, 7], [7, 8, 7, 7.5], [7.5, 9, 8, 8.8], [8.8, 8.9, 6, 6.1], [6.1, 6.2, 4, 4.5], [4.5, 4.6, 3, 3.5],
    ]);
    const v = run(() => new SwingStructure(2, 2), m).values;
    expect(v[4].lastLow).toBe(5);
    expect(v.map((x) => x.bosDown)).toEqual([false, false, false, false, false, false, true, false]);
  });
});

describe('order block definition', () => {
  // Swing high 15 at bar 2 (confirmed bar 4). Bars 3, 4 bearish, 5 bullish. Bar 6 closes 15.5 > 15: bullish BOS.
  const base: Array<[number, number, number, number]> = [
    [10, 11, 9, 10.5], [10.5, 12, 10, 11.5], [11.5, 15, 11, 14], [14, 14.5, 12, 12.5], [12.5, 13, 11.5, 12], [12, 13.5, 11.8, 13.2],
    [13.2, 16, 13, 15.5],
  ];
  const o = (extra: Partial<OrderBlockOptions> = {}): OrderBlockOptions => ({ swingLength: 2, lookback: 5, useBody: false, maxActive: 5, maxAgeBars: 300, ...extra });

  it('bullish OB = the last bearish candle before the BOS bar, known on the BOS bar, wick range', () => {
    const b = bars([...base, [15.5, 15.6, 11.9, 12], [12, 12.2, 11, 11.4]]);
    const r = run(() => new OrderBlocks(o()), b);
    const z = [...r.zones.values()][0];
    expect(z).toMatchObject({ kind: 'bullish', top: 13, bottom: 11.5, startTime: 4 * HOUR, knownTime: 6 * HOUR, label: 'OB+' });
    expect(r.values.map((v) => v.newBull)).toEqual([false, false, false, false, false, false, true, false, false]);
    // Bar 7 closes 12 (inside, above the bottom): active, inside, nearest = this one.
    expect(r.values[7]).toMatchObject({ inBull: true, bullTop: 13, bullBottom: 11.5, bullMitigated: false });
    // Bar 8 closes 11.4 < 11.5: mitigated, nothing active.
    expect(r.values[8]).toMatchObject({ bullMitigated: true, inBull: false });
    expect(r.values[8].bullTop).toBeNaN();
    expect(z).toMatchObject({ endTime: 8 * HOUR, endReason: 'mitigated' });
  });

  it('useBody = body range [min(open, close), max(open, close)]; mitigation uses that bottom', () => {
    const b = bars([...base, [15.5, 15.6, 11.9, 12], [12, 12.2, 11.9, 11.95]]);
    const r = run(() => new OrderBlocks(o({ useBody: true })), b);
    const z = [...r.zones.values()][0];
    expect([z.bottom, z.top]).toEqual([12, 12.5]);
    expect(r.values[7].bullMitigated).toBe(false); // close 12 is not below 12
    expect(r.values[8].bullMitigated).toBe(true); // 11.95 < 12
  });

  it('no opposite candle inside the lookback: no order block', () => {
    const b = bars([...base, [15.5, 15.6, 11.9, 12]]);
    const r = run(() => new OrderBlocks(o({ lookback: 1 })), b); // only bar 5 (bullish) is searched
    expect(r.zones.size).toBe(0);
    expect(r.values.every((v) => !v.newBull)).toBe(true);
  });

  it('expires after maxAgeBars without a mitigating close', () => {
    const hold: Array<[number, number, number, number]> = Array.from({ length: 6 }, () => [15, 15.2, 14.6, 15] as [number, number, number, number]);
    const r = run(() => new OrderBlocks(o({ maxAgeBars: 3 })), bars([...base, ...hold]));
    const z = [...r.zones.values()][0];
    expect(z.endReason).toBe('expired');
    expect(z.endTime).toBe(10 * HOUR); // known on bar 6, 10 - 6 = 4 > 3
    expect(r.values.some((v) => v.bullMitigated)).toBe(false);
    expect(r.values[9].bullTop).toBe(13);
    expect(r.values[10].bullTop).toBeNaN();
  });

  /** Staircase: every 6 bars a new high, a bearish pull-back and a break of the previous high. */
  const stairs = (steps: number) => {
    const rows: Array<[number, number, number, number]> = [];
    for (let s = 0; s < steps; s++) {
      const p = 100 + s * 5;
      rows.push([p, p + 1, p - 0.5, p + 0.8], [p + 0.8, p + 4, p + 0.6, p + 3.5], [p + 3.5, p + 3.6, p + 2, p + 2.2], [p + 2.2, p + 2.4, p + 1.5, p + 1.8],
        [p + 1.8, p + 3, p + 1.7, p + 2.9], [p + 2.9, p + 4.5, p + 2.8, p + 4.4]);
    }
    return bars(rows);
  };

  it('maxActive evicts the oldest of a side; nearest output = the closest zone below the close', () => {
    const b = stairs(8);
    const r = run(() => new OrderBlocks(o({ maxActive: 2 })), b);
    const ref = refOrderBlocks(b, o({ maxActive: 2 }));
    expect(json(r.values)).toBe(json(ref.values));
    const zs = [...r.zones.values()].sort((x, y) => x.id - y.id);
    expect(zs.length).toBeGreaterThanOrEqual(4);
    const evicted = zs.filter((z) => z.endReason === 'evicted');
    expect(evicted.length).toBeGreaterThan(0);
    // Evictions happen oldest first, each on the bar a newer block formed.
    for (const z of evicted) expect(zs.some((n) => n.knownTime === z.endTime && n.id > z.id)).toBe(true);
    expect(evicted.map((z) => z.id)).toEqual([...evicted.map((z) => z.id)].sort((x, y) => x - y));
    // While price climbs the stairs, the nearest bullish block is the most recent (highest) one.
    const last = zs[zs.length - 1];
    expect(r.values[b.length - 1].bullTop).toBe(last.top);
  });

  it('bearish mirror: last bullish candle before a bearish BOS', () => {
    // Swing low 5 at bar 2 (confirmed bar 4); bar 3 bullish, bar 4 bullish, bar 5 bearish, bar 6 closes 4.5 < 5.
    const b = bars([[9, 9.5, 8.6, 9], [9, 9.1, 8, 8.2], [8.2, 8.5, 5, 6], [6, 7.5, 5.8, 7.2], [7.2, 8, 7, 7.8], [7.8, 7.9, 6.5, 6.6], [6.6, 6.7, 4.2, 4.5], [4.5, 8.1, 4.4, 8.05]]);
    const r = run(() => new OrderBlocks(o()), b);
    const z = [...r.zones.values()].find((x) => x.kind === 'bearish')!;
    expect(z).toMatchObject({ top: 8, bottom: 7, startTime: 4 * HOUR, knownTime: 6 * HOUR, label: 'OB-' });
    expect(r.values[6]).toMatchObject({ newBear: true, bearTop: 8, bearBottom: 7 });
    expect(r.values[7]).toMatchObject({ bearMitigated: true }); // close 8.05 > top 8
  });
});

describe('fair value gap definition', () => {
  const opts = (extra: Partial<FvgOptions> = {}): FvgOptions => ({ minGapPct: 0, maxActive: 5, maxAgeBars: 300, ...extra });

  it('bullish gap: a.high < c.low, zone [a.high, c.low], drawn from the middle candle, known on c', () => {
    const b = bars([[9, 10, 8, 9.5], [9.5, 12, 9.4, 11.8], [11.8, 12.5, 11, 12.2], [12.2, 12.3, 10.5, 10.6], [10.6, 10.7, 9.5, 9.8]]);
    const r = run(() => new FairValueGaps(opts()), b);
    const z = [...r.zones.values()][0];
    expect(z).toMatchObject({ kind: 'bullish', bottom: 10, top: 11, startTime: 1 * HOUR, knownTime: 2 * HOUR, label: 'FVG+' });
    expect(r.values.map((v) => v.newBull)).toEqual([false, false, true, false, false]);
    // Bar 3 closes 10.6, inside the gap: not mitigated, inside.
    expect(r.values[3]).toMatchObject({ inBull: true, bullMitigated: false, bullTop: 11, bullBottom: 10 });
    // Bar 4 closes 9.8 < 10: closed through the whole gap.
    expect(r.values[4]).toMatchObject({ bullMitigated: true, inBull: false });
  });

  it('equal prices are not a gap; minGapPct filters small gaps (percent of c.close)', () => {
    const touching = bars([[9, 10, 8, 9.5], [9.5, 12, 9.4, 11.8], [11.8, 12.5, 10, 12.2]]);
    expect(run(() => new FairValueGaps(opts()), touching).zones.size).toBe(0);
    const small = bars([[9, 10, 8, 9.5], [9.5, 12, 9.4, 11.8], [11.8, 12.5, 10.1, 12]]); // gap 0.1 = 0.83 % of 12
    expect(run(() => new FairValueGaps(opts({ minGapPct: 1 })), small).zones.size).toBe(0);
    expect(run(() => new FairValueGaps(opts({ minGapPct: 0.8 })), small).zones.size).toBe(1);
  });

  it('a gap exactly at the minimum (decimal) counts despite float rounding; bullish and bearish', () => {
    // 100 - 99.9 = 0.09999999999999432 in floating point, exactly 0.1 % of the close 100.
    const bull = bars([[99.5, 99.9, 99.4, 99.8], [99.8, 100.3, 99.7, 100.2], [100.2, 100.5, 100, 100]]);
    expect([...run(() => new FairValueGaps(opts({ minGapPct: 0.1 })), bull).zones.values()]).toMatchObject([{ kind: 'bullish', bottom: 99.9, top: 100 }]);
    // 100.1 - 100 = 0.09999999999999432 as well.
    const bear = bars([[100.5, 100.6, 100.1, 100.2], [100.2, 100.3, 99.8, 99.9], [99.9, 100, 99.5, 100]]);
    expect([...run(() => new FairValueGaps(opts({ minGapPct: 0.1 })), bear).zones.values()]).toMatchObject([{ kind: 'bearish', bottom: 100, top: 100.1 }]);
    // Clearly below the minimum is still rejected.
    const small = bars([[99.5, 99.91, 99.4, 99.8], [99.8, 100.3, 99.7, 100.2], [100.2, 100.5, 100, 100]]);
    expect(run(() => new FairValueGaps(opts({ minGapPct: 0.1 })), small).zones.size).toBe(0);
  });

  it('overlapping gaps on consecutive bars are separate zones, both active and both counted for "inside"', () => {
    // bar 2: a = bar 0 (high 10) < c.low 10.8 -> [10, 10.8]; bar 3: a = bar 1 (high 10.2) < c.low 10.9 -> [10.2, 10.9].
    const b = bars([[9, 10, 8, 9.5], [9.5, 10.2, 9.4, 10.1], [10.1, 14, 10.8, 13], [13, 15, 10.9, 14.5], [14.5, 14.6, 10.1, 10.15]]);
    const r = run(() => new FairValueGaps(opts()), b);
    const zs = [...r.zones.values()];
    expect(zs.map((z) => [z.bottom, z.top])).toEqual([[10, 10.8], [10.2, 10.9]]);
    // bar 3's low 10.9 touches the new gap's top: overlap is inclusive.
    expect(r.values[3]).toMatchObject({ newBull: true, inBull: true });
    // bar 4 closes 10.15: through [10.2, 10.9] (mitigated) but inside [10, 10.8], which stays active.
    expect(r.values[4]).toMatchObject({ bullMitigated: true, inBull: true, bullTop: 10.8, bullBottom: 10 });
    expect(zs.map((z) => z.endReason ?? null)).toEqual([null, 'mitigated']);
  });

  it('a gap is never mitigated on the bar it forms; an older gap can be mitigated on the bar a new opposite gap forms', () => {
    // bar 2 forms bullish [10, 11]; bar 4 closes 8 (< 10: mitigates it) and forms bearish: a = bar 2 low 11 > c.high 9.
    const b = bars([[9, 10, 8, 9.5], [9.5, 12, 9.4, 11.8], [11.8, 12.5, 11, 12.2], [12.2, 12.3, 11.5, 11.6], [11.6, 9, 7.5, 8]]);
    const r = run(() => new FairValueGaps(opts()), b);
    expect(r.values[2]).toMatchObject({ newBull: true, bullMitigated: false });
    expect(r.values[4]).toMatchObject({ bullMitigated: true, newBear: true, bearMitigated: false, bearTop: 11, bearBottom: 9 });
    const bear = [...r.zones.values()].find((z) => z.kind === 'bearish')!;
    expect(bear.endTime).toBeNull();
  });

  it('bearish mirror: mitigated by a close above the top; maxActive and maxAge apply', () => {
    const b = bars([[12, 12.5, 11, 11.2], [11.2, 11.3, 9, 9.2], [9.2, 10, 8.5, 9], [9, 10.8, 8.9, 10.5], [10.5, 11.6, 10.4, 11.5]]);
    const r = run(() => new FairValueGaps(opts()), b);
    const z = [...r.zones.values()][0];
    expect(z).toMatchObject({ kind: 'bearish', top: 11, bottom: 10, label: 'FVG-' });
    expect(r.values[3]).toMatchObject({ inBear: true, bearMitigated: false });
    expect(r.values[4]).toMatchObject({ bearMitigated: true });
    // maxAgeBars 1: known on bar 2, still active on bar 3 (age 1), expired on bar 4 (age 2) unless mitigated first.
    const hold = bars([[12, 12.5, 11, 11.2], [11.2, 11.3, 9, 9.2], [9.2, 10, 8.5, 9], [9, 9.5, 8.9, 9.1], [9.1, 9.4, 9, 9.2]]);
    const aged = run(() => new FairValueGaps(opts({ maxAgeBars: 1 })), hold);
    expect(aged.values[3].bearTop).toBe(11);
    expect([...aged.zones.values()][0]).toMatchObject({ endReason: 'expired', endTime: 4 * HOUR });
    expect(aged.values[4].bearTop).toBeNaN();
    // maxActive 1: a second bearish gap evicts the first.
    const two = bars([[12, 12.5, 11, 11.2], [11.2, 11.3, 9, 9.2], [9.2, 10, 8.5, 9], [9, 9.1, 7, 7.2], [7.2, 7.4, 6, 6.5]]);
    const ev = run(() => new FairValueGaps(opts({ maxActive: 1 })), two);
    const zs = [...ev.zones.values()].sort((x, y) => x.id - y.id);
    expect(zs.length).toBeGreaterThanOrEqual(2);
    expect(zs[0]).toMatchObject({ endReason: 'evicted', endTime: zs[1].knownTime });
  });
});

it('performance: 10k bars through all three indicators well under a second', () => {
  const b: ZoneBar[] = [];
  for (let k = 0; b.length < 10_000; k++) b.push(...shape(SHAPES[k % SHAPES.length], 520));
  const ten = b.slice(0, 10_000).map((x, i) => ({ ...x, time: i * HOUR }));
  const start = performance.now();
  const s = new SwingStructure();
  const ob = new OrderBlocks();
  const fvg = new FairValueGaps();
  for (const bar of ten) {
    s.update(bar);
    ob.update(bar);
    fvg.update(bar);
  }
  const ms = performance.now() - start;
  expect(ms).toBeLessThan(500);
  expect(ob.activeCount('bullish')).toBeLessThanOrEqual(5);
  expect(fvg.activeCount('bearish')).toBeLessThanOrEqual(5);
});

describe('change of character (CHoCH)', () => {
  // left = right = 1. SH 12 (bar 1, known bar 2); bar 3 closes 12.5 > 12: first break -> BOS up. SL 9.5 (bar 2, known
  // bar 3); bar 5 closes 9.2 < 9.5 after an up break -> CHoCH down. SL 8.5 (bar 6, known bar 7); bar 8 closes 8.2:
  // down after down -> BOS down. SH 10.5 (bar 7, known bar 8, superseding SH 13); bar 9 closes 10.8 -> CHoCH up.
  const b = bars([
    [9.5, 10, 9, 9.5], [9.5, 12, 10, 11], [11, 11, 9.5, 10], [10, 13, 10, 12.5], [12.5, 12.8, 11, 11.5], [11.5, 11.6, 9, 9.2],
    [9.2, 10, 8.5, 9.8], [9.8, 10.5, 9.6, 10.2], [10.2, 10.4, 8, 8.2], [8.2, 11, 8.1, 10.8], [10.8, 12, 10.5, 11.8],
  ]);
  const flags = (v: Array<Omit<ReturnType<SwingStructure['update']>, 'events'>>, t: number) =>
    [v[t].bosUp, v[t].chochUp, v[t].bosDown, v[t].chochDown].map(Number).join('');

  it('hand example: BOS up, CHoCH down, BOS down, CHoCH up (bos up / choch up / bos down / choch down per bar)', () => {
    const v = run(() => new SwingStructure(1, 1), b).values;
    expect(v.map((_, t) => flags(v, t))).toEqual([
      '0000', '0000', '0000', '1000', '0000', '0001', '0000', '0000', '0010', '0100', '0000',
    ]);
    // The broken levels end as 'broken' whichever kind of break it was.
    const ended = [...run(() => new SwingStructure(1, 1), b).zones.values()].filter((z) => z.endReason === 'broken').map((z) => [z.label, z.top, z.endTime! / HOUR]);
    expect(ended).toEqual([['SH', 12, 3], ['SL', 9.5, 5], ['SL', 8.5, 8], ['SH', 10.5, 9]]);
  });

  it('every break is exactly one of BOS / CHoCH; together they are exactly the closes through an unbroken level', () => {
    let chochs = 0;
    for (const shapeName of SHAPES) {
      const b2 = shape(shapeName);
      for (const [l, r] of [[5, 5], [3, 2], [1, 1]]) {
        const v = run(() => new SwingStructure(l, r), b2).values;
        const ref = refSwing(b2, l, r);
        v.forEach((x, t) => {
          expect(x.bosUp && x.chochUp).toBe(false);
          expect(x.bosDown && x.chochDown).toBe(false);
          // Breaks alternate classification exactly as the reference (written independently, index based).
          expect(x.bosUp || x.chochUp).toBe(ref.bosUp[t] || ref.chochUp[t]);
          expect(x.bosDown || x.chochDown).toBe(ref.bosDown[t] || ref.chochDown[t]);
        });
        chochs += v.filter((x) => x.chochUp || x.chochDown).length;
      }
    }
    expect(chochs).toBeGreaterThan(20); // the fixtures exercise CHoCH
  });

  it('a CHoCH needs a previous break the other way: the first break is always a BOS', () => {
    for (const shapeName of SHAPES) {
      const v = run(() => new SwingStructure(3, 2), shape(shapeName)).values;
      const firstBreak = v.find((x) => x.bosUp || x.bosDown || x.chochUp || x.chochDown);
      if (firstBreak) expect(firstBreak.chochUp || firstBreak.chochDown).toBe(false);
    }
  });

  it('no look-ahead: CHoCH / BOS on bars[0..t] equal the full run at every t (prefix invariance)', () => {
    for (const shapeName of ['chop', 'gaps']) {
      const b2 = shape(shapeName);
      const full = run(() => new SwingStructure(3, 2), b2).values;
      for (let t = 0; t < b2.length; t++) {
        const prefix = run(() => new SwingStructure(3, 2), b2.slice(0, t + 1)).values;
        expect([prefix[t].bosUp, prefix[t].bosDown, prefix[t].chochUp, prefix[t].chochDown], `bar ${t}`)
          .toEqual([full[t].bosUp, full[t].bosDown, full[t].chochUp, full[t].chochDown]);
      }
    }
  });

  it('order blocks still form on every break (BOS or CHoCH)', () => {
    const o = { swingLength: 1, lookback: 3, useBody: false, maxActive: 5, maxAgeBars: 300 };
    const v = run(() => new OrderBlocks(o), b).values;
    // Bullish breaks on bars 3 (BOS) and 9 (CHoCH); bearish on 5 (CHoCH) and 8 (BOS).
    expect(v.map((x, t) => (x.newBull ? `+${t}` : x.newBear ? `-${t}` : '')).filter(Boolean)).toEqual(['+3', '-5', '-8', '+9']);
  });
});

describe('any break (the pre-CHoCH BOS meaning)', () => {
  it('breakUp / breakDown fire on every break (BOS or CHoCH), equal to the old bosUp / bosDown on every fixture', () => {
    for (const shapeName of SHAPES) {
      const b2 = shape(shapeName);
      for (const [l, r] of [[5, 5], [3, 2], [1, 1]]) {
        const v = run(() => new SwingStructure(l, r), b2).values;
        const ref = refSwing(b2, l, r);
        expect(v.map((x) => x.breakUp)).toEqual(ref.breakUp);
        expect(v.map((x) => x.breakDown)).toEqual(ref.breakDown);
        v.forEach((x) => {
          expect(x.breakUp).toBe(x.bosUp || x.chochUp);
          expect(x.breakDown).toBe(x.bosDown || x.chochDown);
        });
      }
    }
  });

  it('no look-ahead: breakUp / breakDown on bars[0..t] equal the full run at every t', () => {
    for (const shapeName of ['trend', 'ties']) {
      const b2 = shape(shapeName);
      const full = run(() => new SwingStructure(3, 2), b2).values;
      for (let t = 0; t < b2.length; t++) {
        const prefix = run(() => new SwingStructure(3, 2), b2.slice(0, t + 1)).values;
        expect([prefix[t].breakUp, prefix[t].breakDown], `bar ${t}`).toEqual([full[t].breakUp, full[t].breakDown]);
      }
    }
  });
});

import { describe, expect, it } from 'vitest';
import type { ZoneEvent } from '../blocks/registry';
import { syntheticCandles } from '../engine/syntheticCandles';
import { blockIndicatorOverlays, defaultIndicatorUse, liveSessionOverlays, zoneToggleOverlays } from './blockOverlays';
import { dedupeOverlaySignals } from './overlays';
import { getIndicator } from '../blocks/registry';
import { MAX_DRAWN_ZONES, ZoneStore, zoneColors, zoneRects, type ZoneViewport } from './zoneGeometry';

const HOUR = 3_600_000;
const zone = (id: number, startBar: number, knownBar: number, endBar: number | null, top = 110, bottom = 100, kind: ZoneEvent['kind'] = 'bullish'): ZoneEvent => ({
  id, kind, top, bottom, startTime: startBar * HOUR, knownTime: knownBar * HOUR, endTime: endBar === null ? null : endBar * HOUR, label: 'OB+',
});

/** 10 px per bar, bar 0 at x = 5; price 0..200 maps to y 400..0. */
const view = (over: Partial<ZoneViewport> = {}): ZoneViewport => ({
  timeToX: (t) => (t / HOUR) * 10 + 5,
  priceToY: (p) => 400 - p * 2,
  lastTime: 99 * HOUR,
  halfBar: 5,
  width: 1000,
  height: 400,
  ...over,
});

describe('ZoneStore', () => {
  it('upserts lifecycle events by id', () => {
    const s = new ZoneStore('orderBlock');
    expect(s.apply([])).toBe(false);
    s.apply([zone(1, 0, 2, null)]);
    s.apply([zone(1, 0, 2, 9)]);
    expect([...s.zones()]).toEqual([zone(1, 0, 2, 9)]);
  });

  it('keeps memory bounded: the oldest ENDED zones are forgotten beyond the cap, active ones never', () => {
    const s = new ZoneStore('fvg', 10);
    s.apply([zone(0, 0, 0, null)]); // stays active
    for (let i = 1; i <= 50; i++) s.apply([zone(i, i, i, i + 1)]);
    expect(s.size).toBe(10);
    const ids = [...s.zones()].map((z) => z.id);
    expect(ids[0]).toBe(0);
    expect(ids.slice(1)).toEqual([42, 43, 44, 45, 46, 47, 48, 49, 50]);
  });
});

describe('zoneRects geometry', () => {
  it('spans whole candles from the origin bar to the end bar (or the last bar while active), y from the prices', () => {
    const s = new ZoneStore('orderBlock');
    s.apply([zone(1, 2, 4, 8, 150, 100), zone(2, 10, 12, null, 120, 110)]);
    const rects = zoneRects([s], view());
    expect(rects.map(({ x1, x2, y1, y2, ended }) => ({ x1, x2, y1, y2, ended }))).toEqual([
      { x1: 20, x2: 90, y1: 100, y2: 200, ended: true },
      { x1: 100, x2: 1000, y1: 160, y2: 180, ended: false }, // extends to bar 99
    ]);
  });

  it('skips zones entirely off-screen (left, right, above, below) and ones whose times are unknown', () => {
    const s = new ZoneStore('fvg');
    s.apply([
      zone(1, 0, 1, 3), // x 0..40
      zone(2, 0, 1, 3, 150, 140), // same x, but y 100..120
      zone(3, 200, 201, 205), // x 1995+: right of the view
      zone(4, 10, 11, 20, 500, 450), // above the top (negative y)
      zone(5, 10, 11, 20, -10, -50), // below the bottom
      zone(6, 30, 31, 35),
    ]);
    const shifted = view({ timeToX: (t) => (t / HOUR) * 10 + 5 - 100 }); // scrolled: bars 0..3 left of x = 0
    expect(zoneRects([s], shifted).map((r) => r.id)).toEqual([6]);
    expect(zoneRects([s], view()).map((r) => r.id)).toEqual([1, 2, 6]);
    const unknown = view({ timeToX: (t) => (t === 30 * HOUR ? null : (t / HOUR) * 10 + 5) });
    expect(zoneRects([s], unknown).map((r) => r.id)).toEqual([1, 2]);
  });

  it('draws at most the cap, keeping the most recently formed visible zones, oldest first', () => {
    const s = new ZoneStore('orderBlock', 10_000);
    for (let i = 0; i < 500; i++) s.apply([zone(i, i % 90, (i % 90) + 1, (i % 90) + 3, 110, 100)]);
    const rects = zoneRects([s], view());
    expect(rects.length).toBe(MAX_DRAWN_ZONES);
    const known = rects.map((r) => r.knownTime);
    expect(known).toEqual([...known].sort((a, b) => a - b));
    // Every zone not drawn was formed no later than every drawn one.
    const minDrawn = Math.min(...known);
    const drawn = new Set(rects.map((r) => r.id));
    for (const z of s.zones()) if (!drawn.has(z.id)) expect(z.knownTime).toBeLessThanOrEqual(minDrawn);
    expect(zoneRects([s], view(), 5)).toHaveLength(5);
  });

  it('swing levels are flat (y1 === y2); colours differ by style, kind and ended', () => {
    const s = new ZoneStore('swing');
    s.apply([{ ...zone(1, 2, 7, null, 120, 120, 'bearish'), label: 'SH' }]);
    const [r] = zoneRects([s], view());
    expect(r.y1).toBe(r.y2);
    expect(zoneColors('orderBlock', 'bullish', false).fill).not.toBe(zoneColors('fvg', 'bullish', false).fill);
    expect(zoneColors('orderBlock', 'bullish', false).fill).not.toBe(zoneColors('orderBlock', 'bearish', false).fill);
    expect(zoneColors('fvg', 'bearish', true).fill).not.toBe(zoneColors('fvg', 'bearish', false).fill);
  });
});

describe('zone overlays', () => {
  const candles = syntheticCandles(400).map((c, i) => ({ ...c, open: c.open + (i % 7) * 0.3 - 1, close: c.close + (i % 5) * 0.5 - 1 }));

  it('a zone indicator used by a strategy draws zones (no lines) and its stepper reports the zone events', () => {
    const use = { ...defaultIndicatorUse(getIndicator('orderblock')!), signals: ['in_bull'] };
    const [o] = blockIndicatorOverlays([use]);
    expect(o.lines).toEqual([]);
    expect(o.zones).toBe('orderBlock');
    expect(o.zoneKey).toMatch(/^orderblock\(/);
    expect(o.signals).toBeUndefined(); // 'inside' has no marker: the box shows it
    const step = o.create();
    const store = new ZoneStore('orderBlock');
    for (const c of candles) {
      step(c);
      store.apply(step.zones?.() ?? []);
    }
    expect(store.size).toBeGreaterThan(0);
  });

  it('picker toggles: Order blocks, FVG, Swing structure with default settings; swing marks breaks of structure', () => {
    const toggles = zoneToggleOverlays();
    expect(toggles.map((d) => [d.id, d.label, d.zones])).toEqual([
      ['zones-orderblock', 'Order blocks', 'orderBlock'], ['zones-fvg', 'FVG', 'fvg'], ['zones-swing', 'Swing structure', 'swing'],
    ]);
    expect(toggles[2].signals?.map((s) => s.key)).toEqual(['bos_up', 'bos_down', 'choch_up', 'choch_down']);
    // Same zone key as a strategy's default-settings use: the chart draws those zones once.
    const [strategy] = blockIndicatorOverlays([defaultIndicatorUse(getIndicator('fvg')!)]);
    expect(toggles[1].zoneKey).toBe(strategy.zoneKey);
  });

  it('live session overlays keep a zone toggle next to the session\'s own (its zones are deduplicated by the chart)', () => {
    const session = blockIndicatorOverlays([{ ...defaultIndicatorUse(getIndicator('swing')!), signals: ['bos_up', 'bos_down', 'choch_up', 'choch_down'] }]);
    const out = liveSessionOverlays(session, zoneToggleOverlays());
    const swing = out.find((d) => d.id === 'zones-swing')!;
    expect(swing.signals).toBeUndefined(); // the session already marks all BOS / CHoCH signals
    expect(swing.zoneKey).toBe(session[0].zoneKey);
    expect(out.map((d) => d.id)).toContain('zones-orderblock');
  });
});

describe('signal markers are drawn once per distinct signal (backtest and live)', () => {
  it('a strategy using swing BOS up plus the Swing structure toggle marks BOS up once; other settings stay separate', () => {
    const swing = getIndicator('swing')!;
    const strategy = blockIndicatorOverlays([{ ...defaultIndicatorUse(swing), signals: ['bos_up'] }]);
    const other = blockIndicatorOverlays([{ ...defaultIndicatorUse(swing), params: { left: 3, right: 3 }, signals: ['bos_up'] }]);
    const out = dedupeOverlaySignals([...strategy, ...other, ...zoneToggleOverlays()]);
    const marked = out.flatMap((d) => (d.signals ?? []).map((s) => `${d.id}:${s.key}`));
    expect(marked.filter((m) => m.endsWith(':bos_up'))).toHaveLength(2); // default 5/5 once + 3/3 once
    expect(marked.filter((m) => m.endsWith(':bos_down'))).toEqual(['zones-swing:bos_down']);
    // The toggle overlay stays (its zones are deduplicated by zoneKey in the chart), only without the duplicate marker.
    expect(out.map((d) => d.id)).toContain('zones-swing');
    expect(out.length).toBe(strategy.length + other.length + zoneToggleOverlays().length);
  });
});

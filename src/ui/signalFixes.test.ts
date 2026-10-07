import { afterEach, describe, it, expect } from 'vitest';
import { getIndicator } from '../blocks/registry';
import { syncPineIndicators } from '../pine/library';
import { EMA_CROSS_SIGNALS_SOURCE } from '../pine/templates';
import { blockIndicatorOverlays, defaultIndicatorUse, liveSessionOverlays } from './blockOverlays';
import { smaOverlay } from './overlays';

/** Regression tests for review findings on chart signals (one describe per finding). */

afterEach(() => {
  syncPineIndicators([]);
});

/** Every (indicator, signal) pair the chart would mark, with how often. */
const drawnSignals = (defs: ReturnType<typeof liveSessionOverlays>) =>
  defs.flatMap((d) => (d.signals ?? []).map((s) => `${d.indicatorId}|${s.key}`)).sort();

describe('finding 5: a live session never marks a signal twice', () => {
  it('a script both used by the session and shown on the chart draws each signal once', () => {
    syncPineIndicators([{ id: 'pine_ema_cross_signals', source: EMA_CROSS_SIGNALS_SOURCE }]);
    const def = getIndicator('pine_ema_cross_signals')!;
    // The session uses the Buy signal (default settings); the Pine tab shows the script (all signals).
    const session = blockIndicatorOverlays([{ ...defaultIndicatorUse(def), blockId: 'b', signals: ['buy'] }]);
    const extra = [...blockIndicatorOverlays([defaultIndicatorUse(def)]), smaOverlay(20, '#fff')];
    const all = liveSessionOverlays(session, extra);
    expect(drawnSignals(all)).toEqual(['pine_ema_cross_signals|buy', 'pine_ema_cross_signals|sell']);
    // The shown copy keeps only what the session does not draw; picked overlays are untouched.
    expect(all.map((d) => d.id)).toEqual([session[0].id, extra[0].id, 'sma20']);
  });

  it('a shown script whose signals are all drawn by the session (same settings) is not drawn a second time', () => {
    syncPineIndicators([{ id: 'pine_ema_cross_signals', source: EMA_CROSS_SIGNALS_SOURCE }]);
    const def = getIndicator('pine_ema_cross_signals')!;
    const session = blockIndicatorOverlays([defaultIndicatorUse(def)]);
    const all = liveSessionOverlays(session, blockIndicatorOverlays([defaultIndicatorUse(def)]));
    expect(all.length).toBe(1);
    expect(drawnSignals(all)).toEqual(['pine_ema_cross_signals|buy', 'pine_ema_cross_signals|sell']);
  });
});

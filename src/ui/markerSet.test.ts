import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts';
import { describe, expect, it } from 'vitest';
import { MarkerSet } from './markerSet';
import { MAX_MARKERS_PER_SIGNAL, MAX_TEXT_MARKERS, mergeMarkers, signalMarkers, type SignalHit, type SignalMarkerStyle } from './markers';

type M = SeriesMarker<UTCTimestamp>;
const mk = (t: number, text: string): M => ({ time: t as UTCTimestamp, position: 'aboveBar', shape: 'circle', color: '#fff', text });

/** Deterministic pseudo-random numbers. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

describe('MarkerSet', () => {
  it('equals mergeMarkers of its groups (rank order) after any mix of replaces and appends', () => {
    const rand = rng(7);
    const set = new MarkerSet();
    const groups: M[][] = [[], [], []];
    let t = 0;
    for (let step = 0; step < 400; step++) {
      const g = Math.floor(rand() * 3);
      if (rand() < 0.1) {
        const list = Array.from({ length: Math.floor(rand() * 6) }, (_, i) => mk(Math.floor(rand() * 50) * 60 + i * 0, `r${step}.${i}`)).sort((a, b) => a.time - b.time);
        groups[g] = list;
        set.setGroup(`g${g}`, g, list);
      } else {
        if (rand() < 0.6) t += 60; // live bars move forward; some appends land on an existing time
        const m = mk(t, `a${step}`);
        groups[g] = [...groups[g], m];
        set.append(`g${g}`, g, [m]);
      }
      expect(set.list()).toEqual(mergeMarkers(...groups));
    }
  });

  it('a cap drops the group\'s oldest markers, like signalMarkers keeps the most recent', () => {
    const set = new MarkerSet();
    set.setGroup('trades', 0, [mk(0, 'Buy'), mk(5, 'Sell')]);
    for (let i = 1; i <= 8; i++) set.append('sig', 1, [mk(i, `s${i}`)], 3);
    expect(set.list().map((m) => m.text)).toEqual(['Buy', 'Sell', 's6', 's7', 's8']);
    expect(set.size).toBe(5);
  });

  it('ties at one time: lower rank first, then insertion order (trades before signals)', () => {
    const set = new MarkerSet();
    set.append('sig', 2, [mk(10, 'second signal')]);
    set.append('sig1', 1, [mk(10, 'first signal')]);
    set.append('trades', 0, [mk(10, 'Buy')]);
    set.append('sig1', 1, [mk(10, 'first signal again')]);
    expect(set.list().map((m) => m.text)).toEqual(['Buy', 'first signal', 'first signal again', 'second signal']);
  });

  it('replacing one group leaves the others untouched; removing a group clears it', () => {
    const set = new MarkerSet();
    set.setGroup('a', 0, [mk(1, 'a1'), mk(3, 'a3')]);
    set.setGroup('b', 1, [mk(2, 'b2')]);
    set.setGroup('a', 0, [mk(4, 'a4')]);
    expect(set.list().map((m) => m.text)).toEqual(['b2', 'a4']);
    set.setGroup('b', 1, []);
    expect(set.list().map((m) => m.text)).toEqual(['a4']);
    set.clear();
    expect(set.list()).toEqual([]);
  });

  it('live signal hits appended one by one == the full rebuild, across the text and count caps', () => {
    const style: SignalMarkerStyle = { shape: 'arrowUp', location: 'belowBar', color: '#0f0', text: 'Long' };
    const set = new MarkerSet();
    const hits: SignalHit[] = [];
    const total = MAX_MARKERS_PER_SIGNAL + 40;
    const trades = [mk(0, 'Buy')];
    set.setGroup('trades', 0, trades);
    for (let i = 0; i < total; i++) {
      const hit = { time: (i + 1) * 60_000, price: NaN };
      hits.push(hit);
      // What the chart does per live bar: append, except when the text cap is crossed (the whole signal loses text).
      if (hits.length === MAX_TEXT_MARKERS + 1) set.setGroup('sig', 1, signalMarkers(style, hits, 'sig0:long'));
      else set.append('sig', 1, signalMarkers(style, [hit], 'sig0:long', hits.length), MAX_MARKERS_PER_SIGNAL);
      if (i % 97 === 0 || i === MAX_TEXT_MARKERS || i === total - 1) {
        expect(set.list()).toEqual(mergeMarkers(trades, signalMarkers(style, hits, 'sig0:long')));
      }
    }
    expect(set.size).toBe(1 + MAX_MARKERS_PER_SIGNAL);
  });
});

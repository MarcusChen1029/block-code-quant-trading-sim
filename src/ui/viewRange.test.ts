import { describe, expect, it } from 'vitest';
import { parseSavedView, preserveRange, restoreSavedView, saveView } from './viewRange';

const M = 60_000;
/** Bar open times for bar indexes [a, b] (minutes). */
const bars = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => (a + i) * M);

describe('preserveRange (bars replaced under the user, e.g. a gap fill)', () => {
  it('a zoomed-in view of older bars stays on the same bars, even when bars are inserted before the visible ones', () => {
    // Before: bars 0..99 with 110..119 (a gap 100..109). The user looks at bars 40..60.
    const before = [...bars(0, 99), ...bars(110, 119)];
    const after = bars(0, 119); // gap filled
    expect(preserveRange(before, { from: 40, to: 60 }, after)).toEqual({ kind: 'range', from: 40, to: 60 });
    // Looking at the bars right after the hole (indexes 100..105 = bars 110..115): they moved by 10 indexes.
    expect(preserveRange(before, { from: 100.4, to: 105.6 }, after)).toEqual({ kind: 'range', from: 110.4, to: 115.6 });
  });

  it('a view at the latest bar keeps following it with the same width (and right margin)', () => {
    const before = [...bars(0, 99), 105 * M]; // forming bar 105 after a reconnect, bars 100..104 missing
    const after = bars(0, 105);
    expect(preserveRange(before, { from: 70, to: 102.5 }, after)).toEqual({ kind: 'range', from: 75, to: 107.5 });
    expect(preserveRange(before, { from: 70.2, to: 100 }, after)).toEqual({ kind: 'range', from: 75.2, to: 105 });
  });

  it('a view that showed every bar keeps showing every bar (fit)', () => {
    expect(preserveRange(bars(0, 99), { from: -0.5, to: 99.5 }, bars(0, 300))).toEqual({ kind: 'fit' });
    expect(preserveRange(bars(0, 99), { from: -5, to: 120 }, bars(0, 300))).toEqual({ kind: 'fit' });
  });

  it('nothing to keep: fit', () => {
    expect(preserveRange([], { from: 0, to: 10 }, bars(0, 10))).toEqual({ kind: 'fit' });
    expect(preserveRange(bars(0, 10), null, bars(0, 10))).toEqual({ kind: 'fit' });
    expect(preserveRange(bars(0, 10), { from: 2, to: 5 }, [])).toEqual({ kind: 'fit' });
  });

  it('the anchor bar vanished (history replaced): the first bar at or after its time', () => {
    expect(preserveRange(bars(0, 99), { from: 10, to: 20 }, bars(15, 99))).toEqual({ kind: 'range', from: 0, to: 10 });
  });
});

describe('saved views (kept across a reload)', () => {
  it('a following view is restored at the latest bar with its width', () => {
    const saved = saveView(bars(0, 99), { from: 80, to: 101 })!;
    expect(saved).toEqual({ following: true, fromTime: 80 * M, toTime: 99 * M, width: 21, rightOffset: 2 });
    expect(restoreSavedView(saved, bars(0, 150))).toEqual({ from: 131, to: 152 });
  });

  it('a view of older bars waits until those bars are loaded, then shows them again', () => {
    const saved = saveView(bars(0, 199), { from: 40, to: 60 })!;
    expect(saved.following).toBe(false);
    expect(restoreSavedView(saved, bars(0, 30))).toBeNull(); // still catching up
    expect(restoreSavedView(saved, bars(0, 400))).toEqual({ from: 40, to: 60 });
    expect(restoreSavedView(saved, bars(20, 400))).toEqual({ from: 20, to: 40 });
  });

  it('a fitted view is not saved (the default is to fit)', () => {
    expect(saveView(bars(0, 99), { from: -1, to: 100 })).toBeNull();
  });

  it('parses only well-formed stored views', () => {
    const saved = saveView(bars(0, 199), { from: 40, to: 60 })!;
    expect(parseSavedView(JSON.parse(JSON.stringify(saved)))).toEqual(saved);
    expect(parseSavedView({ following: 'yes' })).toBeNull();
    expect(parseSavedView(null)).toBeNull();
    expect(parseSavedView({ following: false, fromTime: 1, toTime: NaN, width: 2, rightOffset: 0 })).toBeNull();
  });
});

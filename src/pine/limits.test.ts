import { describe, it, expect } from 'vitest';
import type { RuntimeLimits } from '../blocks/runtime';
import { syntheticCandles } from '../engine/syntheticCandles';
import { compileOk, script } from './testing';

const BAR = syntheticCandles(1)[0];
const LOOPY = compileOk(script(`
s = 0
for i = 1 to 9000
    s += i
plot(s, "s")
`));

/** A clock that advances `stepMs` every time it is read. */
function fakeClock(stepMs: number): () => number {
  let t = 0;
  return () => (t += stepMs);
}

describe('Pine per-bar limits (same as block strategies)', () => {
  it('a bar whose loops run longer than maxBarMs halts with a positioned error', () => {
    const limits: RuntimeLimits = { maxIterationsPerBar: 10_000, maxBarMs: 1000, now: fakeClock(50) };
    const inst = LOOPY.create({}, limits);
    expect(() => inst.step(undefined, BAR)).toThrow('Pine script "Test", line 4: one bar took longer than 1000 ms');
  });

  it('within the time budget the same loop completes', () => {
    const inst = LOOPY.create({}, { maxIterationsPerBar: 10_000, maxBarMs: 1000, now: fakeClock(0) });
    expect(inst.step(undefined, BAR).s).toBe((9000 * 9001) / 2);
  });

  it('the iteration cap still applies', () => {
    const inst = LOOPY.create({}, { maxIterationsPerBar: 100, maxBarMs: 1000, now: fakeClock(0) });
    expect(() => inst.step(undefined, BAR)).toThrow('more than 100 loop iterations in one bar');
  });

  it('the budget resets every bar', () => {
    let t = 0;
    const now = () => t;
    const inst = LOOPY.create({}, { maxIterationsPerBar: 10_000, maxBarMs: 1000, now });
    for (let bar = 0; bar < 3; bar++) {
      t += 900; // time passes between bars, but each bar itself is instant
      expect(inst.step(undefined, BAR).s).toBe((9000 * 9001) / 2);
    }
  });
});

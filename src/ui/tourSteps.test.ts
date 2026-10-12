import { describe, expect, it } from 'vitest';
import { availableSteps, stepAfter, TOUR_STEPS } from './tourSteps';

describe('tour', () => {
  it('has a text for every step and unique targets', () => {
    for (const s of TOUR_STEPS) expect(s.title && s.text.length > 30).toBeTruthy();
    const targets = TOUR_STEPS.map((s) => s.target).filter((t) => t !== null);
    expect(new Set(targets).size).toBe(targets.length);
  });

  it('skips steps whose target is not on screen', () => {
    const steps = availableSteps(TOUR_STEPS, (t) => t !== 'chart');
    expect(steps.some((s) => s.target === 'chart')).toBe(false);
    expect(steps[0].target).toBeNull();
    expect(steps.length).toBe(TOUR_STEPS.length - 1);
  });

  it('moves forward and back; back from the first step goes nowhere', () => {
    expect(stepAfter(0, 1)).toBe(1);
    expect(stepAfter(3, -1)).toBe(2);
    expect(stepAfter(0, -1)).toBeNull();
    expect(stepAfter(4, 1)).toBe(5); // one past the end: the caller finishes
  });
});

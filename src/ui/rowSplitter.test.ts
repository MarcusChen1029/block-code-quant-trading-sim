import { describe, expect, it } from 'vitest';
import { clampResultsHeight } from './layout';

describe('results height', () => {
  it('keeps the results and the chart usable', () => {
    expect(clampResultsHeight(300, 800)).toBe(300);
    expect(clampResultsHeight(50, 800)).toBe(150);
    expect(clampResultsHeight(900, 800)).toBe(600);
    expect(clampResultsHeight(400, 300)).toBe(150); // tiny window: the minimum wins
  });
});

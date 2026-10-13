import { describe, expect, it } from 'vitest';
import { laterStartNote } from './historyStart';

const HOUR = 3_600_000;
const SEP1 = Date.UTC(2026, 8, 1, 9);

describe('later start note', () => {
  it('says where the test really started when the prices begin later', () => {
    expect(laterStartNote(Date.UTC(2026, 5, 1), SEP1, HOUR)).toBe('Prices only go back to 1 September 2026, so the test started there. Any start date before that gives the same result.');
  });

  it('stays quiet when the data covers the start date', () => {
    expect(laterStartNote(SEP1, SEP1, HOUR)).toBeNull();
    expect(laterStartNote(SEP1 - HOUR / 2, SEP1, HOUR)).toBeNull();
    expect(laterStartNote(SEP1, undefined, HOUR)).toBeNull();
  });
});

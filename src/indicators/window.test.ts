import { describe, it, expect } from 'vitest';
import { RingBuffer } from './window';

describe('RingBuffer', () => {
  it('keeps the newest values and reports evictions', () => {
    const rb = new RingBuffer(3);
    expect(rb.push(1)).toBeNaN();
    expect(rb.push(2)).toBeNaN();
    expect(rb.full).toBe(false);
    expect(rb.push(3)).toBeNaN();
    expect(rb.full).toBe(true);
    expect(rb.push(4)).toBe(1);
    expect([rb.get(0), rb.get(1), rb.get(2)]).toEqual([4, 3, 2]);
    expect(rb.get(3)).toBeNaN();
    expect(rb.sum()).toBe(9);
    expect(rb.size).toBe(3);
  });
});

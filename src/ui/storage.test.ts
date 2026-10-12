import { describe, expect, it } from 'vitest';
import { clearOwnData } from './storage';

/** The slice of Storage that clearOwnData uses, over a plain map. */
function fakeStorage(entries: Record<string, string>) {
  const map = new Map(Object.entries(entries));
  return {
    map,
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => { map.delete(k); },
  };
}

describe('clearOwnData', () => {
  it('removes only the keys the app saved', () => {
    const s = fakeStorage({ 'quant-sim.theme': 'dark', 'quant-sim.blocks.workspace.v1': '{}', 'other-app.x': '1', quant: '2' });
    expect(clearOwnData(s)).toBe(2);
    expect([...s.map.keys()]).toEqual(['other-app.x', 'quant']);
  });

  it('survives a storage that throws', () => {
    const broken = { get length(): number { throw new Error('blocked'); }, key: () => null, removeItem: () => {} };
    expect(clearOwnData(broken)).toBe(0);
  });
});

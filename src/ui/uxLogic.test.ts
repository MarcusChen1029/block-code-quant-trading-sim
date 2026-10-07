import { describe, it, expect } from 'vitest';
import { accountSummary } from './accountSummary';
import { clampFraction, fractionForKey, fractionFromPointer, fractionRange, parseStoredFraction, SPLIT } from './splitter';
import { isEmptyWorkspace, LAST_STARTER_KEY, PREVIOUS_WORKSPACE_KEY, StarterMemory, type KeyValueStore } from './starterMemory';

const DEF = { leverage: '1', takerFeePct: '0.04', makerFeePct: '0.02', slippageBps: '2' };

describe('accountSummary', () => {
  it('summarises the defaults, not highlighted', () => {
    expect(accountSummary(DEF)).toEqual({ text: 'Leverage 1x · fees 0.04%/0.02% · slippage 2 bps', nonDefault: false });
  });

  it('treats equal numbers typed differently as default', () => {
    expect(accountSummary({ leverage: '1.0', takerFeePct: ' 0.040', makerFeePct: '.02', slippageBps: '2' }).nonDefault).toBe(false);
  });

  it('highlights any changed value', () => {
    expect(accountSummary({ ...DEF, leverage: '5' })).toEqual({ text: 'Leverage 5x · fees 0.04%/0.02% · slippage 2 bps', nonDefault: true });
    expect(accountSummary({ ...DEF, slippageBps: '0' }).nonDefault).toBe(true);
    expect(accountSummary({ ...DEF, makerFeePct: '0.01' }).text).toBe('Leverage 1x · fees 0.04%/0.01% · slippage 2 bps');
  });

  it('shows blanks as ? and counts them as changed', () => {
    expect(accountSummary({ ...DEF, takerFeePct: '' })).toEqual({ text: 'Leverage 1x · fees ?%/0.02% · slippage 2 bps', nonDefault: true });
  });

  it('mentions the built-in strategy choice', () => {
    expect(accountSummary(DEF, true)).toEqual({ text: 'Leverage 1x · fees 0.04%/0.02% · slippage 2 bps · runs the built-in SMA cross', nonDefault: true });
  });
});

describe('splitter geometry', () => {
  it('clamps to the pixel minimums of both panes', () => {
    expect(fractionRange(2000)).toEqual({ min: 320 / 2000, max: 1 - 420 / 2000 });
    expect(clampFraction(0.05, 2000)).toBe(0.16);
    expect(clampFraction(0.95, 2000)).toBe(0.79);
    expect(clampFraction(0.45, 2000)).toBe(0.45);
    expect(clampFraction(NaN, 2000)).toBe(SPLIT.defaultFraction);
  });

  it('stays in the middle when the layout is too narrow for both minimums', () => {
    expect(clampFraction(0.2, 600)).toBe(0.5);
    expect(clampFraction(0.3, 0)).toBe(SPLIT.defaultFraction);
  });

  it('maps a pointer position to a clamped fraction', () => {
    expect(fractionFromPointer(600, 100, 1000)).toBeCloseTo(0.5, 12);
    expect(fractionFromPointer(110, 100, 1000)).toBeCloseTo(0.32, 12);
    expect(fractionFromPointer(1090, 100, 1000)).toBeCloseTo(0.58, 12);
  });

  it('resizes with arrow keys (Shift = big step), Home/End jump to the limits, Enter resets', () => {
    expect(fractionForKey(0.45, 'ArrowRight', false, 2000)).toBeCloseTo(0.47, 12);
    expect(fractionForKey(0.45, 'ArrowLeft', true, 2000)).toBeCloseTo(0.35, 12);
    expect(fractionForKey(0.45, 'PageDown', false, 2000)).toBeCloseTo(0.55, 12);
    expect(fractionForKey(0.17, 'ArrowLeft', false, 2000)).toBe(0.16);
    expect(fractionForKey(0.45, 'Home', false, 2000)).toBe(0.16);
    expect(fractionForKey(0.45, 'End', false, 2000)).toBe(0.79);
    expect(fractionForKey(0.7, 'Enter', false, 2000)).toBe(0.45);
    expect(fractionForKey(0.45, 'a', false, 2000)).toBeNull();
  });

  it('reads back only sane stored values', () => {
    expect(parseStoredFraction('0.52')).toBe(0.52);
    expect(parseStoredFraction(0.3)).toBe(0.3);
    for (const bad of [null, undefined, '', 'abc', '0', '1', '1.5', -0.2, NaN]) expect(parseStoredFraction(bad)).toBeNull();
  });
});

function memoryStore(): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return { data, get: (k) => (data.has(k) ? structuredClone(data.get(k)) : undefined), set: (k, v) => { data.set(k, structuredClone(v)); return true; } };
}

describe('StarterMemory (previous workspace)', () => {
  const ws = (name: string) => ({ blocks: { blocks: [{ type: 'event_bar', id: name }] } });

  it('a fresh user with nothing recorded is asked before replacing a non-empty workspace, and it is saved', () => {
    const m = new StarterMemory(memoryStore());
    expect(m.planLoad(JSON.stringify(ws('mine')), false)).toEqual({ confirm: true, savePrevious: true });
    expect(m.planLoad('{}', true)).toEqual({ confirm: false, savePrevious: false }); // empty: nothing to lose
  });

  it('an untouched starter is replaced silently; an edited one asks and is kept', () => {
    const m = new StarterMemory(memoryStore());
    const loaded = JSON.stringify(ws('sma'));
    m.recordLoaded('smaCross', loaded);
    expect(m.planLoad(loaded, false)).toEqual({ confirm: false, savePrevious: false });
    expect(m.planLoad(JSON.stringify(ws('sma-edited')), false)).toEqual({ confirm: true, savePrevious: true });
  });

  it('saves the previous workspace and restores it by swapping (no data loss either way)', () => {
    const store = memoryStore();
    const m = new StarterMemory(store);
    expect(m.previous).toBeNull();
    m.savePrevious(ws('mine'), 1000);
    m.recordLoaded('rsiReversion', JSON.stringify(ws('rsi')));
    expect(m.previous).toEqual({ workspace: ws('mine'), savedAt: 1000 });

    // Restore: the RSI starter now showing becomes the previous one; the next starter pick asks again.
    const restored = m.previous!.workspace;
    expect(m.completeRestore(ws('rsi'), 2000)).toBe(true);
    expect(restored).toEqual(ws('mine'));
    expect(m.previous).toEqual({ workspace: ws('rsi'), savedAt: 2000 });
    expect(m.last).toBeNull();
    expect(m.isModified(JSON.stringify(ws('mine')))).toBe(true);
    expect(store.data.has(PREVIOUS_WORKSPACE_KEY) && store.data.has(LAST_STARTER_KEY)).toBe(true);
  });

  it('ignores malformed stored values', () => {
    const store = memoryStore();
    store.set(LAST_STARTER_KEY, { id: 3 });
    store.set(PREVIOUS_WORKSPACE_KEY, { workspace: null, savedAt: 1 });
    const m = new StarterMemory(store);
    expect(m.last).toBeNull();
    expect(m.previous).toBeNull();
  });

  it('detects empty workspaces', () => {
    expect(isEmptyWorkspace({ blocks: { blocks: [] } })).toBe(true);
    expect(isEmptyWorkspace({})).toBe(true);
    expect(isEmptyWorkspace(ws('x'))).toBe(false);
  });
});

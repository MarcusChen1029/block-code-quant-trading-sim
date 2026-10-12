import { describe, it, expect } from 'vitest';
import { ResultTracker, STALE_NOTE, freshness, type RunKey } from './resultFreshness';

const key = (strategy = 'blocks:A', settings = 'S1'): RunKey => ({ strategy, settings });

describe('freshness', () => {
  it('is none without shown results', () => {
    expect(freshness(null, key())).toEqual({ status: 'none' });
  });

  it('is fresh while strategy and settings are what the results were run with', () => {
    expect(freshness(key(), key())).toEqual({ status: 'fresh' });
  });

  it('is stale after a block edit (strategy differs), naming the strategy', () => {
    expect(freshness(key('blocks:A'), key('blocks:B'))).toEqual({ status: 'stale', reason: 'strategy' });
  });

  it('is stale after a settings change, naming the settings', () => {
    expect(freshness(key(), key('blocks:A', 'S2'))).toEqual({ status: 'stale', reason: 'settings' });
  });

  it('a strategy change wins over a settings change', () => {
    expect(freshness(key(), key('smaCross', 'S2'))).toEqual({ status: 'stale', reason: 'strategy' });
  });
});

describe('ResultTracker', () => {
  it('starts with nothing shown', () => {
    expect(new ResultTracker().check(key())).toEqual({ status: 'none' });
  });

  it('a finished run is fresh; an edit makes it stale; undoing the edit makes it fresh again', () => {
    const t = new ResultTracker();
    t.ranWith(key());
    expect(t.check(key())).toEqual({ status: 'fresh' });
    expect(t.check(key('blocks:B'))).toEqual({ status: 'stale', reason: 'strategy' });
    expect(t.check(key())).toEqual({ status: 'fresh' });
  });

  it('loading a starter or a previous workspace discards the results: none, even if it equals what ran', () => {
    const t = new ResultTracker();
    t.ranWith(key());
    t.discard();
    expect(t.check(key())).toEqual({ status: 'none' });
    expect(t.check(key('blocks:B'))).toEqual({ status: 'none' }); // the starter's own change event cannot mark anything stale
  });

  it('a new run replaces the key', () => {
    const t = new ResultTracker();
    t.ranWith(key());
    t.ranWith(key('blocks:B', 'S2'));
    expect(t.check(key('blocks:B', 'S2'))).toEqual({ status: 'fresh' });
    expect(t.check(key())).toEqual({ status: 'stale', reason: 'strategy' });
  });

  it('has a plain note per stale reason', () => {
    expect(STALE_NOTE.strategy).toBe('These results are from your strategy before it changed. Press ▶ Run test to update them.');
    expect(STALE_NOTE.settings).toBe('These results are for the settings before you changed them. Press ▶ Run test to update them.');
  });
});

describe('workspaceKey (what a block strategy run depends on)', () => {
  it('ignores where blocks sit on the canvas (dragging is not an edit), but not what they say', async () => {
    const { workspaceKey } = await import('./resultFreshness');
    const { getStarter } = await import('../blocks/starters');
    const ws = getStarter('smaCross')!.build();
    const moved = structuredClone(ws);
    moved.blocks!.blocks![0].x = 400;
    moved.blocks!.blocks![1].y = 900;
    expect(JSON.stringify(moved)).not.toBe(JSON.stringify(ws)); // the raw JSON (the old key) changes on a drag
    expect(workspaceKey(moved)).toBe(workspaceKey(ws));
    const edited = structuredClone(ws);
    edited.blocks!.blocks![1].next!.block!.id = 'other';
    expect(workspaceKey(edited)).not.toBe(workspaceKey(ws));
    expect(workspaceKey({ blocks: { blocks: [{ type: 'math_number', id: 'n', x: 1, y: 2, fields: { NUM: 5 } }] } }))
      .toBe('{"blocks":{"blocks":[{"type":"math_number","id":"n","fields":{"NUM":5}}]}}');
  });
});

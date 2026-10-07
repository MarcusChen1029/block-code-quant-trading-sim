import { describe, it, expect } from 'vitest';
import { pickStarter, restorePrevious, type FlowDeps } from './starterFlow';
import { StarterMemory, type KeyValueStore } from './starterMemory';

/** Workspace JSON with one recognisable block. */
const ws = (name: string) => ({ blocks: { languageVersion: 0, blocks: [{ type: 'event_bar', id: name }] } });
const nameOf = (w: unknown) => (w as ReturnType<typeof ws>).blocks.blocks[0].id;
const starter = (id: 'smaCross' | 'rsiReversion' | 'macdCross', label: string) => ({ id, label, description: `${label} desc.`, build: () => ws(id) });
const A = starter('smaCross', 'SMA 10/30 cross');
const B = starter('rsiReversion', 'RSI oversold/overbought (mean reversion)');
const C = starter('macdCross', 'MACD cross');

function memoryStore(failWrites = false): KeyValueStore & { data: Map<string, unknown> } {
  const data = new Map<string, unknown>();
  return {
    data,
    get: (k) => (data.has(k) ? structuredClone(data.get(k)) : undefined),
    set: (k, v) => {
      if (failWrites) return false;
      data.set(k, structuredClone(v));
      return true;
    },
  };
}

function harness(opts: { store?: KeyValueStore; failLoad?: boolean } = {}) {
  let current: unknown = ws('W');
  let clock = 1_000;
  const confirms: string[] = [];
  const statuses: Array<[string, boolean]> = [];
  const store = opts.store ?? memoryStore();
  const memory = new StarterMemory(store);
  const deps: FlowDeps = {
    editor: {
      save: () => structuredClone(current),
      loadWorkspace: (state) => {
        if (opts.failLoad) return false;
        current = structuredClone(state);
        return true;
      },
    },
    memory,
    confirm: (m) => { confirms.push(m); return true; },
    status: (m, isError = false) => statuses.push([m, isError]),
    now: () => (clock += 60_000),
  };
  return {
    deps, memory, confirms, statuses, store,
    get current() { return nameOf(current); },
    edit(name: string) { current = ws(name); },
  };
}

const previousNames = (m: StarterMemory) => m.previousList.map((p) => nameOf(p.workspace));

describe('starter flow: previous workspaces', () => {
  it('W -> pick A -> edit A -> pick B keeps W (and the edited A)', () => {
    const h = harness();
    expect(pickStarter(h.deps, A)).toBe(true); // W is the user's own work
    h.edit('A-edited');
    expect(pickStarter(h.deps, B)).toBe(true);
    expect(h.current).toBe('rsiReversion');
    expect(previousNames(h.memory)).toEqual(['A-edited', 'W']);
    expect(h.memory.previousList.map((p) => p.label)).toEqual(['Edited SMA 10/30 cross', 'Your blocks']);
  });

  it('an untouched starter is replaced without a confirm and without a slot', () => {
    const h = harness();
    pickStarter(h.deps, A);
    const confirmsBefore = h.confirms.length;
    pickStarter(h.deps, B);
    expect(h.confirms.length).toBe(confirmsBefore);
    expect(previousNames(h.memory)).toEqual(['W']);
  });

  it('keeps the last 3, evicts only the oldest, and says so in the confirm', () => {
    const h = harness();
    for (const [i, s] of [A, B, C, A].entries()) {
      if (i > 0) h.edit(`edit-${i}`);
      pickStarter(h.deps, s);
    }
    expect(previousNames(h.memory)).toEqual(['edit-3', 'edit-2', 'edit-1']);
    expect(h.confirms[h.confirms.length - 1]).toContain('keeps your last 3');
    expect(h.confirms[h.confirms.length - 1]).toContain('Your blocks'); // names the one that is dropped
    expect(h.confirms[0]).not.toContain('dropped');
  });

  it('a failed load leaves the slots exactly as they were', () => {
    const store = memoryStore();
    const ok = harness({ store });
    pickStarter(ok.deps, A);
    const before = JSON.stringify(ok.memory.previousList);
    const failing = harness({ store, failLoad: true });
    failing.edit('mine');
    expect(pickStarter(failing.deps, B)).toBe(false);
    expect(JSON.stringify(failing.memory.previousList)).toBe(before);
  });

  it('restore brings a chosen previous workspace back and keeps the current one', () => {
    const h = harness();
    pickStarter(h.deps, A);
    h.edit('A-edited');
    pickStarter(h.deps, B); // previous: [A-edited, W]
    const w = h.memory.previousList[1];
    expect(restorePrevious(h.deps, w.id)).toBe(true);
    expect(h.current).toBe('W');
    expect(previousNames(h.memory)).toEqual(['A-edited']); // B was untouched: nothing to keep
    h.edit('W-edited');
    expect(restorePrevious(h.deps, h.memory.previousList[0].id)).toBe(true);
    expect(h.current).toBe('A-edited');
    expect(previousNames(h.memory)).toEqual(['W-edited']);
  });

  it('tells the user when the workspace cannot be kept (storage throws)', () => {
    const h = harness({ store: memoryStore(true) });
    const answers = [true, false]; // replace? yes. "could not be saved, replace anyway?" no
    h.deps.confirm = (m) => { h.confirms.push(m); return answers.shift()!; };
    expect(pickStarter(h.deps, A)).toBe(false);
    expect(h.confirms[1]).toMatch(/could not be saved/);
    expect(h.current).toBe('W');
  });

  it('restore reports truthfully when browser storage refuses the update', () => {
    const store = memoryStore();
    const h = harness({ store });
    pickStarter(h.deps, A); // previous: [W]
    const id = h.memory.previousList[0].id;
    store.set = () => false; // storage now throws / is full
    const answers = [false]; // "could not be saved... restore anyway?" -> no
    h.deps.confirm = (m) => { h.confirms.push(m); return answers.shift() ?? true; };
    h.edit('A-edited');
    expect(restorePrevious(h.deps, id)).toBe(false);
    expect(h.current).toBe('A-edited'); // nothing replaced
    expect(h.statuses.at(-1)).toEqual(['Kept your blocks: browser storage refused to save them, so nothing was restored.', true]);

    // Restoring over an untouched starter (nothing to keep) still works, but says the list could not be updated.
    const h2 = harness({ store: memoryStore() });
    pickStarter(h2.deps, A);
    const id2 = h2.memory.previousList[0].id;
    (h2.store as KeyValueStore).set = () => false;
    expect(restorePrevious(h2.deps, id2)).toBe(true);
    expect(h2.current).toBe('W');
    const [message, isError] = h2.statuses.at(-1)!;
    expect(isError).toBe(true);
    expect(message).toMatch(/browser storage refused the update/);
    expect(message).not.toMatch(/are kept as/);
  });

  it('migrates the earlier single previous slot into the list', () => {
    const store = memoryStore();
    store.set('quant-sim.blocks.previous.v1', { workspace: ws('old'), savedAt: 5 });
    const m = new StarterMemory(store);
    expect(m.previousList).toEqual([{ id: 'p-5', workspace: ws('old'), savedAt: 5, label: 'Your blocks' }]);
  });
});

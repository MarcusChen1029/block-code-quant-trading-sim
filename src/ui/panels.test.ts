import { describe, expect, it } from 'vitest';
import {
  canHide, exitFull, INITIAL_PANELS, isFull, isHidden, listedPanels, parsePanelState, showAll, storablePanels, toggleFull, toggleHidden,
} from './panels';

describe('panel state', () => {
  it('starts with everything shown', () => {
    expect(INITIAL_PANELS).toEqual({ hidden: [], full: null });
  });

  it('hides and shows a panel', () => {
    const hidden = toggleHidden(INITIAL_PANELS, 'chart');
    expect(isHidden(hidden, 'chart')).toBe(true);
    expect(isHidden(toggleHidden(hidden, 'chart'), 'chart')).toBe(false);
  });

  it('never hides the last open main panel', () => {
    let s = toggleHidden(INITIAL_PANELS, 'strategy');
    s = toggleHidden(s, 'chart');
    expect(canHide(s, 'results')).toBe(false);
    expect(toggleHidden(s, 'results')).toBe(s);
    expect(canHide(s, 'chart')).toBe(true); // showing is always allowed
    expect(canHide(s, 'live')).toBe(true); // the live panel is not a main panel
    expect(isHidden(toggleHidden(s, 'live'), 'live')).toBe(true);
  });

  it('full page shows a hidden panel and toggles back', () => {
    const hidden = toggleHidden(INITIAL_PANELS, 'chart');
    const full = toggleFull(hidden, 'chart');
    expect(isFull(full, 'chart')).toBe(true);
    expect(isHidden(full, 'chart')).toBe(false);
    expect(toggleFull(full, 'chart').full).toBeNull();
    expect(toggleFull(full, 'results').full).toBe('results'); // another panel takes over
    expect(exitFull(full).full).toBeNull();
    expect(exitFull(INITIAL_PANELS)).toBe(INITIAL_PANELS);
  });

  it('hiding the full-page panel leaves full page', () => {
    const full = toggleFull(INITIAL_PANELS, 'chart');
    expect(toggleHidden(full, 'chart')).toEqual({ hidden: ['chart'], full: null });
  });

  it('showAll resets', () => {
    expect(showAll()).toEqual(INITIAL_PANELS);
  });

  it('stores only the hidden list', () => {
    expect(storablePanels({ hidden: ['chart'], full: 'results' })).toEqual({ hidden: ['chart'] });
  });

  it('parses stored state defensively', () => {
    expect(parsePanelState(undefined)).toEqual(INITIAL_PANELS);
    expect(parsePanelState('x')).toEqual(INITIAL_PANELS);
    expect(parsePanelState({ hidden: 'chart' })).toEqual(INITIAL_PANELS);
    expect(parsePanelState({ hidden: ['chart', 'bogus', 'chart', 'live'] })).toEqual({ hidden: ['chart', 'live'], full: null });
  });

  it('a stored state that hides every main panel keeps the first one open', () => {
    const s = parsePanelState({ hidden: ['strategy', 'chart', 'results', 'live'] });
    expect(s.hidden).toEqual(['chart', 'results', 'live']);
  });

  it('lists the live panel only in live mode', () => {
    expect(listedPanels(false)).toEqual(['strategy', 'chart', 'results']);
    expect(listedPanels(true)).toEqual(['strategy', 'chart', 'results', 'live']);
  });
});

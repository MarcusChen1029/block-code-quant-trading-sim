import { describe, expect, it } from 'vitest';
import { DEFAULT_PANELS, exitFull, parsePanelState, toggleCollapsed, toggleFull } from './panelState';

describe('panel state', () => {
  it('hides and shows a panel', () => {
    const hidden = toggleCollapsed(DEFAULT_PANELS, 'strategy');
    expect(hidden.collapsed).toEqual(['strategy']);
    expect(toggleCollapsed(hidden, 'strategy').collapsed).toEqual([]);
  });

  it('never leaves the chart + results column empty', () => {
    const noChart = toggleCollapsed(DEFAULT_PANELS, 'chart');
    expect(toggleCollapsed(noChart, 'results').collapsed).toEqual(['results']);
  });

  it('full page un-hides the panel, and a second press leaves full page', () => {
    const s = toggleFull(toggleCollapsed(DEFAULT_PANELS, 'results'), 'results');
    expect(s).toEqual({ collapsed: [], full: 'results' });
    expect(toggleFull(s, 'results').full).toBeNull();
    expect(toggleFull(s, 'chart').full).toBe('chart');
  });

  it('hiding the full-page panel leaves full page', () => {
    const s = toggleCollapsed(toggleFull(DEFAULT_PANELS, 'chart'), 'chart');
    expect(s).toEqual({ collapsed: ['chart'], full: null });
    expect(exitFull(toggleFull(DEFAULT_PANELS, 'strategy')).full).toBeNull();
  });

  it('restores only valid saved state, and never full page', () => {
    expect(parsePanelState(null)).toEqual(DEFAULT_PANELS);
    expect(parsePanelState({ collapsed: 'chart' })).toEqual(DEFAULT_PANELS);
    expect(parsePanelState({ collapsed: ['bogus', 'strategy'], full: 'chart' })).toEqual({ collapsed: ['strategy'], full: null });
    expect(parsePanelState({ collapsed: ['chart', 'results'] }).collapsed).toEqual(['results']);
  });
});

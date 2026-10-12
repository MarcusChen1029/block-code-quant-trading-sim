/** The three work areas that can be hidden or shown full page. */
export type PanelId = 'strategy' | 'chart' | 'results';
export const PANEL_IDS: readonly PanelId[] = ['strategy', 'chart', 'results'];

export interface PanelState {
  /** Panels folded down to their header (the strategy panel to a thin strip at the left edge). */
  readonly collapsed: readonly PanelId[];
  /** The panel shown over the whole page, if any. */
  readonly full: PanelId | null;
}

export const DEFAULT_PANELS: PanelState = { collapsed: [], full: null };

/** The panel that shares the right-hand column with `id` (chart <-> results); null for the strategy panel. */
function partner(id: PanelId): PanelId | null {
  return id === 'chart' ? 'results' : id === 'results' ? 'chart' : null;
}

/**
 * Hides or shows `id`. Hiding the panel shown full page also leaves full page. The chart and results share one
 * column, so hiding one while the other is already hidden shows the other: that column is never left empty.
 */
export function toggleCollapsed(state: PanelState, id: PanelId): PanelState {
  if (state.collapsed.includes(id)) return { ...state, collapsed: state.collapsed.filter((p) => p !== id) };
  const other = partner(id);
  const collapsed = [...state.collapsed.filter((p) => p !== other), id];
  return { collapsed, full: state.full === id ? null : state.full };
}

/** Shows `id` full page (it is un-hidden first), or leaves full page when it already is. */
export function toggleFull(state: PanelState, id: PanelId): PanelState {
  if (state.full === id) return { ...state, full: null };
  return { collapsed: state.collapsed.filter((p) => p !== id), full: id };
}

export function exitFull(state: PanelState): PanelState {
  return state.full === null ? state : { ...state, full: null };
}

/** Saved state from storage; anything unexpected falls back to the defaults (full page is never restored). */
export function parsePanelState(raw: unknown): PanelState {
  if (typeof raw !== 'object' || raw === null) return DEFAULT_PANELS;
  const list = (raw as { collapsed?: unknown }).collapsed;
  if (!Array.isArray(list)) return DEFAULT_PANELS;
  let state = DEFAULT_PANELS;
  for (const id of PANEL_IDS) if (list.includes(id)) state = toggleCollapsed(state, id);
  return state;
}

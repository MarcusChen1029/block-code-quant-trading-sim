/**
 * Which page panels are hidden, and which one (if any) fills the whole page. Pure state, no DOM: the DOM side is
 * panelChrome.ts. Stored in localStorage as `{ hidden: [...] }` (a full-page panel is never restored on reload).
 */
export const PANEL_IDS = ['strategy', 'chart', 'results', 'live'] as const;
export type PanelId = (typeof PANEL_IDS)[number];

/** The panels that make up the workspace; at least one of them always stays open so the page is never empty. */
export const MAIN_PANELS: readonly PanelId[] = ['strategy', 'chart', 'results'];

export interface PanelState {
  readonly hidden: readonly PanelId[];
  readonly full: PanelId | null;
}

export const INITIAL_PANELS: PanelState = { hidden: [], full: null };

const isPanelId = (v: unknown): v is PanelId => typeof v === 'string' && (PANEL_IDS as readonly string[]).includes(v);

/** Reads what localStorage held; anything unexpected means "nothing hidden". */
export function parsePanelState(raw: unknown): PanelState {
  if (typeof raw !== 'object' || raw === null) return INITIAL_PANELS;
  const list = (raw as { hidden?: unknown }).hidden;
  if (!Array.isArray(list)) return INITIAL_PANELS;
  const hidden = PANEL_IDS.filter((id) => list.includes(id));
  // A saved state that hides every main panel would show an empty page: keep the first one open.
  const open = MAIN_PANELS.filter((id) => !hidden.includes(id));
  return { hidden: open.length === 0 ? hidden.filter((id) => id !== MAIN_PANELS[0]) : hidden, full: null };
}

/** What is stored (the full-page panel is a temporary view, not a preference). */
export function storablePanels(state: PanelState): { hidden: PanelId[] } {
  return { hidden: [...state.hidden] };
}

export const isHidden = (state: PanelState, id: PanelId): boolean => state.hidden.includes(id);
export const isFull = (state: PanelState, id: PanelId): boolean => state.full === id;

/** True when `id` can be hidden now: the last open main panel cannot be. */
export function canHide(state: PanelState, id: PanelId): boolean {
  if (isHidden(state, id)) return true;
  if (!MAIN_PANELS.includes(id)) return true;
  return MAIN_PANELS.some((other) => other !== id && !isHidden(state, other));
}

/** Hides or shows a panel; a refused hide (the last main panel) returns the same state. Hiding the full-page panel leaves full page. */
export function toggleHidden(state: PanelState, id: PanelId): PanelState {
  if (isHidden(state, id)) return { ...state, hidden: state.hidden.filter((h) => h !== id) };
  if (!canHide(state, id)) return state;
  return { hidden: [...state.hidden, id], full: state.full === id ? null : state.full };
}

/** Puts a panel on the whole page (showing it first if it was hidden), or brings it back when it already is. */
export function toggleFull(state: PanelState, id: PanelId): PanelState {
  if (state.full === id) return { ...state, full: null };
  return { hidden: state.hidden.filter((h) => h !== id), full: id };
}

/** Makes sure `id` is on screen: shown if it was hidden, and not covered by another panel's full page. */
export function reveal(state: PanelState, id: PanelId): PanelState {
  const hidden = state.hidden.filter((h) => h !== id);
  const full = state.full === id ? id : null;
  return hidden.length === state.hidden.length && full === state.full ? state : { hidden, full };
}

export const exitFull = (state: PanelState): PanelState => (state.full === null ? state : { ...state, full: null });

export const showAll = (): PanelState => INITIAL_PANELS;

/** Panels the "View" menu lists (the live panel only exists while Live mode is on). */
export function listedPanels(liveMode: boolean): PanelId[] {
  return PANEL_IDS.filter((id) => id !== 'live' || liveMode);
}

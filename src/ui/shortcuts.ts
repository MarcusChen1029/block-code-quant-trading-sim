import type { PanelId } from './panels';

/** What a keyboard shortcut asks for. The DOM side (main.ts) turns it into a call. */
export type ShortcutAction =
  | { type: 'run' }
  | { type: 'help' }
  | { type: 'theme' }
  | { type: 'tour' }
  | { type: 'exit-full' }
  | { type: 'toggle-hidden'; panel: PanelId }
  | { type: 'toggle-full'; panel: PanelId };

export interface KeyInfo {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  /** The element that has focus: shortcuts that are plain letters never fire while typing. */
  typing: boolean;
  /** Focus is inside the block editor (Blockly has keys of its own there). */
  inBlocks: boolean;
}

const PANEL_BY_DIGIT: Record<string, PanelId> = { Digit1: 'strategy', Digit2: 'chart', Digit3: 'results', Digit4: 'live' };

/** The action for a key press, or null when the key is not ours. Pure, so the table below is tested. */
export function shortcutFor(k: KeyInfo): ShortcutAction | null {
  const mod = k.ctrlKey || k.metaKey;
  if (mod && !k.altKey && k.key === 'Enter') return { type: 'run' };
  if (k.key === 'Escape') return { type: 'exit-full' };
  if (mod || k.altKey) return null;
  if (k.typing) return null;
  if (k.key === '?' || (k.key === '/' && k.shiftKey)) return { type: 'help' };
  if (k.inBlocks) return null;
  const digit = PANEL_BY_DIGIT[k.code];
  if (digit) return { type: k.shiftKey ? 'toggle-full' : 'toggle-hidden', panel: digit };
  if (k.shiftKey) return null;
  switch (k.key.toLowerCase()) {
    case 'r': return { type: 'run' };
    case 't': return { type: 'theme' };
    case 'h': return { type: 'help' };
    case 'g': return { type: 'tour' };
    default: return null;
  }
}

/** The shortcut list shown in the Help window (keys, then what they do). */
export const SHORTCUT_HELP: ReadonlyArray<{ keys: string; text: string }> = [
  { keys: 'R  or  Ctrl + Enter', text: 'Run the backtest' },
  { keys: '1  2  3  4', text: 'Hide or show the Strategy, Chart, Results and Live panels' },
  { keys: 'Shift + 1  2  3  4', text: 'Put that panel on the whole page (press again to go back)' },
  { keys: 'Esc', text: 'Leave full page, or close a window' },
  { keys: 'T', text: 'Switch between dark and light colors' },
  { keys: 'H  or  ?', text: 'Open this Help window' },
  { keys: 'G', text: 'Start the guided tour' },
];

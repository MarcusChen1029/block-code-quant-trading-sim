export type ShortcutId = 'run' | 'help' | 'toggleStrategy' | 'toggleResults' | 'fullChart' | 'theme';

export interface ShortcutDoc {
  keys: string[];
  what: string;
}

/** Shown in Help › Keyboard. Includes keys handled elsewhere (Escape, the editors' own undo and save). */
export const SHORTCUT_DOCS: readonly ShortcutDoc[] = [
  { keys: ['Ctrl', 'Enter'], what: 'Run the test (⌘ Enter on a Mac)' },
  { keys: ['?'], what: 'Open this help window' },
  { keys: ['['], what: 'Hide or show the strategy panel' },
  { keys: [']'], what: 'Hide or show the results panel' },
  { keys: ['F'], what: 'Show the chart full page (again to go back)' },
  { keys: ['Esc'], what: 'Leave full page, or close a menu or window' },
  { keys: ['D'], what: 'Switch between dark and light colours' },
  { keys: ['Ctrl', 'Z'], what: 'Undo a change to your blocks (Ctrl Shift Z to redo)' },
  { keys: ['Ctrl', 'S'], what: 'In the Pine tab: check and save the script' },
];

export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/**
 * The app shortcut a key press means, or null. Single keys only count outside text fields and the block
 * workspace (where they are typing or Blockly's own keys); Ctrl/⌘ + Enter works everywhere.
 */
export function matchShortcut(ev: KeyLike, typing: boolean): ShortcutId | null {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') return 'run';
  if (typing || ev.ctrlKey || ev.metaKey || ev.altKey) return null;
  switch (ev.key) {
    case '?': return 'help';
    case '[': return 'toggleStrategy';
    case ']': return 'toggleResults';
    case 'f': case 'F': return 'fullChart';
    case 'd': case 'D': return 'theme';
    default: return null;
  }
}

/** True when keys typed at `el` belong to it: text fields, selects, editable content, the Blockly workspace. */
export function isTypingTarget(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color'].includes(el.type);
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return el.closest('.injectionDiv, .blocklyWidgetDiv, .blocklyDropDownDiv') !== null;
}

/** Listens for the shortcuts and calls the matching handler (an open dialog keeps its own keys). */
export function initShortcuts(handlers: Record<ShortcutId, () => void>): void {
  document.addEventListener('keydown', (ev) => {
    if (ev.defaultPrevented || ev.repeat) return;
    const id = matchShortcut(ev, isTypingTarget(document.activeElement));
    if (!id) return;
    if (document.querySelector('.tour')) return; // the tour has its own keys
    if (id !== 'run' && document.querySelector('dialog[open]')) return;
    ev.preventDefault();
    handlers[id]();
  });
}

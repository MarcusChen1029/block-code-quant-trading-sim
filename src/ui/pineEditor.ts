import { PINE_SHOW_TEXT } from './descriptions';
import { setExplain } from './explain';
import { compilePine } from '../pine/compile';
import type { PineDiagnostic } from '../pine/diagnostics';
import { newPineScriptId, retirePineScript, scriptTitle, type PineRetired, type PineSourceRecord, type PineSyncResult } from '../pine/library';
import { PINE_TEMPLATES } from '../pine/templates';
import { h } from './dom';
import { loadPineDraft, savePineDraft, savePineRecords, savePineRetired } from './pineStore';

export interface PineEditorOptions {
  records: PineSourceRecord[];
  /** Tombstones of deleted scripts. */
  retired: PineRetired[];
  /** Saved scripts changed: register them and refresh the blocks; returns per-script results. */
  onChange(records: PineSourceRecord[], retired: PineRetired[]): PineSyncResult[];
  /** Saved scripts drawn on the chart with their defaults (lines + all signals), without a strategy. */
  shown: string[];
  onShowChange(ids: string[]): void;
}

export interface PineEditor {
  /** Re-measures the line-number gutter (call when the pane becomes visible). */
  refresh(): void;
}

/** Character offset of line:col (1-based) in `text`. */
export function offsetOf(text: string, line: number, col: number): number {
  let offset = 0;
  for (let l = 1; l < line; l++) {
    const next = text.indexOf('\n', offset);
    if (next < 0) return text.length;
    offset = next + 1;
  }
  return Math.min(text.length, offset + Math.max(0, col - 1));
}

const NEW_ID = '__new__';

/**
 * The Pine tab: script list, template picker, code editor with line numbers, live diagnostics (click one to
 * jump to its line), Compile & save, Delete. Saved scripts are the last version that compiled; the text being
 * edited is kept as a draft so a reload does not lose it.
 */
export function createPineEditor(container: HTMLElement, options: PineEditorOptions): PineEditor {
  let records = [...options.records];
  let retired = [...options.retired];
  let currentId: string | null = null;

  const scriptSelect = h('select', { class: 'pine-scripts', title: 'Saved Pine scripts', 'aria-label': 'Saved Pine scripts' });
  const templateSelect = h('select', { class: 'pine-templates', title: 'Start a new script from a template', 'aria-label': 'New script from template' },
    h('option', { value: '' }, 'New from template…'),
    ...PINE_TEMPLATES.map((t) => h('option', { value: t.id }, t.label)));
  const saveButton = h('button', { type: 'button', class: 'run pine-save', title: 'Compile; if it compiles, save it and update its block (Ctrl+S)' }, 'Compile & save');
  const deleteButton = h('button', { type: 'button', class: 'pine-delete', title: 'Delete this saved script' }, 'Delete');
  let shown = options.shown.filter((id) => records.some((r) => r.id === id));
  const showBox = h('input', { type: 'checkbox', class: 'pine-show-input', 'aria-label': 'Show this script on the chart' });
  setExplain(showBox, PINE_SHOW_TEXT.title, PINE_SHOW_TEXT.on, PINE_SHOW_TEXT.off);
  const showToggle = h('label', { class: 'pine-show', title: 'Draw this saved script on the chart (default inputs): its plots and its signal markers, without wiring a strategy' }, showBox, ' Show on chart');
  const gutter = h('pre', { class: 'pine-gutter', 'aria-hidden': 'true' });
  const textarea = h('textarea', { class: 'pine-code', spellcheck: 'false', autocomplete: 'off', autocapitalize: 'off', wrap: 'off', 'aria-label': 'Pine Script source' });
  const status = h('div', { class: 'pine-status' });
  const problems = h('ul', { class: 'problems pine-problems' });
  container.append(
    h('div', { class: 'pine-toolbar' }, scriptSelect, templateSelect, saveButton, deleteButton, showToggle),
    h('div', { class: 'pine-editor' }, gutter, textarea),
    status,
    problems,
    h('div', { class: 'pine-note' }, 'Pine v4 / v5 / v6 subset (//@version=4, 5 or 6): indicator() (v4: study()), inputs, ta.*, math.*, var, if/for, functions, plot(). Each plot is an output of the block (toolbox › Pine). plotshape / plotchar / alertcondition / label.new(bar_index, y, "Text") become true/false signals: a "sig" block and chart markers. Warm-up bars may differ slightly from TradingView.'),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const savedSource = () => records.find((r) => r.id === currentId)?.source ?? null;
  const dirty = () => textarea.value !== savedSource();

  const renderList = () => {
    scriptSelect.replaceChildren(
      ...records.map((r) => h('option', { value: r.id }, scriptTitle(r.source, r.id))),
      h('option', { value: NEW_ID }, currentId === null ? '(new script, not saved)' : '+ new script'),
    );
    scriptSelect.value = currentId ?? NEW_ID;
    deleteButton.disabled = currentId === null;
    showBox.disabled = currentId === null;
    showBox.checked = currentId !== null && shown.includes(currentId);
    showToggle.classList.toggle('disabled', currentId === null);
  };

  const setShown = (next: string[]) => {
    shown = next.filter((id) => records.some((r) => r.id === id));
    options.onShowChange([...shown]);
  };

  const renderGutter = () => {
    const lines = textarea.value.split('\n').length;
    gutter.textContent = Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n');
    gutter.scrollTop = textarea.scrollTop;
  };

  const jumpTo = (line: number, col: number) => {
    const start = offsetOf(textarea.value, line, col);
    const lineEnd = textarea.value.indexOf('\n', start);
    textarea.focus();
    textarea.setSelectionRange(start, lineEnd < 0 ? textarea.value.length : Math.max(lineEnd, start));
    const lineHeight = parseFloat(getComputedStyle(textarea).lineHeight) || 18;
    textarea.scrollTop = Math.max(0, (line - 3) * lineHeight);
    gutter.scrollTop = textarea.scrollTop;
  };

  const showDiagnostics = (errors: PineDiagnostic[], warnings: PineDiagnostic[]) => {
    const row = (level: 'error' | 'warn', d: PineDiagnostic) => {
      const el = h('li', { class: `problem problem-${level} clickable`, title: 'Go to this line' }, `${level === 'error' ? '✖' : '⚠'} ${d.line}:${d.col}  ${d.message}`);
      el.addEventListener('click', () => jumpTo(d.line, d.col));
      return el;
    };
    problems.replaceChildren(...errors.map((d) => row('error', d)), ...warnings.map((d) => row('warn', d)));
    problems.hidden = errors.length + warnings.length === 0;
  };

  const setStatus = (text: string, kind: 'ok' | 'error' | 'info' = 'info') => {
    status.textContent = text;
    status.className = `pine-status pine-status-${kind}`;
  };

  /** Compiles the editor text and shows its problems; returns the result. */
  const check = () => {
    const result = compilePine(textarea.value);
    showDiagnostics(result.ok ? [] : result.errors, result.warnings);
    const unsaved = dirty() ? ' (unsaved changes)' : '';
    const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
    if (result.ok) {
      setStatus(`Compiles as Pine v${result.script.version}: "${result.script.title}", ${n(result.script.plots.length, 'output')}` +
        `${result.script.signals.length > 0 ? `, ${n(result.script.signals.length, 'signal')}` : ''}${unsaved}`, 'ok');
    }
    else setStatus(`${result.errors.length} error${result.errors.length === 1 ? '' : 's'}${unsaved}`, 'error');
    return result;
  };

  const open = (id: string | null, source: string) => {
    currentId = id;
    textarea.value = source;
    textarea.scrollTop = 0;
    renderList();
    renderGutter();
    check();
    savePineDraft({ id, source });
  };

  const confirmDiscard = () => !dirty() || window.confirm('Discard the unsaved changes in the editor?');

  const save = () => {
    clearTimeout(timer); // a pending live check would overwrite the save status
    const result = check();
    if (!result.ok) {
      setStatus(`Not saved: fix the ${result.errors.length} error${result.errors.length === 1 ? '' : 's'} below first (click one to jump to it).`, 'error');
      const first = result.errors[0];
      jumpTo(first.line, first.col);
      return;
    }
    const isNew = currentId === null;
    const id = currentId ?? newPineScriptId(result.script.title, records, retired);
    const record = { id, source: textarea.value };
    records = isNew ? [...records, record] : records.map((r) => (r.id === id ? record : r));
    const stored = savePineRecords(records);
    currentId = id;
    const synced = options.onChange(records, retired).find((r) => r.id === id);
    renderList();
    savePineDraft({ id, source: textarea.value });
    check();
    if (synced?.ok) {
      setStatus(`Saved "${result.script.title}": its block is in the toolbox under Pine.${stored ? '' : ' (Browser storage is unavailable: it will not survive a reload.)'}`, 'ok');
    } else {
      setStatus('Saved, but the block could not be registered.', 'error');
    }
  };

  const remove = () => {
    if (currentId === null) return;
    const title = scriptTitle(savedSource() ?? '', currentId);
    if (!window.confirm(`Delete the Pine script "${title}"? Strategies that use its block will show an error until you remove the block.`)) return;
    ({ records, retired } = retirePineScript(records, retired, currentId));
    savePineRecords(records);
    savePineRetired(retired);
    options.onChange(records, retired);
    if (shown.includes(currentId)) setShown(shown.filter((id) => id !== currentId));
    const next = records[0];
    if (next) open(next.id, next.source);
    else open(null, PINE_TEMPLATES[0].source);
    setStatus(`Deleted "${title}".`, 'info');
  };

  textarea.addEventListener('input', () => {
    renderGutter();
    clearTimeout(timer);
    timer = setTimeout(() => {
      check();
      savePineDraft({ id: currentId, source: textarea.value });
    }, 350);
  });
  textarea.addEventListener('scroll', () => {
    gutter.scrollTop = textarea.scrollTop;
  });
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Tab' && !event.shiftKey) {
      // Insert 4 spaces (Pine block indentation) instead of leaving the editor.
      event.preventDefault();
      const { selectionStart: s, selectionEnd: e } = textarea;
      textarea.setRangeText('    ', s, e, 'end');
      textarea.dispatchEvent(new Event('input'));
    } else if (event.key === 's' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      save();
    }
  });
  saveButton.addEventListener('click', save);
  showBox.addEventListener('change', () => {
    if (currentId === null) return;
    const id = currentId;
    setShown(showBox.checked ? [...shown.filter((x) => x !== id), id] : shown.filter((x) => x !== id));
  });
  deleteButton.addEventListener('click', remove);
  scriptSelect.addEventListener('change', () => {
    const id = scriptSelect.value;
    if (!confirmDiscard()) {
      scriptSelect.value = currentId ?? NEW_ID;
      return;
    }
    if (id === NEW_ID) open(null, PINE_TEMPLATES[0].source);
    else {
      const r = records.find((x) => x.id === id);
      if (r) open(r.id, r.source);
    }
  });
  templateSelect.addEventListener('change', () => {
    const t = PINE_TEMPLATES.find((x) => x.id === templateSelect.value);
    templateSelect.value = '';
    if (!t || !confirmDiscard()) return;
    open(null, t.source);
  });

  // Restore: the draft if there is one (it may hold unsaved edits), else the first saved script, else the example.
  const draft = loadPineDraft();
  const draftRecord = draft?.id ? records.find((r) => r.id === draft.id) : undefined;
  if (draft && (draft.id === null || draftRecord)) {
    open(draft.id, draft.source);
    if (dirty()) setStatus(`${status.textContent} Unsaved edits were restored.`, status.className.includes('error') ? 'error' : 'info');
  } else if (records[0]) {
    open(records[0].id, records[0].source);
  } else {
    open(null, PINE_TEMPLATES[0].source);
  }

  return { refresh: renderGutter };
}

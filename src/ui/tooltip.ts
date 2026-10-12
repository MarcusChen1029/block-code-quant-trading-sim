import { h } from './dom';

/**
 * One floating tooltip for the whole page. Any element with `data-tip="text"` gets it on hover or keyboard focus;
 * an element with a plain `title` is upgraded the first time it is hovered (the native, slow, unstyled tooltip is
 * removed so the two never show together). Anything inside the block editor is left alone (Blockly has its own).
 */
const SHOW_DELAY_MS = 350;
const GAP = 8;

let tip: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let owner: Element | null = null;
/** A finger tap also sends mouse events; those must not pop a tooltip that then stays on screen. */
let lastPointer: string = 'mouse';

/** Moves a `title` into `data-tip` (and keeps the element's accessible name) and returns the text, or null. */
export function adoptTitle(el: Element): string | null {
  const title = el.getAttribute('title');
  if (title !== null && title.trim() !== '') {
    el.setAttribute('data-tip', title.trim());
    el.removeAttribute('title');
    const named = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || (el.textContent ?? '').trim() !== '';
    if (!named) el.setAttribute('aria-label', title.trim());
  }
  return el.getAttribute('data-tip');
}

function hide(): void {
  clearTimeout(timer);
  if (owner) owner.removeAttribute('aria-describedby');
  owner = null;
  if (tip) tip.hidden = true;
}

function place(target: Element): void {
  if (!tip) return;
  const r = target.getBoundingClientRect();
  tip.style.left = '0px';
  tip.style.top = '0px';
  const w = tip.offsetWidth;
  const hgt = tip.offsetHeight;
  const below = r.bottom + GAP + hgt <= window.innerHeight || r.top - GAP - hgt < 0;
  const top = below ? r.bottom + GAP : r.top - GAP - hgt;
  const left = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
  tip.style.top = `${Math.round(Math.max(8, top))}px`;
  tip.style.left = `${Math.round(left)}px`;
}

function show(target: Element): void {
  const text = adoptTitle(target);
  if (!text) return;
  if (!tip) {
    tip = h('div', { class: 'tooltip', role: 'tooltip', id: 'tooltip' });
    document.body.append(tip);
  }
  tip.textContent = text;
  tip.hidden = false;
  owner = target;
  target.setAttribute('aria-describedby', 'tooltip');
  place(target);
}

function tipTarget(node: EventTarget | null): Element | null {
  if (!(node instanceof Element)) return null;
  const el = node.closest('[data-tip], [title]');
  // Blockly draws its own tooltips on blocks; only its block-group menu is ours.
  if (!el || el.closest('.tooltip, .blocklyWidgetDiv, .blocklyDropDownDiv') || (el.closest('#blockly') && !el.closest('.blocklyToolbox'))) return null;
  return el;
}

/** Installs the listeners (once). */
export function installTooltips(): void {
  document.addEventListener('pointerdown', (ev) => { lastPointer = ev.pointerType; }, true);
  document.addEventListener('mouseover', (ev) => {
    if (lastPointer === 'touch') return;
    const el = tipTarget(ev.target);
    if (el === owner) return;
    hide();
    if (!el) return;
    adoptTitle(el); // drop the native tooltip right away, before the browser's own timer fires
    if (el.hasAttribute('data-tip')) timer = setTimeout(() => show(el), SHOW_DELAY_MS);
  });
  document.addEventListener('mouseout', (ev) => {
    const to = (ev as MouseEvent).relatedTarget;
    if (owner && to instanceof Node && owner.contains(to)) return;
    hide();
  });
  document.addEventListener('focusin', (ev) => {
    const el = tipTarget(ev.target);
    hide();
    if (el && (ev.target as Element).matches(':focus-visible')) show(el);
  });
  document.addEventListener('focusout', hide);
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hide(); });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}

import { h } from './dom';
import { loadText, saveText } from './storage';

export const HOVER_TIPS_STORAGE_KEY = 'quant-sim.hover-tips';
const HOVER_DELAY_MS = 350;

/** Where a tooltip goes: below its target unless there is no room there, and always inside the viewport. */
export function placeTip(
  target: { left: number; top: number; bottom: number; width: number },
  tip: { width: number; height: number },
  viewport: { width: number; height: number },
  gap = 8,
  margin = 8,
): { left: number; top: number; above: boolean } {
  const below = target.bottom + gap;
  const above = target.top - gap - tip.height;
  const fitsBelow = below + tip.height <= viewport.height - margin;
  const useAbove = !fitsBelow && above >= margin;
  const top = useAbove ? above : Math.max(margin, Math.min(below, viewport.height - margin - tip.height));
  const centered = target.left + target.width / 2 - tip.width / 2;
  const left = Math.max(margin, Math.min(centered, viewport.width - margin - tip.width));
  return { left: Math.round(left), top: Math.round(top), above: useAbove };
}

let hoverEnabled = loadText(HOVER_TIPS_STORAGE_KEY) !== '0';

export function hoverTipsEnabled(): boolean {
  return hoverEnabled;
}

export function setHoverTips(on: boolean): void {
  hoverEnabled = on;
  saveText(HOVER_TIPS_STORAGE_KEY, on ? '1' : '0');
}

/**
 * A small "?" button that shows `text` when tapped, clicked, hovered or focused. `label` names it for screen
 * readers ("What is leverage?"). `title` is an optional bold first line.
 */
export function infoButton(text: string, label: string, title?: string): HTMLButtonElement {
  return h('button', { type: 'button', class: 'info-btn', 'aria-label': label, 'data-tip': text, 'data-tip-title': title, 'data-tip-click': '' }, '?');
}

/** Attaches a tooltip description to `el` (instead of a native title, which is slow, unstyled and mouse-only). */
export function tip<T extends HTMLElement>(el: T, text: string, title?: string): T {
  el.removeAttribute('title');
  el.dataset.tip = text;
  if (title) el.dataset.tipTitle = title;
  else delete el.dataset.tipTitle;
  return el;
}

/**
 * Turns every `title` and `data-tip` on the page into one styled, accessible tooltip: shown after a short hover
 * with a mouse, at once on keyboard focus, and on a tap for "?" info buttons (`data-tip-click`). A native title
 * found under the pointer is moved to data-tip first, so the browser's own tooltip never doubles it. Code that
 * sets `title` again later still works: the new text is picked up on the next hover.
 */
export function initTooltips(): void {
  const bubble = h('div', { class: 'tip', id: 'app-tip', role: 'tooltip', hidden: '' });
  const heading = h('div', { class: 'tip-title' });
  const body = h('div', { class: 'tip-body' });
  bubble.append(heading, body);
  document.body.append(bubble);

  let current: HTMLElement | null = null;
  let pinned = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  /** The element whose description applies to `node` (skips SVG: Blockly draws its own tooltips). */
  const source = (node: EventTarget | null): HTMLElement | null => {
    if (!(node instanceof Element)) return null;
    const el = node.closest<HTMLElement>('[data-tip], [title]');
    if (!el || !(el instanceof HTMLElement) || el.closest('.blocklySvg, .blocklyWidgetDiv')) return null;
    return el;
  };

  /** Moves a native title to data-tip (keeping an accessible name when the element had none). */
  const adopt = (el: HTMLElement): string => {
    const title = el.getAttribute('title');
    if (title) {
      el.dataset.tip = title;
      el.removeAttribute('title');
      const named = el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') || (el.textContent ?? '').trim() !== '';
      if (!named) el.setAttribute('aria-label', title);
    }
    return el.dataset.tip ?? '';
  };

  const hide = () => {
    clearTimeout(timer);
    if (current) {
      current.removeAttribute('aria-describedby');
      current.classList.remove('tip-open');
    }
    current = null;
    pinned = false;
    bubble.hidden = true;
  };

  const show = (el: HTMLElement) => {
    const text = adopt(el);
    // No tip for a menu button whose menu is open (it would cover the menu).
    if (!text || el.getAttribute('aria-expanded') === 'true' && el.hasAttribute('aria-haspopup')) return;
    if (current && current !== el) hide();
    current = el;
    heading.textContent = el.dataset.tipTitle ?? '';
    heading.hidden = !el.dataset.tipTitle;
    body.textContent = text;
    bubble.hidden = false;
    el.setAttribute('aria-describedby', 'app-tip');
    el.classList.add('tip-open');
    const r = el.getBoundingClientRect();
    const size = { width: bubble.offsetWidth, height: bubble.offsetHeight };
    const view = { width: window.innerWidth, height: window.innerHeight };
    // data-tip-side="right": beside the target (list rows, where a bubble below would hide the next rows).
    const pos = el.dataset.tipSide === 'right' && r.right + 8 + size.width <= view.width - 8
      ? { left: Math.round(r.right + 8), top: Math.round(Math.max(8, Math.min(r.top, view.height - 8 - size.height))), above: false }
      : placeTip(r, size, view);
    bubble.style.left = `${pos.left}px`;
    bubble.style.top = `${pos.top}px`;
    bubble.dataset.side = pos.above ? 'above' : 'below';
  };

  document.addEventListener('pointerover', (ev) => {
    if (ev.pointerType !== 'mouse' || pinned) return;
    const el = source(ev.target);
    if (el === current) return;
    clearTimeout(timer);
    if (!el) {
      if (current) hide();
      return;
    }
    adopt(el); // the native tooltip must never appear, even with hover tips off
    const clickOnly = el.hasAttribute('data-tip-click');
    if (!hoverEnabled && !clickOnly) return;
    timer = setTimeout(() => show(el), current ? 0 : HOVER_DELAY_MS);
  });
  document.addEventListener('pointerout', (ev) => {
    if (pinned || ev.pointerType !== 'mouse') return;
    const to = source(ev.relatedTarget);
    if (to !== current) hide();
    clearTimeout(timer);
  });
  document.addEventListener('focusin', (ev) => {
    const el = source(ev.target);
    // Only for keyboard focus (a click also focuses buttons; that case is the hover / tap path).
    if (el && (el as HTMLElement).matches(':focus-visible') && (hoverEnabled || el.hasAttribute('data-tip-click'))) show(el);
  });
  document.addEventListener('focusout', () => {
    if (!pinned) hide();
  });
  document.addEventListener('click', (ev) => {
    const el = source(ev.target);
    if (el?.hasAttribute('data-tip-click')) {
      ev.preventDefault();
      if (pinned && current === el) {
        hide();
        return;
      }
      show(el);
      pinned = true;
      return;
    }
    if (pinned && !bubble.contains(ev.target as Node)) hide();
  }, true);
  document.addEventListener('pointerdown', () => {
    clearTimeout(timer); // a press cancels a hover tip that is still waiting to appear
    if (!pinned && current) hide(); // and hides one that is showing
  }, true);
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && current) hide();
  });
  window.addEventListener('scroll', hide, true);
  window.addEventListener('resize', hide);
}

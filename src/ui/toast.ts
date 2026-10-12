import { h } from './dom';
import { icon } from './icons';
import { loadText, saveText } from './storage';
import type { ToggleText } from './descriptions';

export const TIPS_STORAGE_KEY = 'quant-sim.tips';
const MAX_VISIBLE = 3;
const LIFETIME_MS = 7000;

export type ToastTone = 'info' | 'good' | 'warn';

let host: HTMLElement | null = null;
let tipsOn = loadText(TIPS_STORAGE_KEY) !== '0';

/** Lets CSS hide the always-visible explanations (body[data-tips='off']) along with the pop-up notes. */
function syncTipsAttribute(): void {
  if (typeof document !== 'undefined' && document.body) document.body.dataset.tips = tipsOn ? 'on' : 'off';
}
syncTipsAttribute();

function ensureHost(): HTMLElement {
  if (!host) {
    host = h('div', { class: 'toasts', role: 'region', 'aria-label': 'Notes', 'aria-live': 'polite' });
    document.body.append(host);
  }
  return host;
}

/** A small note in the corner that fades after a few seconds (hover keeps it, the cross closes it). */
export function toast(title: string, text: string, tone: ToastTone = 'info'): void {
  const box = ensureHost();
  // The same note again (a switch flipped twice) replaces the old one instead of piling up.
  for (const old of box.querySelectorAll<HTMLElement>('.toast')) if (old.dataset.title === title) old.remove();
  const el = h('div', { class: `toast toast-${tone}`, role: 'status', 'data-title': title });
  const close = h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Close this note' }, icon('close', 14));
  el.append(h('div', { class: 'toast-icon' }, icon(tone === 'warn' ? 'info' : tone === 'good' ? 'check' : 'bulb', 18)), h('div', { class: 'toast-body' }, h('strong', {}, title), h('span', {}, text)), close);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const remove = () => { clearTimeout(timer); el.classList.add('leaving'); setTimeout(() => el.remove(), 200); };
  const arm = () => { clearTimeout(timer); timer = setTimeout(remove, LIFETIME_MS); };
  close.addEventListener('click', remove);
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  box.append(el);
  while (box.children.length > MAX_VISIBLE) box.firstElementChild?.remove();
  arm();
}

export const tipsEnabled = (): boolean => tipsOn;

export function setTipsEnabled(on: boolean): void {
  tipsOn = on;
  saveText(TIPS_STORAGE_KEY, on ? '1' : '0');
  syncTipsAttribute();
}

/** The "what did that do?" note shown when something is switched (skipped when helper notes are off). */
export function explain(text: ToggleText, on = true): void {
  if (!tipsOn) return;
  toast(text.title, on ? text.on : (text.off ?? text.on));
}

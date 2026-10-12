import { PANEL_TEXT, TIPS_TEXT } from './descriptions';
import { h } from './dom';
import { icon } from './icons';
import type { PanelChrome } from './panelChrome';
import { isFull, isHidden, listedPanels, type PanelId } from './panels';
import { createPopover } from './popover';
import { otherTheme, type Theme } from './theme';
import { explain, setTipsEnabled, tipsEnabled, toast } from './toast';

export interface AppBar {
  /** Updates the theme button (icon and words) after the theme changed. */
  setTheme(theme: Theme): void;
  /** Rebuilds the View menu's list (call when Live mode starts or ends). */
  refreshView(): void;
}

export interface AppBarDeps {
  chrome: PanelChrome;
  theme: Theme;
  isLive(): boolean;
  onTheme(next: Theme): void;
  onHelp(): void;
  onTour(): void;
  onResetSplit(): void;
}

const BRAND_TAGLINE = 'Build a trading robot with blocks. Pretend money, real prices.';

/** The page header: name, tagline, and the View / Tour / Help / theme buttons. */
export function createAppBar(container: HTMLElement, deps: AppBarDeps): AppBar {
  const { chrome } = deps;
  const button = (label: string, iconName: string, tip: string, tour: string, onClick: () => void) => {
    const b = h('button', { type: 'button', class: 'app-btn', 'data-tour': tour, 'data-tip': tip }, icon(iconName, 16), h('span', { class: 'app-btn-label' }, label));
    b.addEventListener('click', onClick);
    return b;
  };

  // View: every panel, one switch each.
  const view = createPopover('View', 'Hide, show or full-page any panel', 'Panels', 'view-menu');
  view.button.prepend(icon('layout', 16));
  view.button.classList.add('app-btn');
  view.button.setAttribute('data-tour', 'view');
  view.button.setAttribute('data-tip', 'Hide, show or full-page any panel, and more');
  const buildView = () => {
    const rows = listedPanels(deps.isLive()).map((id: PanelId) => {
      const text = PANEL_TEXT[id];
      const box = h('input', { type: 'checkbox', 'aria-label': `Show ${text.title}` });
      box.checked = !isHidden(chrome.state, id);
      box.addEventListener('change', () => { chrome.hide(id); buildView(); });
      const full = h('button', { type: 'button', class: 'view-full', 'data-tip': `Make ${text.title} fill the whole page` }, icon(isFull(chrome.state, id) ? 'minimize' : 'maximize', 14), 'Full page');
      full.addEventListener('click', () => { view.close(); chrome.full(id); });
      return h('div', { class: 'view-row' }, h('label', {}, box, h('span', {}, h('strong', {}, text.title), h('small', {}, text.help))), full);
    });
    const showAllBtn = h('button', { type: 'button' }, 'Show all panels');
    showAllBtn.addEventListener('click', () => { chrome.showAll(); buildView(); });
    const resetBtn = h('button', { type: 'button', 'data-tip': 'Put the divider between the Strategy and Chart panels back in the middle' }, 'Reset the divider');
    resetBtn.addEventListener('click', () => { deps.onResetSplit(); explain({ title: 'Divider reset', on: 'The Strategy and Chart panels share the page in their usual way again.' }); });
    const tipsBox = h('input', { type: 'checkbox' });
    tipsBox.checked = tipsEnabled();
    tipsBox.addEventListener('change', () => {
      setTipsEnabled(tipsBox.checked);
      // Switching notes off must still say so once (explain() stays quiet when they are off).
      if (tipsBox.checked) explain(TIPS_TEXT);
      else toast(TIPS_TEXT.title, TIPS_TEXT.off ?? '');
    });
    view.panel.replaceChildren(
      h('div', { class: 'view-heading' }, 'Panels'), ...rows,
      h('div', { class: 'view-foot' }, showAllBtn, resetBtn),
      h('div', { class: 'view-sep', role: 'separator' }),
      h('label', { class: 'view-tips' }, tipsBox, h('span', {}, h('strong', {}, 'Helper notes'), h('small', {}, 'A short note pops up when you switch something, saying what it does.'))),
    );
  };
  view.button.addEventListener('click', buildView);
  chrome.onChange(() => { if (view.isOpen) buildView(); });
  buildView();

  const themeButton = h('button', { type: 'button', class: 'app-btn', 'data-tour': 'theme' });
  let theme = deps.theme;
  const showTheme = () => {
    const next = otherTheme(theme);
    themeButton.replaceChildren(icon(theme === 'dark' ? 'sun' : 'moon', 16), h('span', { class: 'app-btn-label' }, theme === 'dark' ? 'Light' : 'Dark'));
    themeButton.setAttribute('aria-label', `Switch to ${next} mode`);
    themeButton.setAttribute('data-tip', `Switch to ${next} colors (shortcut: T)`);
  };
  themeButton.addEventListener('click', () => deps.onTheme(otherTheme(theme)));
  showTheme();

  const brand = h(
    'div', { class: 'brand' },
    h('span', { class: 'brand-logo' }, icon('logo', 22)),
    h('div', { class: 'brand-text' }, h('h1', {}, 'Quant Sim'), h('span', { class: 'brand-tag' }, BRAND_TAGLINE)),
  );
  container.append(
    brand,
    h('nav', { class: 'app-nav', 'aria-label': 'Page tools' }, view.root, button('Tour', 'tour', 'A 1-minute guided tour of the page (shortcut: G)', 'tour', deps.onTour), button('Help', 'help', 'Words to know, what every button does, and shortcuts (shortcut: H)', 'help', deps.onHelp), themeButton),
  );

  return {
    setTheme(t) { theme = t; showTheme(); },
    refreshView: buildView,
  };
}

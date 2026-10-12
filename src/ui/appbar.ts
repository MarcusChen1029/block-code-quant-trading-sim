import { h } from './dom';
import { icon } from './icons';
import { createPopover } from './popover';
import { currentTheme, onThemeChange, setTextSize, setThemeChoice, textSize, themeChoice, toggleTheme, type TextSize, type ThemeChoice } from './theme';
import { hoverTipsEnabled, infoButton, setHoverTips, tip } from './tooltip';

export interface AppBarHandlers {
  onHelp(): void;
  onTour(): void;
  onResetLayout(): void;
  onExportStrategy(): void;
  onImportStrategy(file: File): void;
  onResetEverything(): void;
}

/** The logo: three stacked blocks with a rising line (inline, so it follows the theme's accent colour). */
export function logo(size = 28): HTMLElement {
  const wrap = h('span', { class: 'logo', 'aria-hidden': 'true' });
  wrap.innerHTML =
    `<svg width="${size}" height="${size}" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="var(--accent)"/>` +
    '<rect x="6" y="18" width="6" height="8" rx="1.5" fill="#fff" opacity=".55"/><rect x="13" y="13" width="6" height="13" rx="1.5" fill="#fff" opacity=".75"/>' +
    '<rect x="20" y="8" width="6" height="18" rx="1.5" fill="#fff"/><path d="M5 15 12 10l5 3 9-7" fill="none" stroke="#ffd54f" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return wrap;
}

/** A row of mutually exclusive buttons (a radio group that looks like a segmented control). */
function segmented<T extends string>(label: string, options: Array<[T, string]>, current: T, onPick: (v: T) => void): { el: HTMLElement; set(v: T): void } {
  const buttons = options.map(([value, text]) => {
    const b = h('button', { type: 'button', role: 'radio', 'data-value': value }, text);
    b.addEventListener('click', () => {
      set(value);
      onPick(value);
    });
    return b;
  });
  const set = (v: T) => {
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.setAttribute('aria-checked', String(on));
      b.classList.toggle('active', on);
    }
  };
  set(current);
  return { el: h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': label }, ...buttons), set };
}

/** Brand, a reassurance badge, and the Help / colour / Settings buttons. */
export function createAppBar(container: HTMLElement, handlers: AppBarHandlers): void {
  const brand = h(
    'div', { class: 'brand' },
    logo(),
    h('div', { class: 'brand-text' }, h('h1', { class: 'brand-name' }, 'Quant Sim'), h('span', { class: 'brand-tag' }, 'Build a trading robot with blocks')),
  );
  const safe = tip(h('span', { class: 'safe-badge' }, icon('shield', 14), h('span', {}, 'Pretend money')),
    'Nothing here uses real money. Quant Sim only reads public prices and can never place a real order.', 'Safe to experiment');

  const help = h('button', { type: 'button', class: 'btn btn-ghost appbar-btn', id: 'help-btn' }, icon('help', 18), h('span', { class: 'btn-label' }, 'Help'));
  tip(help, 'How it works, a word list, common questions and keyboard shortcuts. Shortcut: ?');
  help.addEventListener('click', handlers.onHelp);

  const themeBtn = h('button', { type: 'button', class: 'icon-btn appbar-btn theme-btn' });
  const paintThemeBtn = () => {
    const dark = currentTheme() === 'dark';
    themeBtn.replaceChildren(icon(dark ? 'sun' : 'moon', 18));
    themeBtn.setAttribute('aria-label', dark ? 'Switch to light colours' : 'Switch to dark colours');
    tip(themeBtn, `${dark ? 'Switch to light colours' : 'Switch to dark colours'}. Shortcut: D`);
  };
  themeBtn.addEventListener('click', () => toggleTheme());

  // Settings menu
  const settings = createPopover('', 'Colours, text size, tips, your strategy file and resets', 'Settings', 'settings-menu');
  settings.button.classList.add('icon-btn', 'appbar-btn');
  settings.button.setAttribute('aria-label', 'Settings');
  settings.button.replaceChildren(icon('settings', 18));
  settings.root.classList.add('settings-pop');

  const theme = segmented<ThemeChoice>('Colours', [['system', 'Auto'], ['dark', 'Dark'], ['light', 'Light']], themeChoice(), setThemeChoice);
  const size = segmented<TextSize>('Text size', [['normal', 'A'], ['large', 'A+'], ['larger', 'A++']], textSize(), setTextSize);
  const hoverBox = h('input', { type: 'checkbox', role: 'switch', class: 'switch' });
  hoverBox.checked = hoverTipsEnabled();
  hoverBox.addEventListener('change', () => setHoverTips(hoverBox.checked));

  const row = (label: string, info: string, control: HTMLElement) =>
    h('div', { class: 'menu-row' }, h('span', { class: 'menu-label' }, label, infoButton(info, `About ${label.toLowerCase()}`)), control);
  const action = (ic: Parameters<typeof icon>[0], label: string, desc: string, onClick: () => void, cls = '') => {
    const b = h('button', { type: 'button', class: `menu-item ${cls}` }, icon(ic), h('span', { class: 'menu-item-text' }, h('span', {}, label), h('small', {}, desc)));
    b.addEventListener('click', () => {
      settings.close(true);
      onClick();
    });
    return b;
  };
  const fileInput = h('input', { type: 'file', accept: '.json,application/json', hidden: '' });
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) handlers.onImportStrategy(file);
    fileInput.value = '';
  });

  settings.panel.append(
    h('div', { class: 'menu-heading' }, 'Look & feel'),
    row('Colours', '“Auto” follows your device: dark at night if your device is set that way.', theme.el),
    row('Text size', 'Make all the writing bigger and easier to read.', size.el),
    h('label', { class: 'menu-row menu-switch' }, h('span', { class: 'menu-label' }, 'Explain on hover'), hoverBox),
    h('div', { class: 'menu-sep', role: 'separator' }),
    h('div', { class: 'menu-heading' }, 'Your strategy'),
    action('download', 'Export strategy', 'Save your blocks and Pine scripts as a file', handlers.onExportStrategy),
    action('upload', 'Import strategy', 'Load blocks from a file you exported', () => fileInput.click()),
    h('div', { class: 'menu-sep', role: 'separator' }),
    h('div', { class: 'menu-heading' }, 'Help & resets'),
    action('sparkles', 'Take the tour again', 'A 1-minute walk around the screen', handlers.onTour),
    action('fit', 'Reset layout', 'Show every panel again at its normal size', handlers.onResetLayout),
    action('trash', 'Reset everything…', 'Delete saved blocks, scripts, sessions and settings', handlers.onResetEverything, 'danger'),
    fileInput,
  );
  settings.button.addEventListener('click', () => {
    theme.set(themeChoice());
    hoverBox.checked = hoverTipsEnabled();
  });

  onThemeChange(() => {
    paintThemeBtn();
    theme.set(themeChoice());
  });
  paintThemeBtn();

  container.append(brand, h('div', { class: 'panel-spacer' }), safe, help, themeBtn, settings.root);
}

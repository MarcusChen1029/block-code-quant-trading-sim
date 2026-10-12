import { loadText, saveText } from './storage';

/** What the person picked: follow the device, or always dark / light. */
export type ThemeChoice = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';
export type TextSize = 'normal' | 'large' | 'larger';

export const THEME_STORAGE_KEY = 'quant-sim.theme';
export const TEXT_SIZE_STORAGE_KEY = 'quant-sim.text-size';

export function parseThemeChoice(raw: string | null): ThemeChoice {
  return raw === 'dark' || raw === 'light' ? raw : 'system';
}

export function parseTextSize(raw: string | null): TextSize {
  return raw === 'large' || raw === 'larger' ? raw : 'normal';
}

/** The theme actually shown for a choice, given whether the device prefers light. */
export function resolveTheme(choice: ThemeChoice, prefersLight: boolean): ResolvedTheme {
  if (choice === 'system') return prefersLight ? 'light' : 'dark';
  return choice;
}

/** Colours the canvas-drawn parts (charts, block workspace) need; read from the CSS tokens of the shown theme. */
export interface ThemeColors {
  chartBg: string;
  chartText: string;
  chartGrid: string;
  chartBorder: string;
  muted: string;
  accent: string;
}

type Listener = (theme: ResolvedTheme) => void;
const listeners = new Set<Listener>();
const lightQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
let choice: ThemeChoice = parseThemeChoice(loadText(THEME_STORAGE_KEY));

export function themeChoice(): ThemeChoice {
  return choice;
}

export function currentTheme(): ResolvedTheme {
  return resolveTheme(choice, lightQuery?.matches ?? false);
}

/** Reads the canvas colours from the CSS custom properties (style.css defines them per theme). */
export function themeColors(): ThemeColors {
  const css = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    chartBg: v('--chart-bg', '#131722'),
    chartText: v('--chart-text', '#d1d4dc'),
    chartGrid: v('--chart-grid', '#1e222d'),
    chartBorder: v('--border', '#2a2e39'),
    muted: v('--text-3', '#787b86'),
    accent: v('--accent', '#2962ff'),
  };
}

function apply(): void {
  const theme = currentTheme();
  if (document.documentElement.dataset.theme === theme) return;
  document.documentElement.dataset.theme = theme;
  for (const l of listeners) l(theme);
}

export function setThemeChoice(next: ThemeChoice): void {
  choice = next;
  saveText(THEME_STORAGE_KEY, next);
  apply();
}

/** Flips between dark and light (the keyboard shortcut); the result is remembered as an explicit choice. */
export function toggleTheme(): void {
  setThemeChoice(currentTheme() === 'dark' ? 'light' : 'dark');
}

/** Calls `listener` whenever the shown theme changes (a pick in Settings, or the device switching). */
export function onThemeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function textSize(): TextSize {
  return parseTextSize(loadText(TEXT_SIZE_STORAGE_KEY));
}

export function setTextSize(size: TextSize): void {
  saveText(TEXT_SIZE_STORAGE_KEY, size);
  if (size === 'normal') delete document.documentElement.dataset.textSize;
  else document.documentElement.dataset.textSize = size;
  window.dispatchEvent(new Event('resize')); // canvases and the splitter re-measure
}

/** Starts following the device setting (for the 'system' choice) and makes sure the attribute is set. */
export function initTheme(): void {
  lightQuery?.addEventListener('change', apply);
  const shown = currentTheme();
  if (document.documentElement.dataset.theme !== shown) document.documentElement.dataset.theme = shown;
}

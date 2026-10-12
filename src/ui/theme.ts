/** Dark / light colour scheme: which one to use, and the colours the canvases (charts, Blockly) need in each. */
export type Theme = 'dark' | 'light';

export const THEME_STORAGE_KEY = 'quant-sim.theme';

/** The saved choice, else the system's preference, else dark. Anything unexpected in storage is ignored. */
export function resolveTheme(saved: string | null, systemPrefersLight: boolean): Theme {
  if (saved === 'dark' || saved === 'light') return saved;
  return systemPrefersLight ? 'light' : 'dark';
}

export const otherTheme = (theme: Theme): Theme => (theme === 'dark' ? 'light' : 'dark');

/** Colours for the parts that cannot read CSS variables (chart canvases and the Blockly workspace). */
export interface CanvasColors {
  background: string;
  text: string;
  grid: string;
  gridSoft: string;
  muted: string;
  border: string;
  workspace: string;
  toolbox: string;
  flyout: string;
  scrollbar: string;
}

export const CANVAS_COLORS: Record<Theme, CanvasColors> = {
  dark: {
    background: '#131722', text: '#d1d4dc', grid: '#232838', gridSoft: '#1b2030', muted: '#787b86', border: '#2a2e39',
    workspace: '#1b1f2d', toolbox: '#131722', flyout: '#262b3b', scrollbar: '#434651',
  },
  light: {
    background: '#ffffff', text: '#2b3148', grid: '#e6e9f2', gridSoft: '#f0f2f8', muted: '#6b7390', border: '#d9deec',
    workspace: '#f4f6fc', toolbox: '#ffffff', flyout: '#e8ecf6', scrollbar: '#b4bbd0',
  },
};

type Listener = (theme: Theme) => void;
const listeners = new Set<Listener>();
let current: Theme = 'dark';

export const currentTheme = (): Theme => current;

/** Runs `listener` now and after every theme change; returns the unsubscribe function. */
export function onThemeChange(listener: Listener): () => void {
  listeners.add(listener);
  listener(current);
  return () => { listeners.delete(listener); };
}

/** Switches the page (and everything subscribed) to `theme`. */
export function applyTheme(theme: Theme): void {
  current = theme;
  if (typeof document !== 'undefined') {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', CANVAS_COLORS[theme].background);
  }
  for (const l of listeners) l(theme);
}

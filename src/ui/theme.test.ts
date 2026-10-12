import { describe, expect, it } from 'vitest';
import { applyTheme, CANVAS_COLORS, currentTheme, onThemeChange, otherTheme, resolveTheme } from './theme';

describe('theme', () => {
  it('a saved choice wins, then the system preference, then dark', () => {
    expect(resolveTheme('light', false)).toBe('light');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme(null, true)).toBe('light');
    expect(resolveTheme(null, false)).toBe('dark');
    expect(resolveTheme('purple', true)).toBe('light'); // junk in storage is ignored
  });

  it('flips', () => {
    expect(otherTheme('dark')).toBe('light');
    expect(otherTheme('light')).toBe('dark');
  });

  it('notifies subscribers now and on every change, until they unsubscribe', () => {
    const seen: string[] = [];
    const off = onThemeChange((t) => seen.push(t));
    applyTheme('light');
    applyTheme('dark');
    off();
    applyTheme('light');
    expect(seen).toEqual(['dark', 'light', 'dark']);
    expect(currentTheme()).toBe('light');
    applyTheme('dark');
  });

  it('has colours for both themes', () => {
    for (const theme of ['dark', 'light'] as const) {
      for (const value of Object.values(CANVAS_COLORS[theme])) expect(value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

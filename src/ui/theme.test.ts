import { describe, expect, it } from 'vitest';
import { parseTextSize, parseThemeChoice, resolveTheme } from './theme';

describe('theme', () => {
  it('follows the device for "system" and obeys an explicit choice', () => {
    expect(resolveTheme('system', true)).toBe('light');
    expect(resolveTheme('system', false)).toBe('dark');
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('light', false)).toBe('light');
  });

  it('reads stored values safely', () => {
    expect(parseThemeChoice('light')).toBe('light');
    expect(parseThemeChoice('neon')).toBe('system');
    expect(parseThemeChoice(null)).toBe('system');
    expect(parseTextSize('larger')).toBe('larger');
    expect(parseTextSize('huge')).toBe('normal');
  });
});

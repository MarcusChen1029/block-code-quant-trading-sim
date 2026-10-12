import { describe, expect, it } from 'vitest';
import { matchShortcut } from './shortcuts';

const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }> = {}) =>
  ({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe('keyboard shortcuts', () => {
  it('runs with Ctrl or Cmd + Enter, even while typing', () => {
    expect(matchShortcut(key('Enter', { ctrlKey: true }), true)).toBe('run');
    expect(matchShortcut(key('Enter', { metaKey: true }), false)).toBe('run');
    expect(matchShortcut(key('Enter'), false)).toBeNull();
  });

  it('maps single keys outside text fields', () => {
    expect(matchShortcut(key('?'), false)).toBe('help');
    expect(matchShortcut(key('['), false)).toBe('toggleStrategy');
    expect(matchShortcut(key(']'), false)).toBe('toggleResults');
    expect(matchShortcut(key('F'), false)).toBe('fullChart');
    expect(matchShortcut(key('d'), false)).toBe('theme');
  });

  it('leaves single keys alone while typing or with modifiers (copy, browser keys)', () => {
    expect(matchShortcut(key('f'), true)).toBeNull();
    expect(matchShortcut(key('d', { ctrlKey: true }), false)).toBeNull();
    expect(matchShortcut(key('f', { altKey: true }), false)).toBeNull();
    expect(matchShortcut(key('x'), false)).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { shortcutFor, type KeyInfo } from './shortcuts';

const key = (over: Partial<KeyInfo>): KeyInfo => ({
  key: '', code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, typing: false, inBlocks: false, ...over,
});

describe('shortcutFor', () => {
  it('maps plain keys', () => {
    expect(shortcutFor(key({ key: 'r', code: 'KeyR' }))).toEqual({ type: 'run' });
    expect(shortcutFor(key({ key: 'R', code: 'KeyR', shiftKey: true }))).toBeNull(); // Shift+R is not ours
    expect(shortcutFor(key({ key: 't', code: 'KeyT' }))).toEqual({ type: 'theme' });
    expect(shortcutFor(key({ key: 'h', code: 'KeyH' }))).toEqual({ type: 'help' });
    expect(shortcutFor(key({ key: 'g', code: 'KeyG' }))).toEqual({ type: 'tour' });
    expect(shortcutFor(key({ key: '?', code: 'Slash', shiftKey: true }))).toEqual({ type: 'help' });
    expect(shortcutFor(key({ key: 'x', code: 'KeyX' }))).toBeNull();
  });

  it('digits hide / show panels, with Shift they go full page', () => {
    expect(shortcutFor(key({ key: '1', code: 'Digit1' }))).toEqual({ type: 'toggle-hidden', panel: 'strategy' });
    expect(shortcutFor(key({ key: '2', code: 'Digit2' }))).toEqual({ type: 'toggle-hidden', panel: 'chart' });
    expect(shortcutFor(key({ key: '3', code: 'Digit3' }))).toEqual({ type: 'toggle-hidden', panel: 'results' });
    expect(shortcutFor(key({ key: '4', code: 'Digit4' }))).toEqual({ type: 'toggle-hidden', panel: 'live' });
    expect(shortcutFor(key({ key: '#', code: 'Digit3', shiftKey: true }))).toEqual({ type: 'toggle-full', panel: 'results' });
  });

  it('Ctrl/Cmd + Enter runs even while typing; Escape always leaves full page', () => {
    expect(shortcutFor(key({ key: 'Enter', code: 'Enter', ctrlKey: true, typing: true }))).toEqual({ type: 'run' });
    expect(shortcutFor(key({ key: 'Enter', code: 'Enter', metaKey: true, inBlocks: true }))).toEqual({ type: 'run' });
    expect(shortcutFor(key({ key: 'Enter', code: 'Enter', typing: true }))).toBeNull();
    expect(shortcutFor(key({ key: 'Escape', code: 'Escape', typing: true }))).toEqual({ type: 'exit-full' });
  });

  it('plain letters never fire while typing', () => {
    for (const k of ['r', 't', 'h', '1', '?']) expect(shortcutFor(key({ key: k, code: k === '1' ? 'Digit1' : 'KeyX', typing: true }))).toBeNull();
  });

  it('inside the block editor only help works (Blockly owns the other keys)', () => {
    expect(shortcutFor(key({ key: 'r', code: 'KeyR', inBlocks: true }))).toBeNull();
    expect(shortcutFor(key({ key: '1', code: 'Digit1', inBlocks: true }))).toBeNull();
    expect(shortcutFor(key({ key: '?', code: 'Slash', shiftKey: true, inBlocks: true }))).toEqual({ type: 'help' });
  });

  it('leaves browser shortcuts alone', () => {
    expect(shortcutFor(key({ key: 'r', code: 'KeyR', ctrlKey: true }))).toBeNull(); // reload
    expect(shortcutFor(key({ key: 't', code: 'KeyT', metaKey: true }))).toBeNull(); // new tab
    expect(shortcutFor(key({ key: '1', code: 'Digit1', altKey: true }))).toBeNull();
  });
});

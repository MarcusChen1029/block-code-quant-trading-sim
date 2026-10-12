import { describe, expect, it } from 'vitest';
import { OVERLAYS } from './overlays';
import { zoneToggleOverlays } from './blockOverlays';
import { BLOCK_GROUP_TEXT, FIELD_TEXT, OVERLAY_TEXT, overlayText, PANEL_BUTTON_TEXT, PANEL_TEXT, timeframeWords } from './descriptions';
import { TIMEFRAMES } from '../data/types';
import { BUTTON_GUIDE, DISCLAIMER, GLOSSARY, QUICK_START } from './helpContent';
import { buildToolbox } from '../blocks/toolbox';
import { STAT_HELP } from './statHelp';
import { statsRows } from './format';
import { PANEL_IDS } from './panels';
import type { Stats } from '../engine/stats';

describe('descriptions', () => {
  it('every built-in overlay has its own description', () => {
    for (const def of OVERLAYS) expect(OVERLAY_TEXT[def.id], def.id).toBeTruthy();
  });

  it('other overlays (zones, Pine) get a generic line that names them', () => {
    for (const def of zoneToggleOverlays()) expect(overlayText(def.id, def.label)).toContain(def.label);
    expect(overlayText('nope', 'My line')).toContain('My line');
  });

  it('every panel has a title, subtitle and help text', () => {
    for (const id of PANEL_IDS) {
      expect(PANEL_TEXT[id].title).toBeTruthy();
      expect(PANEL_TEXT[id].subtitle).toBeTruthy();
      expect(PANEL_TEXT[id].help.length).toBeGreaterThan(20);
    }
  });

  it('every field, glossary term and step is filled in, and terms are unique', () => {
    for (const text of Object.values(FIELD_TEXT)) expect(text.length).toBeGreaterThan(20);
    const terms = GLOSSARY.map((g) => g.term);
    expect(new Set(terms).size).toBe(terms.length);
    for (const g of GLOSSARY) expect(g.meaning.length).toBeGreaterThan(20);
    for (const s of QUICK_START) expect(s.title && s.text).toBeTruthy();
    expect(DISCLAIMER).toContain('pretend money');
  });

  it('every block group in the menu has a hover note, and no note is left over', () => {
    const groups = buildToolbox().contents.map((c) => c.name);
    for (const name of groups) expect(BLOCK_GROUP_TEXT[name], name).toBeTruthy();
    for (const name of Object.keys(BLOCK_GROUP_TEXT)) expect(groups, name).toContain(name);
  });

  it('the button guide covers each control once', () => {
    const names = BUTTON_GUIDE.map((b) => b.name);
    expect(new Set(names).size).toBe(names.length);
    for (const b of BUTTON_GUIDE) expect(b.text.length).toBeGreaterThan(20);
  });

  it('puts every timeframe into words', () => {
    expect(timeframeWords('1m')).toBe('1 minute');
    expect(timeframeWords('15m')).toBe('15 minutes');
    expect(timeframeWords('1h')).toBe('1 hour');
    expect(timeframeWords('4h')).toBe('4 hours');
    expect(timeframeWords('1d')).toBe('1 day');
    expect(timeframeWords('weird')).toBe('weird');
    for (const tf of TIMEFRAMES) expect(timeframeWords(tf)).toMatch(/^\d+ (minute|hour|day)s?$/);
  });

  it('panel button notes name the panel', () => {
    expect(PANEL_BUTTON_TEXT.hide('Chart').on).toContain('Chart');
    expect(PANEL_BUTTON_TEXT.full('Chart').on).toContain('Esc');
  });

  it('every stat card has a plain-English explanation', () => {
    const stats: Stats = {
      initialEquity: 1, finalEquity: 1, netProfit: 0, totalReturnPct: 0, maxDrawdownPct: 0,
      winRatePct: 0, profitFactor: 1, sharpe: 0, tradeCount: 0, exposurePct: 0,
    };
    for (const row of statsRows(stats)) expect(STAT_HELP[row.label], row.label).toBeTruthy();
  });
});

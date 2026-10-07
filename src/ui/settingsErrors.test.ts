import { describe, it, expect } from 'vitest';
import { defaultRawSettings, isAccountField, parseSettings, type RawSettings } from './settings';

const NOW = Date.parse('2026-10-07T12:00:00Z');
const raw = (patch: Partial<RawSettings>): RawSettings => ({ ...defaultRawSettings(NOW), ...patch });

describe('parseSettings: specific errors that name the field', () => {
  it('accepts any finite value in range, whatever the spinner step (0.045 %, 2.5x, 1.5 bps)', () => {
    const r = parseSettings(raw({ takerFeePct: '0.045', leverage: '2.5', slippageBps: '1.5' }), NOW);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.settings.broker).toMatchObject({ takerFee: 0.00045, leverage: 2.5, slippageBps: 1.5 });
  });

  const CASES: Array<[Partial<RawSettings>, keyof RawSettings, RegExp]> = [
    [{ symbol: 'b!' }, 'symbol', /symbol/],
    [{ startDate: '' }, 'startDate', /start date/],
    [{ balance: '0' }, 'balance', /balance/i],
    [{ leverage: '200' }, 'leverage', /leverage must be between 1 and 125, got 200/],
    [{ leverage: '' }, 'leverage', /leverage/],
    [{ takerFeePct: '1.5' }, 'takerFeePct', /taker fee must be between 0% and 1%, got 1.5/],
    [{ makerFeePct: '-1' }, 'makerFeePct', /maker fee must be between 0% and 1%, got -1/],
    [{ slippageBps: 'abc' }, 'slippageBps', /slippage/],
  ];
  for (const [patch, field, message] of CASES) {
    it(`${JSON.stringify(patch)} -> error on ${field}`, () => {
      const r = parseSettings(raw(patch), NOW);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.field).toBe(field);
        expect(r.error).toMatch(message);
      }
    });
  }

  it('knows which fields live in the collapsible Account settings section', () => {
    expect(['leverage', 'takerFeePct', 'makerFeePct', 'slippageBps'].every((f) => isAccountField(f as keyof RawSettings))).toBe(true);
    expect(['symbol', 'timeframe', 'startDate', 'balance'].some((f) => isAccountField(f as keyof RawSettings))).toBe(false);
  });
});

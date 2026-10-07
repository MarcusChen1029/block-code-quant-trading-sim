import { describe, it, expect } from 'vitest';
import { defaultRawSettings, defaultStartDate, parseSettings, type RawSettings } from './settings';

const NOW = Date.parse('2026-10-05T12:00:00Z');
const base: RawSettings = defaultRawSettings(NOW);

describe('defaults', () => {
  it('start 90 days back with spec default costs', () => {
    expect(defaultStartDate(NOW)).toBe('2026-07-07');
    expect(base).toMatchObject({ symbol: 'BTCUSDT', timeframe: '1h', takerFeePct: '0.04', makerFeePct: '0.02', slippageBps: '2' });
  });
});

describe('parseSettings', () => {
  it('converts percent fees to fractions and the date to UTC ms', () => {
    const r = parseSettings({ ...base, symbol: ' ethusdt ', leverage: '5' }, NOW);
    expect(r).toEqual({
      ok: true,
      settings: {
        symbol: 'ETHUSDT',
        timeframe: '1h',
        startMs: Date.parse('2026-07-07T00:00:00Z'),
        broker: { initialBalance: 10000, leverage: 5, takerFee: 0.0004, makerFee: 0.0002, slippageBps: 2 },
      },
    });
  });

  it.each([
    [{ symbol: 'BTC/USDT' }, 'symbol must be 2-20 letters/digits, e.g. BTCUSDT', 'symbol'],
    [{ timeframe: '7m' }, 'unsupported timeframe: 7m', 'timeframe'],
    [{ startDate: '07/07/2026' }, 'start date must be YYYY-MM-DD', 'startDate'],
    [{ startDate: '2026-12-01' }, 'start date must be in the past', 'startDate'],
    [{ balance: '0' }, 'balance must be greater than 0', 'balance'],
    [{ leverage: '200' }, 'leverage must be between 1 and 125, got 200', 'leverage'],
    [{ takerFeePct: '-1' }, 'taker fee must be between 0% and 1%, got -1', 'takerFeePct'],
    [{ slippageBps: '' }, 'slippage must be between 0 and 1000 bps, got nothing', 'slippageBps'],
  ])('rejects %j', (patch, error, field) => {
    expect(parseSettings({ ...base, ...patch }, NOW)).toEqual({ ok: false, error, field });
  });

  it('caps the number of bars', () => {
    const r = parseSettings({ ...base, timeframe: '1m', startDate: '2026-01-01' }, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/^range too large: \d+ bars \(max 100000\)/);
  });
});

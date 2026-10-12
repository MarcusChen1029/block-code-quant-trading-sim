import { describe, expect, it } from 'vitest';
import { friendlyMessage } from './friendly';

describe('friendlyMessage', () => {
  it('explains network failures in plain words', () => {
    expect(friendlyMessage('Failed to fetch')).toMatch(/internet connection/);
    expect(friendlyMessage('TypeError: NetworkError when attempting to fetch resource.')).toMatch(/internet connection/);
    expect(friendlyMessage('WebSocket error on wss://fstream.binance.com/market/ws/btcusdt@kline_1h')).toMatch(/reconnects by itself/);
  });

  it('rewrites the common form mistakes, whatever sentence they sit in', () => {
    expect(friendlyMessage('Cannot run: range too large: 3566415 bars (max 100000); pick a later start date or a larger timeframe.')).toMatch(/too many candles.*100,000/);
    expect(friendlyMessage('Cannot run: symbol must be 2-20 letters/digits, e.g. BTCUSDT.')).toMatch(/2 to 20 letters or numbers/);
    expect(friendlyMessage('start date must be in the past')).toMatch(/has to be in the past/);
    expect(friendlyMessage('Cannot run: balance must be greater than 0.')).toBe('Starting money has to be more than 0.');
    expect(friendlyMessage('leverage must be between 1 and 125, got 200')).toMatch(/1 to 125/);
  });

  it('leaves every other message alone', () => {
    for (const m of ['Binance rate limit (HTTP 429)', 'Blocks: 1 problem: missing input', '']) expect(friendlyMessage(m)).toBe(m);
  });
});

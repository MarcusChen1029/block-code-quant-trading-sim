import { describe, expect, it } from 'vitest';
import { friendlyMessage } from './friendly';

describe('friendlyMessage', () => {
  it('explains network failures in plain words', () => {
    expect(friendlyMessage('Failed to fetch')).toMatch(/internet connection/);
    expect(friendlyMessage('TypeError: NetworkError when attempting to fetch resource.')).toMatch(/internet connection/);
    expect(friendlyMessage('WebSocket error on wss://fstream.binance.com/market/ws/btcusdt@kline_1h')).toMatch(/reconnects by itself/);
  });

  it('leaves every other message alone', () => {
    for (const m of ['Binance rate limit (HTTP 429)', 'Blocks: 1 problem: missing input', '']) expect(friendlyMessage(m)).toBe(m);
  });
});

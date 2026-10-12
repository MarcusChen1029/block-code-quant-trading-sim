import { describe, expect, it } from 'vitest';
import { summaryText } from './summaryText';

describe('summaryText', () => {
  it('puts the verdict first and says what it was tested on', () => {
    const text = summaryText({ verdict: '55 trades · +12.00% return. ', symbol: 'btcusdt', timeframe: '1h', startDate: '2026-07-14', balance: ' 10000 ', strategy: 'my blocks' });
    const lines = text.split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('My Quant Sim result: 55 trades · +12.00% return.');
    expect(lines[1]).toBe('Tested my blocks on BTCUSDT (1h candles) since 2026-07-14 with 10000 pretend dollars.');
    expect(lines[2]).toMatch(/Pretend money only/);
  });
});

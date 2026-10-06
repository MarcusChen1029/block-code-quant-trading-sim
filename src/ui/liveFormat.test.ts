import { describe, it, expect } from 'vitest';
import { DEFAULT_BROKER_CONFIG } from '../engine/types';
import { newSessionRecord, smaCrossSnapshot } from '../live/session';
import { liveBadge, parseUtcDateTime, sessionRow, toUtcDateTimeValue } from './liveFormat';

const T = Date.parse('2026-10-06T10:41:00Z');

describe('live badge', () => {
  const base = { lastBarTime: T, barsProcessed: 260, behindBars: 0 };
  it('names each connection state and the last processed bar', () => {
    expect(liveBadge({ ...base, state: 'live' }, false)).toEqual({ text: '● LIVE', tone: 'live', detail: 'last bar 2026-10-06 10:41 UTC · 260 bars' });
    expect(liveBadge({ ...base, state: 'catching-up', behindBars: 1 }, false).text).toBe('CATCHING UP · 1 bar');
    expect(liveBadge({ ...base, state: 'catching-up', behindBars: 180 }, false).text).toBe('CATCHING UP · 180 bars');
    expect(liveBadge({ ...base, state: 'reconnecting' }, false).tone).toBe('warn');
    expect(liveBadge({ ...base, state: 'error', message: 'Binance HTTP 503', retryInMs: 5000 }, false).text).toBe('DATA ERROR · retry in 5s: Binance HTTP 503');
    expect(liveBadge({ ...base, state: 'connecting', lastBarTime: null, barsProcessed: 0 }, false).detail).toBe('no bar processed yet · 0 bars');
  });
  it('labels replays of stopped sessions as read-only', () => {
    expect(liveBadge({ ...base, state: 'catching-up', behindBars: 40 }, true).text).toBe('REPLAYING · 40 bars to go');
    expect(liveBadge({ ...base, state: 'stopped' }, true).text).toBe('STOPPED · read-only');
  });
});

describe('session rows and UTC inputs', () => {
  it('summarise a record for the list', () => {
    const r = newSessionRecord({ name: 'mine', symbol: 'BTCUSDT', timeframe: '1m', startMs: T, warmupBars: 200, brokerConfig: DEFAULT_BROKER_CONFIG, strategy: smaCrossSnapshot() }, T, 'x');
    expect(sessionRow(r)).toMatchObject({ name: 'mine', market: 'BTCUSDT 1m', status: 'running', returnPct: '—', lastBar: '—', running: true });
    const stopped = sessionRow({ ...r, status: 'stopped', stopReason: 'error', lastBarTime: T, summary: { equity: 10_120.5, returnPct: 1.205, tradeCount: 2, bars: 300 } });
    expect(stopped).toMatchObject({ status: 'stopped: error', statusTone: 'error', returnPct: '1.21%', returnTone: 'pos', equity: '10,120.50', lastBar: '2026-10-06 10:41', running: false });
  });
  it('read datetime-local values as UTC', () => {
    expect(parseUtcDateTime('2026-10-06T10:41')).toBe(T);
    expect(parseUtcDateTime('2026-10-06')).toBeNaN();
    expect(toUtcDateTimeValue(T + 30_000)).toBe('2026-10-06T10:41');
  });
});

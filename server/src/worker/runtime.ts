import type { MarketDataAdapter } from '../../../src/data/adapter';
import { BinanceFuturesAdapter } from '../../../src/data/binance';
import { CachedMarketData } from '../../../src/data/candleCache';
import { HEARTBEAT_MS } from '../../../src/live/client';
import { createLiveHost, type LiveCommand, type LiveEvent, type RunnerTuning } from '../../../src/live/host';
import { setFactoryLoader } from '../../../src/sandbox/codeLoader';
import { openDatabase, SqliteCandleCache } from '../db';
import { createVmLoader } from '../sandbox/vmLoader';

/** What the main thread passes to every session worker (plain data: it crosses the thread boundary). */
export interface WorkerConfig {
  /** SQLite file for the closed-candle cache; null = REST only. */
  dbPath: string | null;
  /** Bars kept in the candle cache over all series. */
  cacheMaxBars?: number;
  /** Tests only: a local fake of Binance. Production always uses the public Binance market-data hosts. */
  restBase?: string;
  wsBase?: string;
  /** Accept 'debug' commands (crash / hang simulation). Off in production. */
  allowDebug?: boolean;
  heartbeatMs?: number;
}

export interface WorkerRuntime {
  handle(command: LiveCommand): void;
  close(): void;
}

/**
 * One live session per worker, exactly like the browser's live.worker.ts: the shared live host (snapshot ->
 * strategy -> runner) on Binance public market data with the closed-candle cache, a heartbeat, and generated code
 * compiled in the node:vm sandbox. `market` replaces the Binance adapter in tests.
 */
export function createWorkerRuntime(post: (event: LiveEvent) => void, config: WorkerConfig, market?: MarketDataAdapter, tuning: RunnerTuning = {}): WorkerRuntime {
  setFactoryLoader(createVmLoader());
  const inner = market ?? new BinanceFuturesAdapter({ restBase: config.restBase, wsBase: config.wsBase });
  let db: ReturnType<typeof openDatabase> | null = null;
  const cached = new CachedMarketData(inner, async () => {
    if (config.dbPath === null) return null;
    db = openDatabase(config.dbPath);
    return new SqliteCandleCache(db, config.cacheMaxBars);
  });
  const host = createLiveHost(post, cached, tuning);
  const beat = setInterval(() => post({ type: 'heartbeat' }), config.heartbeatMs ?? HEARTBEAT_MS);
  let closed = false;
  return {
    handle(command) {
      if (closed) return;
      if (command.type === 'debug') {
        if (!config.allowDebug) return;
        if (command.action === 'throw') {
          setTimeout(() => {
            throw new Error('simulated live worker crash (debug hook)');
          }, 0);
        } else {
          const until = Date.now() + 120_000;
          while (Date.now() < until) {
            // hung: no heartbeats, no messages (the main thread terminates it first)
          }
        }
        return;
      }
      host.handle(command);
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      host.handle({ type: 'stop' });
      try {
        (db as { close(): void } | null)?.close();
      } catch {
        // already closed
      }
    },
  };
}

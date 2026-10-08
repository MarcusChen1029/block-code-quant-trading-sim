import { BinanceFuturesAdapter } from '../data/binance';
import { CachedMarketData, openCandleCache } from '../data/candleCache';
import { HEARTBEAT_MS } from '../live/client';
import { createLiveHost, type LiveCommand, type LiveEvent } from '../live/host';

const scope = self as unknown as DedicatedWorkerGlobalScope;
const post = (event: LiveEvent) => scope.postMessage(event);

// Market data only (public klines REST + kline stream): this worker never talks to an order or account endpoint.
// Closed candles are cached in IndexedDB, so a reopened session replays from the cache and fetches only new bars.
const market = new CachedMarketData(new BinanceFuturesAdapter(), () => openCandleCache());
const host = createLiveHost(post, market);

// Proof of life for the page: a dead or hung worker is detected by the missing heartbeat.
setInterval(() => post({ type: 'heartbeat' }), HEARTBEAT_MS);

scope.onmessage = (event: MessageEvent<LiveCommand>) => {
  const command = event.data;
  if (command.type === 'debug') {
    if (!import.meta.env.DEV) return;
    if (command.action === 'throw') {
      setTimeout(() => {
        throw new Error('simulated live worker crash (dev hook)');
      }, 0);
    } else {
      const until = Date.now() + 120_000; // hung: no heartbeats, no messages (the page terminates it first)
      while (Date.now() < until) {
        // spin
      }
    }
    return;
  }
  host.handle(command);
};

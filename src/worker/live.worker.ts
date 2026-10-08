import { BinanceFuturesAdapter } from '../data/binance';
import { CachedMarketData, openCandleCache } from '../data/candleCache';
import { createLiveHost, type LiveCommand } from '../live/host';

const scope = self as unknown as DedicatedWorkerGlobalScope;

// Market data only (public klines REST + kline stream): this worker never talks to an order or account endpoint.
// Closed candles are cached in IndexedDB, so a reopened session replays from the cache and fetches only new bars.
const market = new CachedMarketData(new BinanceFuturesAdapter(), () => openCandleCache());
const host = createLiveHost((event) => scope.postMessage(event), market);

scope.onmessage = (event: MessageEvent<LiveCommand>) => host.handle(event.data);

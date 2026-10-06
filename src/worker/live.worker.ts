import { BinanceFuturesAdapter } from '../data/binance';
import { createLiveHost, type LiveCommand } from '../live/host';

const scope = self as unknown as DedicatedWorkerGlobalScope;

// Market data only (public klines REST + kline stream): this worker never talks to an order or account endpoint.
const host = createLiveHost((event) => scope.postMessage(event), new BinanceFuturesAdapter());

scope.onmessage = (event: MessageEvent<LiveCommand>) => host.handle(event.data);

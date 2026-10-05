import type { Candle, Timeframe } from '../data/types';
import { Broker } from './broker';
import { computeStats, type EquityPoint, type Stats } from './stats';
import type { EntryRequest, PriceField, Strategy, StrategyContext } from './strategy';
import type { BrokerConfig, Fill, LogEntry, PositionView, Side, Trade } from './types';

export interface EngineConfig {
  symbol: string;
  timeframe: Timeframe;
  broker: BrokerConfig;
}

export interface BacktestResult {
  config: EngineConfig;
  trades: Trade[];
  fills: Fill[];
  equityCurve: EquityPoint[];
  log: LogEntry[];
  stats: Stats;
  /** True when equity hit <= 0 and the run stopped ("account wiped"). */
  wiped: boolean;
  barsProcessed: number;
  /** Position still open after the last bar (not counted in trades). */
  finalPosition: PositionView;
}

/**
 * Bar-by-bar driver shared by backtest and (later) live mode. For each CLOSED candle:
 * 1. broker fills orders queued on earlier bars against it;
 * 2. equity is marked at the close; equity <= 0 force-closes, logs "account wiped" and stops;
 * 3. the strategy runs and may queue orders for the next bar.
 */
export class Engine {
  private readonly broker: Broker;
  private readonly candles: Candle[] = [];
  private readonly equityCurve: EquityPoint[] = [];
  private barsInPosition = 0;
  private started = false;
  private isWiped = false;

  constructor(private readonly strategy: Strategy, readonly config: EngineConfig) {
    this.broker = new Broker(config.broker);
  }

  get wiped(): boolean {
    return this.isWiped;
  }

  /** Feeds one closed candle. Returns false once the account is wiped; later candles are ignored. */
  pushCandle(candle: Candle): boolean {
    if (this.isWiped) return false;
    const bar = this.candles.length;
    this.candles.push(candle);
    this.broker.processBar(candle, bar);

    let equity = this.broker.equity(candle.close);
    if (equity <= 0) {
      this.broker.forceClose(candle.close, bar, candle.time, 'wiped');
      this.broker.addLog(bar, candle.time, 'error', 'account wiped: equity <= 0, run stopped');
      this.isWiped = true;
      equity = this.broker.balance;
      this.equityCurve.push({ time: candle.time, equity });
      return false;
    }
    if (this.broker.position.qty !== 0) this.barsInPosition++;
    this.equityCurve.push({ time: candle.time, equity });

    const ctx = this.context(bar, candle);
    try {
      if (!this.started) {
        this.started = true;
        this.strategy.init?.(ctx);
      }
      this.strategy.onBar(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`strategy error on bar ${bar}: ${message}`);
    }
    return true;
  }

  result(): BacktestResult {
    return {
      config: this.config,
      trades: [...this.broker.trades],
      fills: [...this.broker.fills],
      equityCurve: [...this.equityCurve],
      log: [...this.broker.log],
      stats: computeStats({
        initialEquity: this.config.broker.initialBalance,
        equityCurve: this.equityCurve,
        trades: this.broker.trades,
        barsInPosition: this.barsInPosition,
        timeframe: this.config.timeframe,
      }),
      wiped: this.isWiped,
      barsProcessed: this.candles.length,
      finalPosition: this.broker.position,
    };
  }

  private context(bar: number, candle: Candle): StrategyContext {
    const broker = this.broker;
    const candles = this.candles;
    const order = (side: Side, req: EntryRequest) =>
      broker.placeOrder(
        { side, type: req.type ?? 'market', size: req.size, unit: req.unit ?? 'percentEquity', price: req.price },
        bar,
        candle.time,
      );
    return {
      symbol: this.config.symbol,
      timeframe: this.config.timeframe,
      barIndex: bar,
      candle,
      value(field: PriceField, offset = 0): number {
        if (!Number.isInteger(offset) || offset < 0 || offset > bar) return NaN;
        return candles[bar - offset][field];
      },
      get balance() { return broker.balance; },
      get equity() { return broker.equity(candle.close); },
      get unrealizedPnl() { return broker.unrealizedPnl(candle.close); },
      get position() { return broker.position; },
      get openOrderCount() { return broker.openOrders.length; },
      buy: (req) => order('buy', req),
      sell: (req) => order('sell', req),
      closePosition(): number | null {
        const qty = broker.position.qty;
        if (qty === 0) return null;
        return broker.placeOrder(
          { side: qty > 0 ? 'sell' : 'buy', type: 'market', size: Infinity, unit: 'qty', reduceOnly: true },
          bar,
          candle.time,
        );
      },
      cancelOrders: () => broker.cancelAll(),
      setStopLoss: (price) => broker.setStopLoss(price),
      setTakeProfit: (price) => broker.setTakeProfit(price),
      log: (message) => broker.addLog(bar, candle.time, 'info', message),
    };
  }
}

/** Runs a strategy over historical closed candles. Deterministic: same inputs -> identical result. */
export function runBacktest(candles: readonly Candle[], strategy: Strategy, config: EngineConfig): BacktestResult {
  const engine = new Engine(strategy, config);
  for (const candle of candles) {
    if (!engine.pushCandle(candle)) break;
  }
  return engine.result();
}

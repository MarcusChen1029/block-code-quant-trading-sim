import type { Candle, Timeframe } from '../data/types';
import { buyAndHold, type Benchmark } from './benchmark';
import { Broker, type NotFilledReason } from './broker';
import { computeStats, type EquityPoint, type Stats } from './stats';
import { StrategyError, type EntryRequest, type PriceField, type Strategy, type StrategyContext } from './strategy';
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
  /** What the strategy tried to do (diagnostics for "why no trades?"); never affects the run. */
  activity: EngineActivity;
  /** Buy & hold over the same bars (runBacktest only). */
  benchmark?: Benchmark | null;
}

/** Counters of what the strategy did on the trading bars (warm-up bars excluded). */
export interface EngineActivity {
  /** Trading bars on which the bar handler ran. */
  barsRun: number;
  /** Orders queued: buy / sell requests plus close-position requests that queued an order. */
  orderRequests: number;
  /** Orders that reached their fill bar but did not fill, by reason. */
  notFilled: Record<NotFilledReason, number>;
}

/**
 * Bar-by-bar driver shared by backtest and live mode. For each CLOSED candle:
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
  /** Set by the first pushCandle; warm-up bars are refused afterwards. */
  private trading = false;
  private warmupSuppressed = 0;
  private barsRun = 0;
  private orderRequests = 0;

  constructor(private readonly strategy: Strategy, readonly config: EngineConfig) {
    this.broker = new Broker(config.broker);
  }

  get wiped(): boolean {
    return this.isWiped;
  }

  /**
   * Feeds one closed WARM-UP candle (live sessions: bars before the session start). The strategy runs and keeps
   * its state, so indicators are warm when trading starts, but every order request, SL/TP change, order cancel
   * and log message is dropped; no fills happen, and the bar adds no equity point and no exposure, so stats
   * only cover the bars fed with pushCandle. The first dropped request is noted once at debug level.
   * Warm-up bars must all come before the first pushCandle.
   */
  pushWarmupCandle(candle: Candle): void {
    if (this.trading) throw new Error('warm-up bars must come before the first trading bar');
    const bar = this.candles.length;
    this.candles.push(candle);
    this.runStrategy(this.context(bar, candle, true), bar);
  }

  /** Feeds one closed candle. Returns false once the account is wiped; later candles are ignored. */
  pushCandle(candle: Candle): boolean {
    if (this.isWiped) return false;
    this.trading = true;
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

    this.barsRun++;
    this.runStrategy(this.context(bar, candle, false), bar);
    return true;
  }

  private runStrategy(ctx: StrategyContext, bar: number): void {
    try {
      if (!this.started) {
        this.started = true;
        this.strategy.init?.(ctx);
      }
      this.strategy.onBar(ctx);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const blockId = err instanceof StrategyError ? err.blockId : undefined;
      throw new StrategyError(`strategy error on bar ${bar}: ${message}`, blockId, bar);
    }
  }

  /** Read-only views for incremental consumers (live mode). Do not mutate; they grow as bars are pushed. */
  get trades(): readonly Trade[] {
    return this.broker.trades;
  }

  get fills(): readonly Fill[] {
    return this.broker.fills;
  }

  get log(): readonly LogEntry[] {
    return this.broker.log;
  }

  get equityPoints(): readonly EquityPoint[] {
    return this.equityCurve;
  }

  get position(): PositionView {
    return this.broker.position;
  }

  /** Bars fed so far, warm-up included. */
  get barsProcessed(): number {
    return this.candles.length;
  }

  /** Equity marked at an arbitrary price (live readout per tick); never recorded anywhere. */
  markEquity(price: number): number {
    return this.broker.equity(price);
  }

  stats(): Stats {
    return computeStats({
      initialEquity: this.config.broker.initialBalance,
      equityCurve: this.equityCurve,
      trades: this.broker.trades,
      barsInPosition: this.barsInPosition,
      timeframe: this.config.timeframe,
    });
  }

  result(): BacktestResult {
    return {
      config: this.config,
      trades: [...this.broker.trades],
      fills: [...this.broker.fills],
      equityCurve: [...this.equityCurve],
      log: [...this.broker.log],
      stats: this.stats(),
      wiped: this.isWiped,
      barsProcessed: this.candles.length,
      finalPosition: this.broker.position,
      activity: this.activity,
    };
  }

  get activity(): EngineActivity {
    return { barsRun: this.barsRun, orderRequests: this.orderRequests, notFilled: { ...this.broker.notFilledCounts } };
  }

  private context(bar: number, candle: Candle, warmup: boolean): StrategyContext {
    const broker = this.broker;
    const candles = this.candles;
    const suppressed = <T>(value: T) => (): T => {
      if (this.warmupSuppressed++ === 0) {
        broker.addLog(bar, candle.time, 'debug', 'warm-up: order requests before the session start are ignored');
      }
      return value;
    };
    const order = (side: Side, req: EntryRequest) => {
      const id = broker.placeOrder(
        { side, type: req.type ?? 'market', size: req.size, unit: req.unit ?? 'percentEquity', price: req.price },
        bar,
        candle.time,
      );
      this.orderRequests++;
      return id;
    };
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
      // Warm-up: the same view of the market and account, but every action is dropped (-1 / null: no order).
      buy: warmup ? suppressed(-1) : (req) => order('buy', req),
      sell: warmup ? suppressed(-1) : (req) => order('sell', req),
      closePosition: warmup ? suppressed(null) : (): number | null => {
        const qty = broker.position.qty;
        if (qty === 0) return null;
        const id = broker.placeOrder(
          { side: qty > 0 ? 'sell' : 'buy', type: 'market', size: Infinity, unit: 'qty', reduceOnly: true },
          bar,
          candle.time,
        );
        this.orderRequests++;
        return id;
      },
      cancelOrders: warmup ? suppressed(undefined) : () => broker.cancelAll(),
      setStopLoss: warmup ? suppressed(undefined) : (price) => broker.setStopLoss(price),
      setTakeProfit: warmup ? suppressed(undefined) : (price) => broker.setTakeProfit(price),
      log: warmup ? () => {} : (message) => broker.addLog(bar, candle.time, 'info', message),
    };
  }
}

/**
 * Runs a strategy over historical closed candles, plus the buy & hold benchmark over all of them (it keeps going
 * after a wipe). Deterministic: same inputs -> identical result.
 */
export function runBacktest(candles: readonly Candle[], strategy: Strategy, config: EngineConfig): BacktestResult {
  const engine = new Engine(strategy, config);
  for (const candle of candles) {
    if (!engine.pushCandle(candle)) break;
  }
  return { ...engine.result(), benchmark: buyAndHold(candles, config.broker) };
}

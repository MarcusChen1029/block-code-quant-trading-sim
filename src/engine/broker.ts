import type { Candle } from '../data/types';
import type {
  BrokerConfig,
  Fill,
  FillReason,
  LogEntry,
  Order,
  OrderRequest,
  PositionView,
  Side,
  Trade,
} from './types';

/** Why an order that reached its fill bar did not fill. */
export type NotFilledReason = 'insufficient margin' | 'nothing to reduce';

/** Hard cap so a strategy that logs inside a loop cannot exhaust memory before the worker timeout. */
const MAX_LOG_ENTRIES = 5000;

/**
 * Simulated futures account with ONE net position (opposite fills reduce or flip it).
 * Orders placed on bar t are only processed from bar t+1 on. Per bar, processBar runs:
 *   1. market orders at the open (± slippage), in placement order;
 *   2. stop-loss / take-profit of the position held after step 1 (SL wins ties; gaps fill at the open);
 *   3. resting limit / stop orders against high/low (gaps fill at the open), in placement order.
 * A position opened in step 3 is first checked for SL/TP on the next bar.
 */
export class Broker {
  readonly fills: Fill[] = [];
  readonly trades: Trade[] = [];
  readonly log: LogEntry[] = [];

  private cash: number;
  private qty = 0;
  private entryPrice = NaN;
  private entryBar = -1;
  private entryTime = 0;
  private entryFees = 0;
  private stopLoss: number | null = null;
  private takeProfit: number | null = null;
  private orders: Order[] = [];
  private nextOrderId = 1;
  /** Orders that reached their fill bar but did not fill, by reason (diagnostics only; never affects fills). */
  private readonly notFilled: Record<NotFilledReason, number> = { 'insufficient margin': 0, 'nothing to reduce': 0 };

  constructor(readonly config: BrokerConfig) {
    this.cash = config.initialBalance;
  }

  /** Initial balance + realized PnL - all fees paid. */
  get balance(): number {
    return this.cash;
  }

  get position(): PositionView {
    return {
      side: this.qty > 0 ? 'long' : this.qty < 0 ? 'short' : 'flat',
      qty: this.qty,
      entryPrice: this.entryPrice,
      stopLoss: this.stopLoss,
      takeProfit: this.takeProfit,
    };
  }

  get openOrders(): readonly Order[] {
    return this.orders;
  }

  /** Count of orders rejected ('insufficient margin') or skipped ('nothing to reduce') so far. */
  get notFilledCounts(): Readonly<Record<NotFilledReason, number>> {
    return { ...this.notFilled };
  }

  unrealizedPnl(markPrice: number): number {
    return this.qty === 0 ? 0 : this.qty * (markPrice - this.entryPrice);
  }

  equity(markPrice: number): number {
    return this.cash + this.unrealizedPnl(markPrice);
  }

  addLog(bar: number, time: number, level: LogEntry['level'], message: string): void {
    if (this.log.length > MAX_LOG_ENTRIES) return;
    if (this.log.length === MAX_LOG_ENTRIES) {
      this.log.push({ bar, time, level: 'warn', message: `log truncated after ${MAX_LOG_ENTRIES} entries` });
      return;
    }
    this.log.push({ bar, time, level, message });
  }

  /** Queues an order; it can fill from the NEXT bar on. Returns the order id. Throws on malformed requests. */
  placeOrder(request: OrderRequest, bar: number, time: number): number {
    const sizeOk = request.size > 0 && (Number.isFinite(request.size) || request.reduceOnly === true);
    if (!sizeOk) throw new Error(`order size must be a positive number, got ${request.size}`);
    if (request.type !== 'market' && !(request.price !== undefined && request.price > 0)) {
      throw new Error(`${request.type} order needs a positive price`);
    }
    const order: Order = { ...request, id: this.nextOrderId++, placedBar: bar, placedTime: time };
    this.orders.push(order);
    return order.id;
  }

  cancelOrder(id: number): boolean {
    const before = this.orders.length;
    this.orders = this.orders.filter((o) => o.id !== id);
    return this.orders.length < before;
  }

  cancelAll(): void {
    this.orders = [];
  }

  /** Protective stop for the current (or next) position; cleared when the position closes. null removes it. */
  setStopLoss(price: number | null): void {
    this.stopLoss = price;
  }

  /** Protective target for the current (or next) position; cleared when the position closes. null removes it. */
  setTakeProfit(price: number | null): void {
    this.takeProfit = price;
  }

  /** Processes pending orders and SL/TP against a newly opened bar. `bar` is the candle's index. */
  processBar(candle: Candle, bar: number): void {
    for (const order of this.orders.filter((o) => o.type === 'market' && o.placedBar < bar)) {
      this.removeOrder(order.id);
      this.execute(order, this.slip(candle.open, order.side), this.config.takerFee, 'market', bar, candle.time);
    }

    this.checkProtection(candle, bar);

    for (const order of this.orders.filter((o) => o.type !== 'market' && o.placedBar < bar)) {
      const touched = triggerPrice(order, candle);
      if (touched === null) continue;
      this.removeOrder(order.id);
      if (order.type === 'stop') {
        this.execute(order, this.slip(touched, order.side), this.config.takerFee, 'stop', bar, candle.time);
      } else {
        this.execute(order, touched, this.config.makerFee, 'limit', bar, candle.time);
      }
    }
  }

  /** Closes the whole position at `price` with the taker fee (used when the account is wiped). */
  forceClose(price: number, bar: number, time: number, reason: FillReason): void {
    this.orders = [];
    if (this.qty === 0) return;
    this.applyFill(this.qty > 0 ? 'sell' : 'buy', Math.abs(this.qty), price, this.config.takerFee, reason, null, bar, time);
  }

  private removeOrder(id: number): void {
    this.orders = this.orders.filter((o) => o.id !== id);
  }

  private slip(price: number, side: Side): number {
    const k = this.config.slippageBps / 10_000;
    return side === 'buy' ? price * (1 + k) : price * (1 - k);
  }

  private checkProtection(candle: Candle, bar: number): void {
    if (this.qty === 0) return;
    const long = this.qty > 0;
    const sl = this.stopLoss;
    const tp = this.takeProfit;
    let price: number | null = null;
    let reason: FillReason = 'stopLoss';
    if (long) {
      if (sl !== null && candle.open <= sl) price = candle.open;
      else if (tp !== null && candle.open >= tp) { price = candle.open; reason = 'takeProfit'; }
      else if (sl !== null && candle.low <= sl) price = sl;
      else if (tp !== null && candle.high >= tp) { price = tp; reason = 'takeProfit'; }
    } else {
      if (sl !== null && candle.open >= sl) price = candle.open;
      else if (tp !== null && candle.open <= tp) { price = candle.open; reason = 'takeProfit'; }
      else if (sl !== null && candle.high >= sl) price = sl;
      else if (tp !== null && candle.low <= tp) { price = tp; reason = 'takeProfit'; }
    }
    if (price === null) return;
    const side: Side = long ? 'sell' : 'buy';
    if (reason === 'stopLoss') {
      this.applyFill(side, Math.abs(this.qty), this.slip(price, side), this.config.takerFee, reason, null, bar, candle.time);
    } else {
      this.applyFill(side, Math.abs(this.qty), price, this.config.makerFee, reason, null, bar, candle.time);
    }
  }

  private execute(order: Order, price: number, feeRate: number, reason: FillReason, bar: number, time: number): void {
    const qty = this.resolveQty(order, price, feeRate);
    if (!(qty > 0)) {
      this.notFilled['nothing to reduce']++;
      this.addLog(bar, time, 'warn', `order #${order.id} skipped: nothing to reduce`);
      return;
    }
    const margin = this.marginCheck(order.side, qty, price, feeRate);
    if (!margin.ok) {
      this.notFilled['insufficient margin']++;
      this.addLog(
        bar, time, 'warn',
        `order #${order.id} rejected: insufficient margin (needs ${margin.required.toFixed(2)}, free ${margin.free.toFixed(2)})`,
      );
      return;
    }
    this.applyFill(order.side, qty, price, feeRate, reason, order.id, bar, time);
  }

  private resolveQty(order: Order, price: number, feeRate: number): number {
    let qty: number;
    if (order.unit === 'qty') qty = order.size;
    else if (order.unit === 'usdt') qty = order.size / price;
    else {
      const budget = (this.equity(price) * order.size) / 100;
      qty = budget / (price * (1 / this.config.leverage + feeRate));
    }
    if (order.reduceOnly) {
      const opposite = (order.side === 'sell' && this.qty > 0) || (order.side === 'buy' && this.qty < 0);
      qty = opposite ? Math.min(qty, Math.abs(this.qty)) : 0;
    }
    return qty;
  }

  /** Margin needed for the part of the fill that opens or increases exposure, vs margin still free after the fill's fee. */
  private marginCheck(side: Side, qty: number, price: number, feeRate: number): { ok: boolean; required: number; free: number } {
    const dir = side === 'buy' ? 1 : -1;
    const closing = this.qty !== 0 && Math.sign(this.qty) !== dir ? Math.min(qty, Math.abs(this.qty)) : 0;
    const opening = qty - closing;
    if (opening <= 0) return { ok: true, required: 0, free: Infinity };
    const remaining = Math.abs(this.qty) - closing;
    const used = remaining > 0 ? (remaining * this.entryPrice) / this.config.leverage : 0;
    const equityAfterFee = this.equity(price) - qty * price * feeRate;
    const free = equityAfterFee - used;
    const required = (opening * price) / this.config.leverage;
    return { ok: required <= free + 1e-9 * Math.max(1, Math.abs(free)), required, free };
  }

  private applyFill(
    side: Side, qty: number, price: number, feeRate: number, reason: FillReason,
    orderId: number | null, bar: number, time: number,
  ): void {
    const fee = qty * price * feeRate;
    this.cash -= fee;
    this.fills.push({ orderId, bar, time, side, qty, price, fee, reason });

    const dir = side === 'buy' ? 1 : -1;
    let openingQty = qty;
    if (this.qty !== 0 && Math.sign(this.qty) !== dir) {
      const closeQty = Math.min(qty, Math.abs(this.qty));
      const pnl = (price - this.entryPrice) * closeQty * Math.sign(this.qty);
      const entryFeeShare = (this.entryFees * closeQty) / Math.abs(this.qty);
      const exitFeeShare = (fee * closeQty) / qty;
      this.cash += pnl;
      this.entryFees -= entryFeeShare;
      this.trades.push({
        side: this.qty > 0 ? 'long' : 'short',
        qty: closeQty,
        entryBar: this.entryBar,
        entryTime: this.entryTime,
        entryPrice: this.entryPrice,
        exitBar: bar,
        exitTime: time,
        exitPrice: price,
        pnl,
        fees: entryFeeShare + exitFeeShare,
        netPnl: pnl - entryFeeShare - exitFeeShare,
        exitReason: reason,
      });
      this.qty -= Math.sign(this.qty) * closeQty;
      openingQty = qty - closeQty;
      if (this.qty === 0) {
        this.entryPrice = NaN;
        this.entryFees = 0;
        this.stopLoss = null;
        this.takeProfit = null;
      }
    }
    if (openingQty > 0) {
      if (this.qty === 0) {
        this.entryPrice = price;
        this.entryBar = bar;
        this.entryTime = time;
      } else {
        this.entryPrice = (this.entryPrice * Math.abs(this.qty) + price * openingQty) / (Math.abs(this.qty) + openingQty);
      }
      this.entryFees += (fee * openingQty) / qty;
      this.qty += dir * openingQty;
    }
  }
}

/** Price at which a resting limit/stop order fills on this bar, or null if untouched. Gaps fill at the open. */
function triggerPrice(order: Order, c: Candle): number | null {
  const p = order.price as number;
  if (order.type === 'limit') {
    if (order.side === 'buy') return c.open <= p ? c.open : c.low <= p ? p : null;
    return c.open >= p ? c.open : c.high >= p ? p : null;
  }
  if (order.side === 'buy') return c.open >= p ? c.open : c.high >= p ? p : null;
  return c.open <= p ? c.open : c.low <= p ? p : null;
}

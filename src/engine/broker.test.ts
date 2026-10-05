import { describe, it, expect } from 'vitest';
import type { Candle } from '../data/types';
import { Broker } from './broker';
import type { BrokerConfig } from './types';

const HOUR = 3_600_000;
/** Frictionless account so expected prices are exact; fee/slippage tests override this. */
const NO_COSTS: BrokerConfig = { initialBalance: 10_000, leverage: 1, takerFee: 0, makerFee: 0, slippageBps: 0 };

function bar(i: number, open: number, high: number, low: number, close: number): Candle {
  return { time: i * HOUR, open, high, low, close, volume: 1 };
}

/** Opens a position of `qty` (signed) at price 100 on bar 1 and returns the broker. */
function withPosition(qty: number, config: BrokerConfig = NO_COSTS): Broker {
  const b = new Broker(config);
  b.placeOrder({ side: qty > 0 ? 'buy' : 'sell', type: 'market', size: Math.abs(qty), unit: 'qty' }, 0, 0);
  b.processBar(bar(1, 100, 100, 100, 100), 1);
  return b;
}

describe('market orders', () => {
  it('never fill on the bar they were placed; fill at the next open', () => {
    const b = new Broker(NO_COSTS);
    b.placeOrder({ side: 'buy', type: 'market', size: 1, unit: 'qty' }, 0, 0);
    b.processBar(bar(0, 50, 50, 50, 50), 0);
    expect(b.fills).toHaveLength(0);
    b.processBar(bar(1, 101, 105, 99, 104), 1);
    expect(b.fills).toEqual([{ orderId: 1, bar: 1, time: HOUR, side: 'buy', qty: 1, price: 101, fee: 0, reason: 'market' }]);
    expect(b.position).toEqual({ side: 'long', qty: 1, entryPrice: 101, stopLoss: null, takeProfit: null });
  });

  it('pay taker fee and slippage', () => {
    const b = new Broker({ ...NO_COSTS, takerFee: 0.0004, slippageBps: 2 });
    b.placeOrder({ side: 'buy', type: 'market', size: 1, unit: 'qty' }, 0, 0);
    b.processBar(bar(1, 100, 100, 100, 100), 1);
    expect(b.fills[0].price).toBeCloseTo(100.02, 10); // 100 * (1 + 2/10000)
    expect(b.fills[0].fee).toBeCloseTo(0.040008, 10); // 100.02 * 0.0004
    expect(b.balance).toBeCloseTo(10_000 - 0.040008, 10);
  });

  it('size percentEquity: margin = % of equity with the fee reserved inside the budget', () => {
    const b = new Broker({ ...NO_COSTS, takerFee: 0.0004 });
    b.placeOrder({ side: 'buy', type: 'market', size: 100, unit: 'percentEquity' }, 0, 0);
    b.processBar(bar(1, 100, 100, 100, 100), 1);
    // qty = 10000 / (100 * (1/1 + 0.0004)) = 99.960016
    expect(b.position.qty).toBeCloseTo(99.960016, 6);
    expect(b.log).toHaveLength(0);
  });

  it('size usdt: notional / price', () => {
    const b = new Broker(NO_COSTS);
    b.placeOrder({ side: 'sell', type: 'market', size: 5000, unit: 'usdt' }, 0, 0);
    b.processBar(bar(1, 125, 125, 125, 125), 1);
    expect(b.position.qty).toBe(-40);
  });
});

describe('limit and stop orders', () => {
  it('limit buy fills at the limit when low touches it, maker fee', () => {
    const b = new Broker({ ...NO_COSTS, makerFee: 0.0002, takerFee: 0.0004, slippageBps: 2 });
    b.placeOrder({ side: 'buy', type: 'limit', size: 1, unit: 'qty', price: 95 }, 0, 0);
    b.processBar(bar(1, 100, 101, 96, 99), 1);
    expect(b.fills).toHaveLength(0);
    b.processBar(bar(2, 100, 101, 94, 99), 2);
    expect(b.fills[0]).toMatchObject({ price: 95, reason: 'limit' });
    expect(b.fills[0].fee).toBeCloseTo(0.019, 10); // 95 * 0.0002, no slippage on limits
  });

  it('limit buy fills at the open when the bar gaps below the limit', () => {
    const b = new Broker(NO_COSTS);
    b.placeOrder({ side: 'buy', type: 'limit', size: 1, unit: 'qty', price: 95 }, 0, 0);
    b.processBar(bar(1, 90, 92, 88, 91), 1);
    expect(b.fills[0].price).toBe(90);
  });

  it('stop buy fills at the stop when high touches it, at the open on a gap', () => {
    const b = new Broker(NO_COSTS);
    b.placeOrder({ side: 'buy', type: 'stop', size: 1, unit: 'qty', price: 105 }, 0, 0);
    b.placeOrder({ side: 'buy', type: 'stop', size: 1, unit: 'qty', price: 105 }, 0, 0);
    b.processBar(bar(1, 100, 106, 99, 104), 1);
    expect(b.fills.map((f) => f.price)).toEqual([105, 105]);
    const g = new Broker(NO_COSTS);
    g.placeOrder({ side: 'buy', type: 'stop', size: 1, unit: 'qty', price: 105 }, 0, 0);
    g.processBar(bar(1, 107, 108, 106, 107), 1);
    expect(g.fills[0]).toMatchObject({ price: 107, reason: 'stop' });
  });

  it('stop sell fills at the stop when low touches it', () => {
    const b = new Broker(NO_COSTS);
    b.placeOrder({ side: 'sell', type: 'stop', size: 1, unit: 'qty', price: 95 }, 0, 0);
    b.processBar(bar(1, 100, 101, 94, 96), 1);
    expect(b.fills[0].price).toBe(95);
  });

  it('rejects malformed orders', () => {
    const b = new Broker(NO_COSTS);
    expect(() => b.placeOrder({ side: 'buy', type: 'limit', size: 1, unit: 'qty' }, 0, 0)).toThrow('limit order needs a positive price');
    expect(() => b.placeOrder({ side: 'buy', type: 'market', size: 0, unit: 'qty' }, 0, 0)).toThrow('order size must be a positive number');
  });

  it('cancels orders', () => {
    const b = new Broker(NO_COSTS);
    const id = b.placeOrder({ side: 'buy', type: 'limit', size: 1, unit: 'qty', price: 95 }, 0, 0);
    b.placeOrder({ side: 'buy', type: 'limit', size: 1, unit: 'qty', price: 90 }, 0, 0);
    expect(b.cancelOrder(id)).toBe(true);
    expect(b.openOrders).toHaveLength(1);
    b.cancelAll();
    expect(b.openOrders).toHaveLength(0);
  });
});

describe('stop-loss / take-profit', () => {
  it('assumes the stop-loss hit first when a bar touches both', () => {
    const b = withPosition(1);
    b.setStopLoss(95);
    b.setTakeProfit(110);
    b.processBar(bar(2, 100, 111, 94, 105), 2);
    expect(b.trades).toHaveLength(1);
    expect(b.trades[0]).toMatchObject({ side: 'long', exitPrice: 95, pnl: -5, exitReason: 'stopLoss' });
    expect(b.position.side).toBe('flat');
  });

  it('fills a stop-loss at the open when the bar gaps through it', () => {
    const b = withPosition(1);
    b.setStopLoss(95);
    b.processBar(bar(2, 90, 92, 88, 91), 2);
    expect(b.trades[0]).toMatchObject({ exitPrice: 90, pnl: -10 });
  });

  it('fills a take-profit at the open on a favourable gap, with maker fee', () => {
    const b = withPosition(1, { ...NO_COSTS, makerFee: 0.001 });
    b.setTakeProfit(110);
    b.processBar(bar(2, 112, 113, 111, 112), 2);
    expect(b.trades[0]).toMatchObject({ exitPrice: 112, pnl: 12, exitReason: 'takeProfit' });
    expect(b.fills[1].fee).toBeCloseTo(0.112, 10);
  });

  it('handles short positions (stop above, target below)', () => {
    const b = withPosition(-1);
    b.setStopLoss(105);
    b.setTakeProfit(90);
    b.processBar(bar(2, 101, 106, 100, 104), 2);
    expect(b.trades[0]).toMatchObject({ side: 'short', exitPrice: 105, pnl: -5 });
  });

  it('keeps SL/TP set while flat for the next entry, clears them when the position closes', () => {
    const b = new Broker(NO_COSTS);
    b.setStopLoss(90);
    b.placeOrder({ side: 'buy', type: 'market', size: 1, unit: 'qty' }, 0, 0);
    b.processBar(bar(1, 100, 100, 100, 100), 1);
    expect(b.position.stopLoss).toBe(90);
    b.processBar(bar(2, 95, 96, 89, 95), 2);
    expect(b.position).toMatchObject({ side: 'flat', stopLoss: null, takeProfit: null });
  });
});

describe('net position', () => {
  it('averages the entry price when adding', () => {
    const b = withPosition(1);
    b.placeOrder({ side: 'buy', type: 'market', size: 1, unit: 'qty' }, 1, HOUR);
    b.processBar(bar(2, 110, 110, 110, 110), 2);
    expect(b.position).toMatchObject({ qty: 2, entryPrice: 105 });
  });

  it('reduces partially and records a trade for the closed part', () => {
    const b = withPosition(2);
    b.placeOrder({ side: 'sell', type: 'market', size: 1, unit: 'qty' }, 1, HOUR);
    b.processBar(bar(2, 110, 110, 110, 110), 2);
    expect(b.trades[0]).toMatchObject({ qty: 1, pnl: 10 });
    expect(b.position).toMatchObject({ side: 'long', qty: 1, entryPrice: 100 });
    expect(b.balance).toBe(10_010);
  });

  it('flips from long to short with one opposite order', () => {
    const b = withPosition(1);
    b.placeOrder({ side: 'sell', type: 'market', size: 3, unit: 'qty' }, 1, HOUR);
    b.processBar(bar(2, 110, 110, 110, 110), 2);
    expect(b.trades[0]).toMatchObject({ side: 'long', qty: 1, pnl: 10 });
    expect(b.position).toMatchObject({ side: 'short', qty: -2, entryPrice: 110 });
  });

  it('attributes entry and exit fees to the trade', () => {
    const b = withPosition(1, { ...NO_COSTS, takerFee: 0.001 }); // entry fee 0.1
    b.placeOrder({ side: 'sell', type: 'market', size: 1, unit: 'qty' }, 1, HOUR);
    b.processBar(bar(2, 110, 110, 110, 110), 2); // exit fee 0.11
    expect(b.trades[0].fees).toBeCloseTo(0.21, 10);
    expect(b.trades[0].netPnl).toBeCloseTo(9.79, 10);
    expect(b.balance).toBeCloseTo(10_009.79, 10);
  });

  it('reduceOnly with Infinity size closes exactly the position', () => {
    const b = withPosition(-3);
    b.placeOrder({ side: 'buy', type: 'market', size: Infinity, unit: 'qty', reduceOnly: true }, 1, HOUR);
    b.processBar(bar(2, 90, 90, 90, 90), 2);
    expect(b.position.side).toBe('flat');
    expect(b.trades[0]).toMatchObject({ side: 'short', qty: 3, pnl: 30 });
  });

  it('skips a reduceOnly order when there is nothing to reduce', () => {
    const b = new Broker(NO_COSTS);
    b.placeOrder({ side: 'sell', type: 'market', size: Infinity, unit: 'qty', reduceOnly: true }, 0, 0);
    b.processBar(bar(1, 100, 100, 100, 100), 1);
    expect(b.fills).toHaveLength(0);
    expect(b.log[0].message).toBe('order #1 skipped: nothing to reduce');
  });

  it('marks to market', () => {
    const b = withPosition(1);
    expect(b.unrealizedPnl(120)).toBe(20);
    expect(b.equity(120)).toBe(10_020);
  });
});

describe('margin', () => {
  it('rejects orders whose margin exceeds free equity and logs why', () => {
    const b = new Broker({ ...NO_COSTS, leverage: 2 });
    b.placeOrder({ side: 'buy', type: 'market', size: 25_000, unit: 'usdt' }, 0, 0);
    b.processBar(bar(1, 100, 100, 100, 100), 1);
    expect(b.fills).toHaveLength(0);
    expect(b.log[0]).toMatchObject({ level: 'warn', message: 'order #1 rejected: insufficient margin (needs 12500.00, free 10000.00)' });
  });

  it('allows notional up to equity x leverage', () => {
    const b = new Broker({ ...NO_COSTS, leverage: 2 });
    b.placeOrder({ side: 'buy', type: 'market', size: 20_000, unit: 'usdt' }, 0, 0);
    b.processBar(bar(1, 100, 100, 100, 100), 1);
    expect(b.position.qty).toBe(200);
  });

  it('counts margin already used by the open position', () => {
    const b = withPosition(60); // uses 6000 margin at 1x
    b.placeOrder({ side: 'buy', type: 'market', size: 50, unit: 'qty' }, 1, HOUR);
    b.processBar(bar(2, 100, 100, 100, 100), 2);
    expect(b.position.qty).toBe(60);
    expect(b.log[0].message).toContain('rejected: insufficient margin');
  });

  it('closes the whole position on forceClose', () => {
    const b = withPosition(1);
    b.forceClose(80, 2, 2 * HOUR, 'wiped');
    expect(b.trades[0]).toMatchObject({ exitPrice: 80, exitReason: 'wiped' });
    expect(b.position.side).toBe('flat');
  });
});

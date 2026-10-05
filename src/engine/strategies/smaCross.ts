import { Sma } from '../../indicators/averages';
import { CrossOver, CrossUnder } from '../../indicators/primitives';
import type { Strategy } from '../strategy';

export interface SmaCrossParams {
  fast: number;
  slow: number;
  /** Margin per entry as % of equity. */
  sizePct: number;
}

export const DEFAULT_SMA_CROSS: SmaCrossParams = { fast: 10, slow: 30, sizePct: 100 };

/** Always-in-the-market SMA cross: long when fast crosses over slow, short when it crosses under. */
export function createSmaCross(params: SmaCrossParams = DEFAULT_SMA_CROSS): Strategy {
  if (!(params.fast < params.slow)) throw new Error('fast length must be less than slow length');
  const fast = new Sma(params.fast);
  const slow = new Sma(params.slow);
  const over = new CrossOver();
  const under = new CrossUnder();

  return {
    onBar(ctx) {
      const f = fast.update(ctx.candle.close);
      const s = slow.update(ctx.candle.close);
      const crossUp = over.update(f, s);
      const crossDown = under.update(f, s);
      const qty = ctx.position.qty;
      if (crossUp && qty <= 0) {
        if (qty < 0) ctx.closePosition();
        ctx.buy({ size: params.sizePct, unit: 'percentEquity' });
      } else if (crossDown && qty >= 0) {
        if (qty > 0) ctx.closePosition();
        ctx.sell({ size: params.sizePct, unit: 'percentEquity' });
      }
    },
  };
}

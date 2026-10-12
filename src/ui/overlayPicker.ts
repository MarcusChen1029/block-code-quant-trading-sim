import { h } from './dom';
import type { OverlayDef } from './overlays';
import { createPopover } from './popover';
import { infoButton } from './tooltip';

/** What each picker overlay shows, in plain words (by id; SMA / EMA ids start with sma / ema). */
export function overlayHelp(id: string): string {
  if (id.startsWith('sma')) return 'Simple moving average: the average closing price of the last N candles, drawn as a line. It shows the trend without the wiggles.';
  if (id.startsWith('ema')) return 'Exponential moving average: like the simple average, but recent candles count more, so it turns faster.';
  const help: Record<string, string> = {
    bb20: 'Bollinger Bands: a band around the 20-candle average. Wide band = the price is jumping around a lot; narrow band = calm.',
    vwap: 'Volume-weighted average price: the average price, counting prices where lots was traded more. Resets every day.',
    rsi14: 'Relative strength index (in its own small chart below): 0 to 100. Above 70 the price rose fast (“overbought”), below 30 it fell fast (“oversold”).',
    macd: 'MACD (in its own small chart below): compares a fast and a slow average. Lines crossing can hint that the trend is turning.',
    atr14: 'Average true range (in its own small chart below): how far the price usually moves in one candle. Bigger = wilder.',
    stoch: 'Stochastic (in its own small chart below): where the close sits between the recent high and low, from 0 to 100.',
    'zones-orderblock': 'Order blocks: boxes around the last candle before a big move. Prices often come back to these areas.',
    'zones-fvg': 'Fair value gaps: boxes over price gaps left by a very fast move, where hardly any trading happened.',
    'zones-swing': 'Swing structure: marks the recent swing highs and lows, and arrows where the price breaks past them.',
  };
  return help[id] ?? 'An extra line or marker drawn on the chart.';
}

/** Badge on the "Chart overlays" button: "3 on", or nothing when none is on. */
export function overlayBadge(count: number): string {
  return count > 0 ? `${count} on` : '';
}

/**
 * "Chart overlays" button with a count badge; its popover holds one checkbox per overlay. Calls onChange with the
 * checked ids (same contract as the old row of checkboxes, so persistence is unchanged).
 */
export function renderOverlayPicker(
  container: HTMLElement,
  defs: readonly OverlayDef[],
  initial: readonly string[],
  onChange: (ids: string[]) => void,
): void {
  const pop = createPopover('Chart extras', 'Draw extra indicator lines and boxes on the chart to help you spot patterns. They are only for looking: they never change your strategy.', 'Chart extras', 'overlay-picker');
  const boxes: HTMLInputElement[] = [];
  const update = () => pop.setBadge(overlayBadge(boxes.filter((b) => b.checked).length));
  for (const def of defs) {
    const box = h('input', { type: 'checkbox', value: def.id });
    box.checked = initial.includes(def.id);
    box.addEventListener('change', () => {
      update();
      onChange(boxes.filter((b) => b.checked).map((b) => b.value));
    });
    boxes.push(box);
    pop.panel.append(h('div', { class: 'overlay-row' }, h('label', {}, box, def.label), infoButton(overlayHelp(def.id), `What is ${def.label}?`, def.label)));
  }
  update();
  container.append(pop.root);
}

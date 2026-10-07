/** Starting points offered by the Pine tab's "New" menu. Every template must compile (tested). */
export interface PineTemplate {
  id: string;
  label: string;
  source: string;
}

export const DOUBLE_EMA_SOURCE = `//@version=5
indicator("Double EMA", overlay=true)
src = input.source(close, "Source")
fastLength = input.int(9, "Fast length", minval=1, maxval=500)
slowLength = input.int(21, "Slow length", minval=1, maxval=500)
fast = ta.ema(src, fastLength)
slow = ta.ema(src, slowLength)
plot(fast, "Fast EMA", color=color.yellow)
plot(slow, "Slow EMA", color=color.blue)
`;

export const SUPERTREND_SOURCE = `//@version=5
indicator("Supertrend", overlay=true)
atrLength = input.int(10, "ATR length", minval=1, maxval=500)
factor = input.float(3.0, "Factor", minval=0.1, maxval=20)
src = input.source(hl2, "Source")

atr = ta.atr(atrLength)
basicUpper = src + factor * atr
basicLower = src - factor * atr

// Bands only ratchet towards price while the trend holds.
var float upper = na
var float lower = na
var int trend = 1
prevUpper = upper
prevLower = lower
upper := na(prevUpper) or close[1] > prevUpper ? basicUpper : math.min(basicUpper, prevUpper)
lower := na(prevLower) or close[1] < prevLower ? basicLower : math.max(basicLower, prevLower)

if na(atr)
    trend := 1
else if trend == -1 and close > prevUpper
    trend := 1
else if trend == 1 and close < prevLower
    trend := -1

stLine = trend == 1 ? lower : upper
plot(stLine, "Supertrend", color=color.purple)
plot(trend == 1 ? lower : na, "Up trend", color=color.green)
plot(trend == -1 ? upper : na, "Down trend", color=color.red)
`;

export const BLANK_SOURCE = `//@version=5
indicator("My indicator", overlay=false)
length = input.int(14, "Length", minval=1, maxval=500)
value = ta.rsi(close, length)
plot(value, "RSI")
`;

/** Pine v4 spelling: study(), input(type=...), bare rsi()/sma(), plot(transp=). */
export const RSI_MA_V4_SOURCE = `//@version=4
study("RSI + MA (v4)", shorttitle="RSI MA", overlay=false)
src = input(close, title="Source", type=input.source)
rsiLength = input(14, title="RSI length", type=input.integer, minval=1, maxval=200)
maLength = input(9, title="MA length", type=input.integer, minval=1, maxval=200)
r = rsi(src, rsiLength)
ma = sma(r, maLength)
plot(r, title="RSI", color=color.purple, linewidth=2, transp=0)
plot(ma, title="RSI MA", color=color.orange)
`;

/** Pine v6: lazy "or" guards the comparison until the previous band exists; conditions are real bools. */
export const SUPERTREND_V6_SOURCE = `//@version=6
indicator("Supertrend (v6)", overlay=true)
atrLength = input.int(10, "ATR length", minval=1, maxval=500)
factor = input.float(3.0, "Factor", minval=0.1, maxval=20)
src = input.source(hl2, "Source")

atr = ta.atr(atrLength)
basicUpper = src + factor * atr
basicLower = src - factor * atr

var float upper = na
var float lower = na
var int trend = 1
prevUpper = upper
prevLower = lower
// v6 evaluates "or" lazily: the comparison only runs once the previous band exists.
upper := na(prevUpper) or close[1] > prevUpper ? basicUpper : math.min(basicUpper, prevUpper)
lower := na(prevLower) or close[1] < prevLower ? basicLower : math.max(basicLower, prevLower)

if na(atr)
    trend := 1
else if trend == -1 and close > prevUpper
    trend := 1
else if trend == 1 and close < prevLower
    trend := -1

plot(trend == 1 ? lower : upper, "Supertrend", color=color.purple)
plot(trend == 1 ? lower : na, "Up trend", color=color.green)
plot(trend == -1 ? upper : na, "Down trend", color=color.red)
`;

export const PINE_TEMPLATES: readonly PineTemplate[] = [
  { id: 'blank', label: 'Blank (RSI)', source: BLANK_SOURCE },
  { id: 'double-ema', label: 'Double EMA', source: DOUBLE_EMA_SOURCE },
  { id: 'supertrend', label: 'Supertrend', source: SUPERTREND_SOURCE },
  { id: 'rsi-ma-v4', label: 'RSI + MA (Pine v4)', source: RSI_MA_V4_SOURCE },
  { id: 'supertrend-v6', label: 'Supertrend (Pine v6)', source: SUPERTREND_V6_SOURCE },
];

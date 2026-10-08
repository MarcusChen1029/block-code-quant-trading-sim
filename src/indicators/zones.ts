/**
 * Native zone indicators: swing structure (pivots + break of structure), SMC order blocks and fair value gaps.
 * Exact definitions: docs/superpowers/specs/2026-10-07-zones.md.
 *
 * Every class here is incremental: `update(bar)` is called once per CLOSED bar, in order, and its result for bar t
 * depends only on bars 0..t (no look-ahead, nothing is ever revised). Memory is bounded by the parameters
 * (pivot window, lookback, maxActive), never by the number of bars.
 */

/** The bar fields the zone indicators read (a Candle satisfies it). `time` is the bar open time in ms. */
export interface ZoneBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export type ZoneKind = 'bullish' | 'bearish';

/**
 * Why a zone stopped being active: mitigated (closed through it), expired (older than maxAgeBars), evicted (more
 * than maxActive on its side), broken (a swing level a close went through: break of structure), superseded (a
 * swing level replaced by a newer swing of the same side before it was broken).
 */
export type ZoneEndReason = 'mitigated' | 'expired' | 'evicted' | 'broken' | 'superseded';

/**
 * One zone's state, reported as a lifecycle event: once when it becomes known (`endTime` null) and once when it
 * stops being active (`endTime` = that bar's time). Consumers upsert by `id` (unique per indicator instance).
 * A swing level is a zone with top === bottom.
 */
export interface Zone {
  id: number;
  kind: ZoneKind;
  top: number;
  bottom: number;
  /** Open time of the origin candle (where the drawn box starts). */
  startTime: number;
  /** Open time of the bar on whose close the zone became known (strategy-visible from this bar on). */
  knownTime: number;
  endTime: number | null;
  endReason?: ZoneEndReason;
  /** Short fixed label, e.g. 'OB+'. */
  label: string;
}

const checkInt = (name: string, v: number, min: number) => {
  if (!Number.isInteger(v) || v < min) throw new Error(`${name} must be a whole number >= ${min}, got ${v}`);
};

/** Fixed-capacity ring of the last `capacity` items, oldest first by index. */
class Ring<T> {
  private readonly buf: T[] = [];
  private head = 0;

  constructor(readonly capacity: number) {}

  push(item: T): void {
    if (this.buf.length < this.capacity) this.buf.push(item);
    else {
      this.buf[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  get length(): number {
    return this.buf.length;
  }

  /** i = 0 is the oldest kept item. */
  at(i: number): T {
    return this.buf[(this.head + i) % this.buf.length];
  }
}

export interface Pivot {
  price: number;
  /** Open time of the pivot candle. */
  time: number;
}

/**
 * Pivot highs / lows with `left` and `right` bars. A pivot high at bar i: high[i] is STRICTLY above the highs of
 * the `left` bars before it and AT LEAST the highs of the `right` bars after it (so a flat top marks its first
 * bar); lows mirrored. It needs `left` bars of history and is only KNOWN on the close of bar i + right.
 */
export class PivotDetector {
  private readonly window: Ring<ZoneBar>;

  constructor(readonly left: number, readonly right: number) {
    checkInt('left', left, 1);
    checkInt('right', right, 1);
    this.window = new Ring(left + right + 1);
  }

  /** Pivots confirmed on this bar's close (their candle is `right` bars back), or null. */
  update(bar: ZoneBar): { high: Pivot | null; low: Pivot | null } {
    this.window.push(bar);
    if (this.window.length < this.window.capacity) return { high: null, low: null };
    const c = this.window.at(this.left);
    let isHigh = true;
    let isLow = true;
    for (let i = 0; i < this.window.capacity && (isHigh || isLow); i++) {
      if (i === this.left) continue;
      const b = this.window.at(i);
      if (i < this.left) {
        if (b.high >= c.high) isHigh = false;
        if (b.low <= c.low) isLow = false;
      } else {
        if (b.high > c.high) isHigh = false;
        if (b.low < c.low) isLow = false;
      }
    }
    return {
      high: isHigh ? { price: c.high, time: c.time } : null,
      low: isLow ? { price: c.low, time: c.time } : null,
    };
  }
}

export interface SwingValue {
  /** Price of the last confirmed swing high / low (NaN until one is known). */
  lastHigh: number;
  lastLow: number;
  highConfirmed: boolean;
  lowConfirmed: boolean;
  /**
   * A close went above the last confirmed, not yet broken swing high (fires once per level) while the structure was
   * not bearish (the previous break was up, or there was none): break of structure. Down mirrored.
   */
  bosUp: boolean;
  bosDown: boolean;
  /**
   * Change of character: the same break, but against the structure (bullish CHoCH = a break up while the previous
   * break was down). Exactly one of bosUp / chochUp is true on a bar with an upward break.
   */
  chochUp: boolean;
  chochDown: boolean;
  /** Zone lifecycle events of this bar (swing levels). */
  events: Zone[];
}

/**
 * Swing structure: pivots (PivotDetector), break of structure and change of character. The break reference is the
 * most recently confirmed swing high; a close strictly above it is an upward break, once, and the level is spent
 * until a newer swing high is confirmed (a newer one replaces an unbroken older one: 'superseded'). Lows mirrored.
 * The structure is the direction of the last break: a break in that direction (or the first break) is a BOS, a break
 * against it a CHoCH. An upward break is evaluated before a downward one on the same bar.
 */
export class SwingStructure {
  private readonly pivots: PivotDetector;
  private lastHigh = NaN;
  private lastLow = NaN;
  private high: Zone | null = null;
  private low: Zone | null = null;
  private nextId = 1;
  /** Direction of the last break (null until the first one). */
  private trend: 'up' | 'down' | null = null;

  constructor(readonly left = 5, readonly right = 5) {
    this.pivots = new PivotDetector(left, right);
  }

  update(bar: ZoneBar): SwingValue {
    const events: Zone[] = [];
    const { high, low } = this.pivots.update(bar);
    const end = (z: Zone, reason: ZoneEndReason) => {
      z.endTime = bar.time;
      z.endReason = reason;
      events.push({ ...z });
    };
    const level = (p: Pivot, kind: ZoneKind): Zone => {
      const z: Zone = { id: this.nextId++, kind, top: p.price, bottom: p.price, startTime: p.time, knownTime: bar.time, endTime: null, label: kind === 'bearish' ? 'SH' : 'SL' };
      events.push({ ...z });
      return z;
    };
    if (high) {
      if (this.high) end(this.high, 'superseded');
      this.lastHigh = high.price;
      this.high = level(high, 'bearish');
    }
    if (low) {
      if (this.low) end(this.low, 'superseded');
      this.lastLow = low.price;
      this.low = level(low, 'bullish');
    }
    let [bosUp, bosDown, chochUp, chochDown] = [false, false, false, false];
    if (this.high && bar.close > this.high.top) {
      if (this.trend === 'down') chochUp = true;
      else bosUp = true;
      this.trend = 'up';
      end(this.high, 'broken');
      this.high = null;
    }
    if (this.low && bar.close < this.low.bottom) {
      if (this.trend === 'up') chochDown = true;
      else bosDown = true;
      this.trend = 'down';
      end(this.low, 'broken');
      this.low = null;
    }
    return {
      lastHigh: this.lastHigh, lastLow: this.lastLow, highConfirmed: high !== null, lowConfirmed: low !== null, bosUp, bosDown, chochUp, chochDown,
      events,
    };
  }
}

interface ActiveZone {
  zone: Zone;
  /** Bar number (0-based, counted by this instance) on which it became known. */
  knownIndex: number;
}

export interface ZoneBookValue {
  /** Nearest active bullish zone at or below the close (NaN when none). */
  bullTop: number;
  bullBottom: number;
  /** Nearest active bearish zone at or above the close (NaN when none). */
  bearTop: number;
  bearBottom: number;
  /** The bar's range overlaps an active zone of that side (after this bar's mitigations / new zones). */
  inBull: boolean;
  inBear: boolean;
  newBull: boolean;
  newBear: boolean;
  bullMitigated: boolean;
  bearMitigated: boolean;
  events: Zone[];
}

export interface ZoneBookOptions {
  maxActive: number;
  maxAgeBars: number;
}

/**
 * Active zones of both sides with the shared lifecycle rules: a zone is mitigated when a LATER bar closes beyond
 * its far edge (bullish: close < bottom; bearish: close > top), expired when more than maxAgeBars bars have
 * closed since it became known, evicted (oldest first) when a side would hold more than maxActive.
 */
class ZoneBook {
  private readonly active: Record<ZoneKind, ActiveZone[]> = { bullish: [], bearish: [] };
  private nextId = 1;

  constructor(private readonly options: ZoneBookOptions) {
    checkInt('maxActive', options.maxActive, 1);
    checkInt('maxAgeBars', options.maxAgeBars, 1);
  }

  /** Step 1 of a bar: mitigation then expiry of the zones known before this bar. */
  retire(bar: ZoneBar, index: number, events: Zone[]): { bull: boolean; bear: boolean } {
    const mitigated = { bull: false, bear: false };
    for (const kind of ['bullish', 'bearish'] as const) {
      this.active[kind] = this.active[kind].filter(({ zone, knownIndex }) => {
        const through = kind === 'bullish' ? bar.close < zone.bottom : bar.close > zone.top;
        const reason: ZoneEndReason | null = through ? 'mitigated' : index - knownIndex > this.options.maxAgeBars ? 'expired' : null;
        if (reason === null) return true;
        if (through) mitigated[kind === 'bullish' ? 'bull' : 'bear'] = true;
        zone.endTime = bar.time;
        zone.endReason = reason;
        events.push({ ...zone });
        return false;
      });
    }
    return mitigated;
  }

  /** True when an active zone of `kind` already starts at `startTime` (same origin candle). */
  hasOrigin(kind: ZoneKind, startTime: number): boolean {
    return this.active[kind].some((a) => a.zone.startTime === startTime);
  }

  /** Step 2: a zone that became known on this bar; evicts the oldest of its side beyond maxActive. */
  add(kind: ZoneKind, top: number, bottom: number, startTime: number, bar: ZoneBar, index: number, label: string, events: Zone[]): void {
    const zone: Zone = { id: this.nextId++, kind, top, bottom, startTime, knownTime: bar.time, endTime: null, label };
    const list = this.active[kind];
    list.push({ zone, knownIndex: index });
    events.push({ ...zone });
    while (list.length > this.options.maxActive) {
      const old = list.shift()!.zone;
      old.endTime = bar.time;
      old.endReason = 'evicted';
      events.push({ ...old });
    }
  }

  /** Step 3: per-bar outputs from the zones active at this bar's close. */
  read(bar: ZoneBar): Pick<ZoneBookValue, 'bullTop' | 'bullBottom' | 'bearTop' | 'bearBottom' | 'inBull' | 'inBear'> {
    const bull = this.nearest('bullish', bar.close);
    const bear = this.nearest('bearish', bar.close);
    const overlaps = (kind: ZoneKind) => this.active[kind].some(({ zone }) => bar.low <= zone.top && bar.high >= zone.bottom);
    return {
      bullTop: bull?.top ?? NaN,
      bullBottom: bull?.bottom ?? NaN,
      bearTop: bear?.top ?? NaN,
      bearBottom: bear?.bottom ?? NaN,
      inBull: overlaps('bullish'),
      inBear: overlaps('bearish'),
    };
  }

  /**
   * Bullish: among zones not entirely above the close (bottom <= close), the smallest distance max(0, close - top);
   * bearish mirrored (top >= close, distance max(0, bottom - close)). Ties go to the most recent zone.
   */
  private nearest(kind: ZoneKind, close: number): Zone | null {
    let best: Zone | null = null;
    let bestDistance = Infinity;
    for (const { zone } of this.active[kind]) {
      const eligible = kind === 'bullish' ? zone.bottom <= close : zone.top >= close;
      if (!eligible) continue;
      const distance = kind === 'bullish' ? Math.max(0, close - zone.top) : Math.max(0, zone.bottom - close);
      if (distance <= bestDistance) {
        best = zone;
        bestDistance = distance;
      }
    }
    return best;
  }

  activeCount(kind: ZoneKind): number {
    return this.active[kind].length;
  }
}

export interface OrderBlockOptions extends ZoneBookOptions {
  /** Pivot length (left = right) of the swing structure whose breaks form order blocks. */
  swingLength: number;
  /** How many bars before the break bar (BOS or CHoCH) are searched for the last opposite candle. */
  lookback: number;
  /** false: the candle's full range [low, high]; true: its body [min(open, close), max(open, close)]. */
  useBody: boolean;
}

export const ORDER_BLOCK_DEFAULTS: OrderBlockOptions = { swingLength: 5, lookback: 10, useBody: false, maxActive: 5, maxAgeBars: 300 };

/**
 * SMC order blocks. Bullish: on a bullish break, BOS or CHoCH (close above the last confirmed, unbroken swing high,
 * SwingStructure with left = right = swingLength), the LAST bearish candle (close < open) among the `lookback` bars
 * before the BOS bar; zone = its range (or body). Known at the BOS bar's close. Bearish mirrored (last bullish
 * candle, close > open, before a bearish BOS). A candle that is already the origin of an active zone of the same
 * side is not used twice. Lifecycle: ZoneBook.
 */
export class OrderBlocks {
  private readonly swing: SwingStructure;
  private readonly book: ZoneBook;
  private readonly recent: Ring<ZoneBar>;
  private index = -1;

  constructor(readonly options: OrderBlockOptions = ORDER_BLOCK_DEFAULTS) {
    checkInt('swing length', options.swingLength, 1);
    checkInt('lookback', options.lookback, 1);
    this.swing = new SwingStructure(options.swingLength, options.swingLength);
    this.book = new ZoneBook(options);
    this.recent = new Ring(options.lookback);
  }

  update(bar: ZoneBar): ZoneBookValue {
    this.index++;
    const events: Zone[] = [];
    const mitigated = this.book.retire(bar, this.index, events);
    const s = this.swing.update(bar);
    const made = { bullish: false, bearish: false };
    const form = (kind: ZoneKind) => {
      // Last opposite candle before this bar: bearish for a bullish block, bullish for a bearish one.
      for (let i = this.recent.length - 1; i >= 0; i--) {
        const c = this.recent.at(i);
        if (kind === 'bullish' ? !(c.close < c.open) : !(c.close > c.open)) continue;
        if (this.book.hasOrigin(kind, c.time)) return;
        const top = this.options.useBody ? Math.max(c.open, c.close) : c.high;
        const bottom = this.options.useBody ? Math.min(c.open, c.close) : c.low;
        this.book.add(kind, top, bottom, c.time, bar, this.index, kind === 'bullish' ? 'OB+' : 'OB-', events);
        made[kind] = true;
        return;
      }
    };
    // Every break forms a block, whether it is a BOS or a CHoCH (unchanged from before CHoCH existed).
    if (s.bosUp || s.chochUp) form('bullish');
    if (s.bosDown || s.chochDown) form('bearish');
    this.recent.push(bar);
    return { ...this.book.read(bar), newBull: made.bullish, newBear: made.bearish, bullMitigated: mitigated.bull, bearMitigated: mitigated.bear, events };
  }

  activeCount(kind: ZoneKind): number {
    return this.book.activeCount(kind);
  }
}

export interface FvgOptions extends ZoneBookOptions {
  /** Minimum gap height as a percent of the third candle's close (0 = any gap). */
  minGapPct: number;
}

/** Relative tolerance (of the close) for the minimum gap comparison. */
export const GAP_EPSILON = 1e-9;

export const FVG_DEFAULTS: FvgOptions = { minGapPct: 0.05, maxActive: 5, maxAgeBars: 300 };

/**
 * Fair value gaps over 3 candles a (t-2), b (t-1), c (t, the bar that just closed). Bullish: a.high < c.low, zone
 * [a.high, c.low]; bearish: a.low > c.high, zone [c.high, a.low]. The gap height must be > 0 and >= minGapPct % of
 * c.close. Known at c's close; drawn from the middle candle b. Lifecycle: ZoneBook (mitigated = a later close
 * through the whole gap).
 */
export class FairValueGaps {
  private readonly book: ZoneBook;
  private a: ZoneBar | null = null;
  private b: ZoneBar | null = null;
  private index = -1;

  constructor(readonly options: FvgOptions = FVG_DEFAULTS) {
    if (!(Number.isFinite(options.minGapPct) && options.minGapPct >= 0)) throw new Error(`minimum gap % must be >= 0, got ${options.minGapPct}`);
    this.book = new ZoneBook(options);
  }

  update(c: ZoneBar): ZoneBookValue {
    this.index++;
    const events: Zone[] = [];
    const mitigated = this.book.retire(c, this.index, events);
    const made = { bullish: false, bearish: false };
    const { a, b } = this;
    if (a && b) {
      // Relative tolerance of 1e-9 of the price: a gap exactly at the (decimal) minimum counts despite float rounding
      // (100 - 99.9 = 0.09999999999999432 is 0.1 % of 100).
      const min = (this.options.minGapPct / 100) * Math.abs(c.close) - GAP_EPSILON * Math.abs(c.close);
      const big = (size: number) => size > 0 && size >= min;
      if (a.high < c.low && big(c.low - a.high)) {
        this.book.add('bullish', c.low, a.high, b.time, c, this.index, 'FVG+', events);
        made.bullish = true;
      } else if (a.low > c.high && big(a.low - c.high)) {
        this.book.add('bearish', a.low, c.high, b.time, c, this.index, 'FVG-', events);
        made.bearish = true;
      }
    }
    this.a = b;
    this.b = c;
    return { ...this.book.read(c), newBull: made.bullish, newBear: made.bearish, bullMitigated: mitigated.bull, bearMitigated: mitigated.bear, events };
  }

  activeCount(kind: ZoneKind): number {
    return this.book.activeCount(kind);
  }
}

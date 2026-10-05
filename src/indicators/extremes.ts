import { assertLength, type SeriesIndicator } from './types';

/** Sliding-window extreme via a monotonic deque: amortised O(1) per update. */
class MonotonicWindow implements SeriesIndicator {
  private readonly idx: number[] = [];
  private readonly val: number[] = [];
  private head = 0;
  private seen = 0;

  constructor(readonly length: number, private readonly keeps: (older: number, incoming: number) => boolean) {
    assertLength(length);
  }

  update(value: number): number {
    if (Number.isNaN(value)) return NaN;
    const i = this.seen++;
    while (this.val.length > this.head && !this.keeps(this.val[this.val.length - 1], value)) {
      this.val.pop();
      this.idx.pop();
    }
    this.val.push(value);
    this.idx.push(i);
    while (this.idx[this.head] <= i - this.length) this.head++;
    if (this.head > 1024 && this.head * 2 > this.idx.length) {
      this.idx.splice(0, this.head);
      this.val.splice(0, this.head);
      this.head = 0;
    }
    return this.seen >= this.length ? this.val[this.head] : NaN;
  }
}

/** ta.highest(source, length): max of the last `length` values including the current one. */
export class Highest extends MonotonicWindow {
  constructor(length: number) {
    super(length, (older, incoming) => older > incoming);
  }
}

/** ta.lowest(source, length): min of the last `length` values including the current one. */
export class Lowest extends MonotonicWindow {
  constructor(length: number) {
    super(length, (older, incoming) => older < incoming);
  }
}

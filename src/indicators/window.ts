/** Fixed-capacity FIFO of numbers. get(0) is the newest value. */
export class RingBuffer {
  private readonly buf: Float64Array;
  private head = 0; // index of the next write
  private count = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  get full(): boolean {
    return this.count === this.capacity;
  }

  /** Appends a value; returns the evicted oldest value, or NaN if nothing was evicted. */
  push(value: number): number {
    const evicted = this.full ? this.buf[this.head] : NaN;
    this.buf[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (!this.full) this.count++;
    return evicted;
  }

  /** offset 0 = newest, 1 = previous, ... NaN when out of range. */
  get(offset: number): number {
    if (offset < 0 || offset >= this.count) return NaN;
    return this.buf[(this.head - 1 - offset + 2 * this.capacity) % this.capacity];
  }

  /** Sum of all stored values (O(capacity); used to cancel float drift). */
  sum(): number {
    let s = 0;
    for (let i = 0; i < this.count; i++) s += this.get(i);
    return s;
  }
}

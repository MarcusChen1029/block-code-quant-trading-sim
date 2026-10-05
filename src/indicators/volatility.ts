import { Rma } from './averages';
import { TrueRange } from './primitives';
import type { Hlc } from './types';

/** ta.atr(length) = rma(ta.tr(true), length). */
export class Atr {
  private readonly tr = new TrueRange(true);
  private readonly rma: Rma;

  constructor(readonly length = 14) {
    this.rma = new Rma(length);
  }

  update(bar: Hlc): number {
    return this.rma.update(this.tr.update(bar));
  }
}

import type { SeriesMarker, UTCTimestamp } from 'lightweight-charts';

type Marker = SeriesMarker<UTCTimestamp>;

interface Entry {
  m: Marker;
  rank: number;
  seq: number;
}

interface Group {
  rank: number;
  /** The group's entries, oldest first (by time, then insertion). */
  entries: Entry[];
  nextSeq: number;
}

const before = (a: Entry, b: Entry) => a.m.time - b.m.time || a.rank - b.rank || a.seq - b.seq;

/**
 * The markers of one series, built from ranked groups (trade fills = rank 0, then one group per signal) and kept as
 * ONE list sorted by (time, rank, insertion): the same order mergeMarkers gives for the groups in rank order. Live
 * bars append a few markers in O(log n) instead of rebuilding and re-sorting everything; a cap drops a group's
 * oldest markers (signals draw only their most recent ones).
 */
export class MarkerSet {
  private readonly groups = new Map<string, Group>();
  private merged: Entry[] = [];
  private cached: Marker[] | null = null;

  get size(): number {
    return this.merged.length;
  }

  /** The markers, ascending (a new array only after a change). */
  list(): Marker[] {
    this.cached ??= this.merged.map((e) => e.m);
    return this.cached;
  }

  clear(): void {
    this.groups.clear();
    this.merged = [];
    this.cached = null;
  }

  /** Replaces group `key` with `markers` (sorted by time). */
  setGroup(key: string, rank: number, markers: readonly Marker[]): void {
    const old = this.groups.get(key);
    const kept = old ? this.merged.filter((e) => !old.entries.includes(e)) : this.merged;
    const group: Group = { rank, entries: [], nextSeq: 0 };
    for (const m of markers) group.entries.push({ m, rank, seq: group.nextSeq++ });
    group.entries.sort(before);
    this.groups.set(key, group);
    // Two sorted lists: merge in O(n).
    const out: Entry[] = [];
    let i = 0;
    let j = 0;
    while (i < kept.length || j < group.entries.length) {
      if (j >= group.entries.length || (i < kept.length && before(kept[i], group.entries[j]) <= 0)) out.push(kept[i++]);
      else out.push(group.entries[j++]);
    }
    this.merged = out;
    this.cached = null;
  }

  /** Adds `markers` to group `key` (created with `rank` if new); with `cap`, the group keeps only its newest `cap`. */
  append(key: string, rank: number, markers: readonly Marker[], cap = Infinity): void {
    let group = this.groups.get(key);
    if (!group) {
      group = { rank, entries: [], nextSeq: 0 };
      this.groups.set(key, group);
    }
    for (const m of markers) {
      const entry: Entry = { m, rank: group.rank, seq: group.nextSeq++ };
      this.merged.splice(this.upperBound(entry), 0, entry);
      const g = group.entries;
      let at = g.length;
      while (at > 0 && before(g[at - 1], entry) > 0) at--;
      g.splice(at, 0, entry);
    }
    while (group.entries.length > cap) {
      const oldest: Entry = group.entries.shift()!;
      const at = this.upperBound(oldest) - 1;
      if (this.merged[at] === oldest) this.merged.splice(at, 1);
      else this.merged = this.merged.filter((e) => e !== oldest);
    }
    this.cached = null;
  }

  /** First index whose entry sorts after `entry`. */
  private upperBound(entry: Entry): number {
    let lo = 0;
    let hi = this.merged.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (before(this.merged[mid], entry) <= 0) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }
}

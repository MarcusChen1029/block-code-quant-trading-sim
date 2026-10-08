import { BENCHMARK_DEFINITION } from '../engine/benchmark';
import { h } from './dom';
import type { Verdict } from './verdict';

/** The plain-language verdict line above the stats. Text only ever goes in through textContent. */
export class VerdictView {
  private readonly text: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly info: HTMLElement;

  constructor(private readonly el: HTMLElement) {
    this.text = h('div', { class: 'verdict-text' });
    this.hint = h('div', { class: 'verdict-hint' });
    const info = this.info = h('span', { class: 'verdict-info', title: BENCHMARK_DEFINITION, 'aria-label': BENCHMARK_DEFINITION, role: 'note' }, 'ⓘ');
    el.setAttribute('role', 'status');
    el.append(h('div', { class: 'verdict-row' }, this.text, info), this.hint);
    this.clear();
  }

  /** `benchmarkInfo`: the tooltip for the benchmark that was compared against (it names the leverage). */
  show(verdict: Verdict, benchmarkInfo = BENCHMARK_DEFINITION): void {
    this.info.title = benchmarkInfo;
    this.info.setAttribute('aria-label', benchmarkInfo);
    this.text.textContent = verdict.text;
    this.hint.textContent = verdict.hint ?? '';
    this.hint.hidden = !verdict.hint;
    this.el.dataset.tone = verdict.tone;
    this.el.hidden = false;
  }

  clear(): void {
    this.text.textContent = '';
    this.hint.textContent = '';
    this.el.hidden = true;
  }
}

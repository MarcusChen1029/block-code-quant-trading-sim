import { DEFAULT_WARMUP_BARS } from '../live/session';
import { h } from './dom';
import { toUtcDateTimeValue, type Badge, type SessionRow } from './liveFormat';
import type { Verdict } from './verdict';
import { VerdictView } from './verdictView';
import { infoButton } from './tooltip';

export interface LiveForm {
  name: string;
  startMode: 'now' | 'past';
  /** datetime-local value, UTC. */
  pastStart: string;
  warmupBars: string;
}

export interface LivePanelHandlers {
  onStart(form: LiveForm): void;
  onOpen(id: string): void;
  onStop(id: string): void;
  onDelete(id: string): void;
}

export interface LivePanel {
  setBadge(badge: Badge | null): void;
  /** Mark-to-market readout from the forming candle; null hides it. */
  setMark(text: string | null): void;
  setNotice(text: string | null): void;
  setSessions(rows: SessionRow[], viewedId: string | null): void;
  setBusy(busy: boolean): void;
  /** The session's plain-language verdict (same wording as a backtest); null hides it. */
  setVerdict(verdict: Verdict | null, benchmarkInfo?: string): void;
}

/** The Live-mode strip: start form, status badge and the session list. */
export function createLivePanel(container: HTMLElement, handlers: LivePanelHandlers, nowMs: number): LivePanel {
  const name = h('input', { type: 'text', name: 'liveName', placeholder: 'optional', style: 'width:120px', maxlength: '80' });
  const startMode = h('select', { name: 'liveStartMode' }, h('option', { value: 'now' }, 'Now'), h('option', { value: 'past' }, 'Past time (replay, then live)'));
  const pastStart = h('input', { type: 'datetime-local', name: 'livePastStart', step: '60', 'aria-label': 'From (UTC)' });
  pastStart.value = toUtcDateTimeValue(nowMs - 3 * 3_600_000);
  const pastField = h('label', { class: 'field', hidden: '' }, pastStart);
  startMode.addEventListener('change', () => { pastField.hidden = startMode.value !== 'past'; });
  const warmup = h('input', { type: 'number', name: 'liveWarmup', min: '0', max: '5000', step: '1', style: 'width:84px' });
  warmup.value = String(DEFAULT_WARMUP_BARS);
  const start = h('button', { type: 'submit', class: 'run', title: 'Start a practice session: your strategy trades on live prices with pretend money. You can stop it any time.' }, 'Start live session');

  const field = (label: string, el: HTMLElement, help: string) => {
    el.setAttribute('aria-label', label); // the label also holds the "?" button, which must not join the name
    return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label, infoButton(help, `What is “${label}”?`, label)), el);
  };
  pastField.replaceChildren(h('span', { class: 'field-label' }, 'From (UTC)', infoButton('The moment to start from, in UTC time (London winter time). The robot replays the candles since then quickly, then keeps going live.', 'What is “From (UTC)”?')), pastStart);
  const form = h(
    'form', { class: 'run-form live-form' },
    field('Session name', name, 'A name to recognise this session in the list below, like “My first robot”. You can leave it empty.'),
    field('Start', startMode, '“Now” starts trading from the next candle. “Past time” first replays recent candles quickly (so you see results sooner), then carries on live.'),
    pastField,
    field('Warm-up candles', warmup, 'How many earlier candles the indicators look at before trading starts, so that an average of 50 candles already has a value. No trades happen during warm-up.'),
    start,
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    handlers.onStart({ name: name.value, startMode: startMode.value === 'past' ? 'past' : 'now', pastStart: pastStart.value, warmupBars: warmup.value });
  });

  const honesty = h('div', { class: 'live-honesty' }, '🛡 Practice trading: pretend money, real prices. No real orders are ever sent.');
  const badge = h('span', { class: 'live-badge', hidden: '' });
  const badgeDetail = h('span', { class: 'live-detail' });
  const mark = h('span', { class: 'live-mark', hidden: '' });
  const notice = h('div', { class: 'live-notice', hidden: '' });
  const list = h('div', { class: 'live-sessions' });
  const verdictEl = h('div', { class: 'verdict live-verdict' });
  const verdict = new VerdictView(verdictEl);

  container.append(
    h('div', { class: 'live-row' }, honesty),
    h('div', { class: 'live-row' }, form, h('div', { class: 'live-status' }, badge, badgeDetail, mark)),
    verdictEl,
    notice,
    list,
  );

  return {
    setBadge(b) {
      badge.hidden = b === null;
      badgeDetail.textContent = b?.detail ?? '';
      if (b) {
        badge.textContent = b.text;
        badge.className = `live-badge tone-${b.tone}`;
      }
    },
    setMark(text) {
      mark.hidden = text === null;
      mark.textContent = text ?? '';
    },
    setNotice(text) {
      notice.hidden = text === null;
      notice.textContent = text ?? '';
    },
    setBusy(busy) {
      start.disabled = busy;
    },
    setVerdict(v, info) {
      if (v) verdict.show(v, info);
      else verdict.clear();
    },
    setSessions(rows, viewedId) {
      if (rows.length === 0) {
        list.replaceChildren(h('div', { class: 'hint' }, 'No live sessions yet. Pick a coin and candle size above, then press “Start live session”. Your strategy from the Strategy panel will start trading with pretend money.'));
        return;
      }
      const button = (label: string, title: string, onClick: () => void, cls = '') => {
        const b = h('button', { type: 'button', title, class: cls }, label);
        b.addEventListener('click', onClick);
        return b;
      };
      const header = h('tr', {}, ...['Session', 'Market', 'Status', 'Return', 'Equity', 'Last bar (UTC)', ''].map((t) => h('th', {}, t)));
      const body = rows.map((r) =>
        h(
          'tr', { class: r.id === viewedId ? 'viewed' : undefined },
          h('td', { class: 'name', title: r.name }, r.name),
          h('td', {}, r.market),
          h('td', {}, h('span', { class: `pill tone-${r.statusTone}` }, r.status)),
          h('td', { class: r.returnTone }, r.returnPct),
          h('td', {}, r.equity),
          h('td', {}, r.lastBar),
          h(
            'td', { class: 'actions' },
            r.id === viewedId
              ? h('span', { class: 'hint' }, 'on screen')
              : button(r.running ? 'Open' : 'View', r.running ? 'Show this session' : 'Replay this stopped session (read-only)', () => handlers.onOpen(r.id)),
            ...(r.running ? [button('Stop', 'Stop: no more bars are processed; the session becomes read-only history', () => handlers.onStop(r.id))] : []),
            button('Delete', 'Delete this session', () => handlers.onDelete(r.id), 'danger'),
          ),
        ),
      );
      list.replaceChildren(h('table', {}, h('thead', {}, header), h('tbody', {}, ...body)));
    },
  };
}

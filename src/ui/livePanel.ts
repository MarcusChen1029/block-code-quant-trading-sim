import { DEFAULT_WARMUP_BARS } from '../live/session';
import { setExplain } from './explain';
import { h } from './dom';
import { toUtcDateTimeValue, type Badge, type SessionRow } from './liveFormat';
import type { Verdict } from './verdict';
import { VerdictView } from './verdictView';

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
  const pastStart = h('input', { type: 'datetime-local', name: 'livePastStart', step: '60' });
  pastStart.value = toUtcDateTimeValue(nowMs - 3 * 3_600_000);
  const pastField = h('label', { hidden: '' }, h('span', {}, 'From (UTC)'), pastStart);
  const explainStart = () => setExplain(startMode, 'Where the session starts',
    startMode.value === 'past' ? 'The session will first replay the candles since the time you pick, quickly, then carry on live.' : 'The session will start at this moment and follow the live prices.');
  explainStart();
  startMode.addEventListener('change', () => { pastField.hidden = startMode.value !== 'past'; explainStart(); });
  const warmup = h('input', { type: 'number', name: 'liveWarmup', min: '0', max: '5000', step: '1', style: 'width:70px', title: 'Closed bars before the start that warm up the indicators; orders are ignored during warm-up' });
  warmup.value = String(DEFAULT_WARMUP_BARS);
  const start = h('button', { type: 'submit', class: 'run' }, 'Start live session');

  const field = (label: string, el: HTMLElement, tip?: string) => h('label', { 'data-tip': tip }, h('span', { class: tip ? 'field-label' : undefined }, label), el);
  const form = h(
    'form', { class: 'run-form live-form' },
    field('Session name', name, 'A name so you can find this session in the list later. You can leave it empty.'),
    field('Start', startMode, '"Now" starts at this moment. "Past time" replays the candles since the time you pick, quickly, and then carries on live.'),
    pastField,
    field('Warm-up bars', warmup, 'Some helper lines (like moving averages) need a few old candles before they work. These candles are read first, but your robot does not trade on them.'),
    start,
  );
  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    handlers.onStart({ name: name.value, startMode: startMode.value === 'past' ? 'past' : 'now', pastStart: pastStart.value, warmupBars: warmup.value });
  });

  const honesty = h('div', { class: 'live-honesty' }, 'Paper trading: no real orders are ever sent. Pretend money, real Binance prices (market data only).');
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
        list.replaceChildren(h('div', { class: 'hint' }, 'No live sessions yet. Choose a coin, candle size and strategy above, then press "Start live session". It will show up here.'));
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

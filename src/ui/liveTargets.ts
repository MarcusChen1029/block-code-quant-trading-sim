import { ServerClient, type ConnectionState } from '../live/serverClient';
import { h } from './dom';
import { LiveMode, type LiveModeDeps } from './liveMode';
import { loadText, saveText } from './storage';

export const LIVE_TARGET_STORAGE_KEY = 'quant-sim.live-target';
export const SERVER_URL_STORAGE_KEY = 'quant-sim.server-url';

type Target = 'local' | 'server';

const CONNECTION_TEXT: Record<ConnectionState, { text: string; tone: string }> = {
  unknown: { text: 'NOT CONNECTED', tone: 'stopped' },
  'logged-out': { text: 'LOGGED OUT', tone: 'warn' },
  connecting: { text: 'CONNECTING…', tone: 'busy' },
  connected: { text: 'CONNECTED', tone: 'live' },
  reconnecting: { text: 'RECONNECTING…', tone: 'warn' },
  unreachable: { text: 'SERVER UNREACHABLE — RETRYING', tone: 'error' },
};

/**
 * Live mode's target switch: sessions run in **this browser** (LiveMode on local workers, as before) or on a
 * **server (24/7)** (the same LiveMode views fed by the quant-sim server's API and event stream). Served by the
 * server itself, the page defaults to the server; elsewhere (Vite dev, a static copy) the server is optional and
 * needs its URL. Backtests always stay in the browser.
 */
export class LiveTargets {
  private target: Target;
  private active = false;
  private readonly local: LiveMode;
  private remote: LiveMode | null = null;
  private client: ServerClient | null = null;
  private sameOrigin = false;
  private readonly localBox = h('div', {});
  private readonly serverBox = h('div', { hidden: '' });
  private readonly liveBox = h('div', {});
  private readonly buttons: Record<Target, HTMLButtonElement>;
  private readonly urlRow: HTMLElement;
  private readonly urlInput: HTMLInputElement;
  private readonly loginForm: HTMLFormElement;
  private readonly password: HTMLInputElement;
  private readonly logoutButton: HTMLButtonElement;
  private readonly connBadge = h('span', { class: 'live-badge tone-stopped' }, 'NOT CONNECTED');
  private readonly connDetail = h('span', { class: 'live-detail' });

  constructor(container: HTMLElement, private readonly deps: LiveModeDeps) {
    const saved = loadText(LIVE_TARGET_STORAGE_KEY);
    this.target = saved === 'server' ? 'server' : 'local';
    const button = (t: Target, label: string, title: string) => {
      const b = h('button', { type: 'button', title, class: 'target-button' }, label) as HTMLButtonElement;
      b.addEventListener('click', () => this.select(t));
      return b;
    };
    this.buttons = {
      local: button('local', 'This browser', 'Sessions run in this tab (they stop when it closes)'),
      server: button('server', 'Server (24/7)', 'Sessions run on your quant-sim server around the clock; this page views and controls them'),
    };

    this.urlInput = h('input', { type: 'url', name: 'serverUrl', placeholder: 'http://localhost:8787', style: 'width:200px' }) as HTMLInputElement;
    this.urlInput.value = loadText(SERVER_URL_STORAGE_KEY) ?? '';
    const connect = h('button', { type: 'button' }, 'Connect') as HTMLButtonElement;
    connect.addEventListener('click', () => void this.useUrl(this.urlInput.value.trim()));
    this.urlRow = h('div', { class: 'live-row' },
      h('span', { class: 'hint' }, 'Optional: a quant-sim server you run yourself (docs/server.md). Its QS_ALLOWED_ORIGINS must list this page’s origin.'),
      h('label', {}, h('span', {}, 'Server URL'), this.urlInput), connect);

    this.password = h('input', { type: 'password', name: 'serverPassword', autocomplete: 'current-password', style: 'width:160px' }) as HTMLInputElement;
    this.loginForm = h('form', { class: 'run-form', hidden: '' }, h('label', {}, h('span', {}, 'Server password'), this.password), h('button', { type: 'submit', class: 'run' }, 'Log in')) as HTMLFormElement;
    this.loginForm.addEventListener('submit', (ev) => {
      ev.preventDefault();
      void this.login();
    });
    this.logoutButton = h('button', { type: 'button', hidden: '' }, 'Log out') as HTMLButtonElement;
    this.logoutButton.addEventListener('click', () => void this.client?.logout().catch(() => {}));

    this.serverBox.append(this.urlRow, h('div', { class: 'live-row' }, this.loginForm, h('div', { class: 'live-status' }, this.connBadge, this.connDetail), this.logoutButton), this.liveBox);
    container.append(h('div', { class: 'live-row live-targets' }, h('span', { class: 'hint' }, 'Run live sessions on:'), this.buttons.local, this.buttons.server), this.localBox, this.serverBox);
    this.local = new LiveMode(this.localBox, deps);
    this.render();
  }

  get hasRunning(): boolean {
    return this.local.hasRunning;
  }

  /** Local sessions (resume as before) + server detection. Returns whether a local session was resumed. */
  async init(): Promise<boolean> {
    const resumed = await this.local.init();
    const own = new ServerClient('');
    if (await own.probe()) {
      // Served by the quant-sim server: it is the default target (an explicit "This browser" choice is kept).
      this.sameOrigin = true;
      if (loadText(LIVE_TARGET_STORAGE_KEY) === null && !resumed) this.target = 'server';
      await this.attach(own, false);
    } else if (this.urlInput.value.trim() !== '') {
      await this.useUrl(this.urlInput.value.trim(), false);
    }
    this.render();
    if (this.active) this.current().activate();
    return resumed && this.target === 'local';
  }

  activate(): void {
    this.active = true;
    this.current().activate();
  }

  deactivate(): void {
    this.active = false;
    this.local.deactivate();
    this.remote?.deactivate();
  }

  redrawOverlays(): void {
    this.current().redrawOverlays();
  }

  private current(): LiveMode {
    return this.target === 'server' && this.remote ? this.remote : this.local;
  }

  private select(target: Target): void {
    if (target === this.target) return;
    if (this.active) this.current().deactivate();
    this.target = target;
    saveText(LIVE_TARGET_STORAGE_KEY, target);
    this.render();
    if (this.active) this.current().activate();
    if (target === 'server' && !this.client) this.deps.setStatus(this.sameOrigin ? 'Connecting to the server…' : 'Server mode is optional: enter the URL of your quant-sim server and connect.');
  }

  private async useUrl(url: string, report = true): Promise<void> {
    if (!/^https?:\/\/[^\s/]+\/?$/.test(url)) {
      if (report) this.deps.setStatus('Server URL must look like http://localhost:8787', true);
      return;
    }
    saveText(SERVER_URL_STORAGE_KEY, url);
    const client = new ServerClient(url.replace(/\/$/, ''));
    if (!(await client.probe())) {
      if (report) this.deps.setStatus(`No quant-sim server answered at ${url} (is it running, and does QS_ALLOWED_ORIGINS list ${location.origin}?)`, true);
      this.setConnection('unreachable');
      return;
    }
    await this.attach(client, report);
  }

  /** A new server connection: a fresh server-backed LiveMode in the server box. */
  private async attach(client: ServerClient, report: boolean): Promise<void> {
    const wasShown = this.active && this.target === 'server';
    if (wasShown) this.current().deactivate();
    this.client?.disconnect();
    this.remote?.resetRemote();
    this.liveBox.replaceChildren();
    this.client = client;
    this.remote = new LiveMode(this.liveBox, this.deps, client);
    client.onState((state, detail) => {
      if (this.client !== client) return;
      this.setConnection(state, detail);
      if (state === 'logged-out') this.remote?.resetRemote();
    });
    await this.remote.init();
    this.setConnection(client.connection);
    if (report) this.deps.setStatus(client.loggedIn ? 'Connected to the server.' : 'Server found: log in with its password.');
    this.render();
    if (wasShown) this.current().activate();
  }

  private async login(): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.login(this.password.value);
      this.password.value = '';
      this.deps.setStatus('Logged in to the server.');
    } catch (err) {
      this.deps.setStatus(`Login failed: ${err instanceof Error ? err.message : String(err)}`, true);
    }
    this.render();
  }

  private setConnection(state: ConnectionState, detail?: string): void {
    const c = CONNECTION_TEXT[state];
    this.connBadge.textContent = c.text;
    this.connBadge.className = `live-badge tone-${c.tone}`;
    this.connDetail.textContent = detail ?? (this.client ? `server: ${this.client.base || location.origin}` : '');
    this.render();
  }

  private render(): void {
    const server = this.target === 'server';
    this.localBox.hidden = server;
    this.serverBox.hidden = !server;
    this.buttons.local.classList.toggle('selected', !server);
    this.buttons.server.classList.toggle('selected', server);
    this.urlRow.hidden = this.sameOrigin;
    const loggedIn = this.client?.loggedIn ?? false;
    this.loginForm.hidden = !this.client || loggedIn;
    this.logoutButton.hidden = !loggedIn;
    this.liveBox.hidden = !loggedIn;
  }
}

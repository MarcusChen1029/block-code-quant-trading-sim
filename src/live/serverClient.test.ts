import { describe, expect, it } from 'vitest';
import { ServerApiError, ServerClient, type EventSourceLike } from './serverClient';
import { ManualTimers, testSession } from './testing';

class FakeSource implements EventSourceLike {
  readyState = 0;
  onerror: ((ev: Event) => void) | null = null;
  onopen: ((ev: Event) => void) | null = null;
  closed = false;
  readonly listeners = new Map<string, (ev: MessageEvent<string>) => void>();
  constructor(readonly url: string) {}
  addEventListener(type: string, listener: (ev: MessageEvent<string>) => void): void {
    this.listeners.set(type, listener);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data: unknown): void {
    this.listeners.get(type)?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

function setup(meStatus: () => number = () => 200) {
  const sources: FakeSource[] = [];
  const calls: Array<{ url: string; method: string; headers: Record<string, string> }> = [];
  const timers = new ManualTimers();
  const fetchFn = (async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, headers: (init.headers ?? {}) as Record<string, string> });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'x-quant-sim-server': '1' } });
    if (url.endsWith('/api/login')) return JSON.parse(String(init.body)).password === 'right password' ? json(200, { csrf: 'tok' }) : json(401, { error: 'wrong password' });
    if (url.endsWith('/api/me')) return meStatus() === 200 ? json(200, { csrf: 'tok' }) : json(meStatus(), { error: 'x' });
    if (url.endsWith('/api/sessions') && method === 'POST') return json(400, { error: 'strategy cannot start: bad', blockId: 'b7' });
    if (url.includes('/stop')) return json(200, { session: testSession({ status: 'stopped' }) });
    return json(404, { error: 'no' });
  }) as unknown as typeof fetch;
  const client = new ServerClient('http://srv:8787/', {
    fetchFn,
    eventSource: (url) => {
      const s = new FakeSource(url);
      sources.push(s);
      return s;
    },
    setTimeout: (fn) => timers.setTimeout(fn),
    clearTimeout: (id) => timers.clearTimeout(id),
  });
  const states: string[] = [];
  client.onState((s) => states.push(s));
  return { client, sources, calls, timers, states };
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('ServerClient', () => {
  it('probe detects the server and resumes an existing login', async () => {
    const { client, sources, states } = setup();
    expect(await client.probe()).toBe(true);
    expect(client.loggedIn).toBe(true);
    expect(sources[0].url).toBe('http://srv:8787/api/stream');
    sources[0].onopen?.({} as Event);
    expect(states).toEqual(['connecting', 'connected']);
  });

  it('login sends no CSRF; later mutations send it; API errors carry status and block id', async () => {
    const { client, calls } = setup(() => 401);
    await expect(client.login('nope')).rejects.toMatchObject({ status: 401 });
    expect(client.loggedIn).toBe(false);
    await client.login('right password');
    const err = await client.create({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServerApiError);
    expect((err as ServerApiError).blockId).toBe('b7');
    expect(calls.find((c) => c.method === 'POST' && c.url.endsWith('/api/sessions'))?.headers['x-csrf-token']).toBe('tok');
    expect(calls.find((c) => c.url.endsWith('/api/login'))?.headers['x-csrf-token']).toBeUndefined();
  });

  it('watching reopens the stream for that session and routes its messages; terminate stops them', async () => {
    const { client, sources } = setup();
    await client.login('right password');
    const got: unknown[] = [];
    const lists: unknown[] = [];
    client.onSessions((s) => lists.push(s));
    const feed = client.watch('abc', { message: (m) => got.push(m) });
    expect(sources[0].closed).toBe(true);
    const s1 = sources[1];
    expect(s1.url).toBe('http://srv:8787/api/stream?session=abc');
    s1.emit('sessions', { sessions: [] });
    s1.emit('session', { type: 'deleted', id: 'abc' });
    expect(got).toEqual([{ type: 'deleted', id: 'abc' }]);
    expect(lists).toEqual([[]]);
    feed.terminate();
    expect(s1.closed).toBe(true);
    expect(sources[2].url).toBe('http://srv:8787/api/stream');
    s1.emit('session', { type: 'deleted', id: 'abc' }); // from the closed stream: ignored
    expect(got.length).toBe(1);
  });

  it('a dropped stream reconnects with growing backoff; a 401 means logged out and stops retrying', async () => {
    let me = 200;
    const { client, sources, timers, states } = setup(() => me);
    await client.login('right password');
    sources[0].onerror?.({} as Event);
    await flush();
    expect(states.at(-1)).toBe('reconnecting');
    expect(timers.timeouts.size).toBe(1);
    timers.runTimeouts();
    expect(sources.length).toBe(2);
    sources[1].onerror?.({} as Event);
    await flush();
    timers.runTimeouts();
    expect(sources.length).toBe(3);
    sources[2].onopen?.({} as Event);
    expect(states.at(-1)).toBe('connected');
    me = 401;
    sources[2].onerror?.({} as Event);
    await flush();
    expect(states.at(-1)).toBe('logged-out');
    expect(client.loggedIn).toBe(false);
    expect(timers.timeouts.size).toBe(0);
  });
});

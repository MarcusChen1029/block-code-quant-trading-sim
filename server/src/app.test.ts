import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MINUTE } from '../../src/live/testing';
import { DEFAULT_BROKER_CONFIG } from '../../src/engine/types';
import { ensurePassword, login, PASSWORD, startHarness, tempDir, type Harness } from './testing';

let h: Harness;
let tmp: ReturnType<typeof tempDir>;

beforeEach(async () => {
  tmp = tempDir();
  const dbPath = join(tmp.dir, 'db.sqlite');
  await ensurePassword(dbPath);
  h = await startHarness({ serverNow: 300 * MINUTE }, dbPath, { loginMaxFailures: 3 });
});

afterEach(async () => {
  await h.close();
  tmp.remove();
});

const sma = { kind: 'builtin-sma-cross', params: { fast: 5, slow: 20, sizePct: 50 } };
const validSession = { name: 't', symbol: 'BTCUSDT', timeframe: '1m', startMs: 250 * MINUTE, warmupBars: 10, brokerConfig: DEFAULT_BROKER_CONFIG, strategy: sma };

describe('server auth', () => {
  it('every API route answers 401 without a login (and marks itself as the quant-sim server)', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/api/me'], ['GET', '/api/sessions'], ['POST', '/api/sessions'], ['GET', '/api/sessions/abc'],
      ['POST', '/api/sessions/abc/stop'], ['DELETE', '/api/sessions/abc'], ['GET', '/api/stream'], ['POST', '/api/logout'],
      ['GET', '/api/nope'], ['GET', '/api'],
    ];
    for (const [method, path] of routes) {
      const res = await fetch(`${h.base}${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: method === 'GET' ? undefined : '{}' });
      expect(res.status, `${method} ${path}`).toBe(401);
      expect(res.headers.get('x-quant-sim-server')).toBe('1');
      await res.text();
    }
    const forged = await fetch(`${h.base}/api/sessions`, { headers: { Cookie: 'qs_session=forged-token' } });
    expect(forged.status).toBe(401);
  });

  it('a wrong password is 401; after N failures the address is rate limited (429), even for the right password', async () => {
    const attempt = (password: string) => fetch(`${h.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password }) });
    for (let i = 0; i < 3; i++) expect((await attempt('wrong password!')).status).toBe(401);
    const limited = await attempt(PASSWORD);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('login sets an HttpOnly SameSite=Strict cookie (Secure only behind HTTPS); logout ends it', async () => {
    const res = await fetch(`${h.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: PASSWORD }) });
    const cookie = res.headers.get('set-cookie')!;
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).not.toMatch(/Secure/);
    const proxied = await fetch(`${h.base}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', 'X-Forwarded-For': '203.0.113.9' }, body: JSON.stringify({ password: PASSWORD }) });
    expect(proxied.headers.get('set-cookie')).toMatch(/; Secure/);
    const c = await login(h.base);
    expect((await c.call('GET', '/api/me')).status).toBe(200);
    expect((await c.call('POST', '/api/logout')).status).toBe(204);
    expect((await c.call('GET', '/api/me')).status).toBe(401);
  });

  it('mutating requests need the CSRF token (403 without or with a wrong one) and same-origin', async () => {
    const c = await login(h.base);
    expect((await c.call('POST', '/api/sessions', validSession, { 'x-csrf-token': '' })).status).toBe(403);
    expect((await c.call('POST', '/api/sessions', validSession, { 'x-csrf-token': 'not-the-token' })).status).toBe(403);
    expect((await c.call('DELETE', '/api/sessions/abc', undefined, { 'x-csrf-token': '' })).status).toBe(403);
    expect((await c.call('POST', '/api/sessions', validSession, { Origin: 'https://evil.example' })).status).toBe(403);
    expect((await c.call('GET', '/api/sessions')).status).toBe(200); // reads need no token
  });

  it('malformed, oversized and invalid payloads are rejected', async () => {
    const c = await login(h.base);
    expect((await c.call('POST', '/api/sessions', '{not json')).status).toBe(400);
    expect((await c.call('POST', '/api/sessions', validSession, { 'Content-Type': 'text/plain' })).status).toBe(415);
    const huge = { ...validSession, name: 'x'.repeat(3 * 1024 * 1024) };
    expect((await c.call('POST', '/api/sessions', huge)).status).toBe(413);
    const bad: Array<[string, unknown]> = [
      ['symbol', { ...validSession, symbol: 'btc/usdt; DROP' }],
      ['timeframe', { ...validSession, timeframe: '7m' }],
      ['warmup', { ...validSession, warmupBars: 1e9 }],
      ['future start', { ...validSession, startMs: 10_000 * MINUTE }],
      ['leverage', { ...validSession, brokerConfig: { ...DEFAULT_BROKER_CONFIG, leverage: 1000 } }],
      ['extra field', { ...validSession, admin: true }],
      ['strategy kind', { ...validSession, strategy: { kind: 'eval', code: 'process.exit()' } }],
      ['proto key', { ...validSession, strategy: { kind: 'blocks', workspace: JSON.parse('{"blocks":{"__proto__":{"x":1}}}') } }],
      ['bad workspace', { ...validSession, strategy: { kind: 'blocks', workspace: { blocks: { blocks: [{ type: 'no_such_block', id: 'b1' }] } } } }],
      ['bad pine id', { ...validSession, strategy: { kind: 'blocks', workspace: {}, pineScripts: [{ id: '../x', source: '' }] } }],
      ['name', { ...validSession, name: 7 }],
    ];
    for (const [what, body] of bad) {
      const r = await c.call('POST', '/api/sessions', body);
      expect(r.status, what).toBe(400);
      expect(typeof r.json.error, what).toBe('string');
    }
    expect((await c.call('GET', '/api/sessions/..%2F..%2Fetc')).status).toBe(400);
    expect((await c.call('GET', '/api/sessions')).json.sessions).toEqual([]);
  });

  it('only allow-listed origins get CORS headers', async () => {
    const res = await fetch(`${h.base}/api/me`, { headers: { Origin: 'http://localhost:5177' } });
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    await res.text();
  });
});

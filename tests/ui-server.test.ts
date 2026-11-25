import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { uiHandler } from '../src/ui/server.ts';
import { buildTimeline } from '../src/ui/timeline.ts';

let server: http.Server, port: number;
const secret = 'test-secret-0123456789';
beforeAll(async () => {
  server = http.createServer((req, res) => void handler(req, res));
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => server.close());
const handler: ReturnType<typeof uiHandler> = (req, res) => uiHandler({
  timeline: async () => buildTimeline([], '2026-11-23'), detail: async (q) => (q.ref === 'DocumentReference/abc' ? { title: 'Progress note', kind: 'Note', facts: [], sections: [{ title: 'Text', type: 'text', text: 'seen today' }] } : undefined), secret, hosts: [`127.0.0.1:${port}`],
})(req, res);
const get = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: 'manual' });
const cookie = { cookie: `ga_ui=${secret}` };

test('nothing is served without this run\'s secret', async () => {
  for (const p of ['/', '/app.js', '/api/timeline', '/api/detail?ref=DocumentReference/a']) expect((await get(p)).status, p).toBe(403);
  expect((await get('/?k=wrong')).status).toBe(403);
  expect((await get('/api/timeline', { cookie: 'ga_ui=wrong' })).status).toBe(403);
});

test('the printed link sets the cookie and drops the secret from the address', async () => {
  const r = await get(`/?k=${secret}`);
  expect(r.status).toBe(303);
  expect(r.headers.get('location')).toBe('/');
  expect(r.headers.get('set-cookie')).toMatch(/^ga_ui=test-secret-0123456789; HttpOnly; SameSite=Strict/);
});

test('with the cookie: the page, its scripts and the data, with a closed content policy', async () => {
  const page = await get('/', cookie);
  expect(page.status).toBe(200);
  expect(page.headers.get('content-security-policy')).toMatch(/^default-src 'none'/);
  expect(await page.text()).toMatch('<canvas id="c">');
  for (const p of ['/app.js', '/scale.js', '/style.css']) expect((await get(p, cookie)).status, p).toBe(200);
  const t = await (await get('/api/timeline', cookie)).json();
  expect(t).toMatchObject({ today: '2026-11-23', encounters: [], labs: [] });
  expect(await (await get('/api/detail?ref=DocumentReference/abc', cookie)).json()).toMatchObject({ kind: 'Note', sections: [{ text: 'seen today' }] });
  expect((await get('/api/detail?ref=DocumentReference/none', cookie)).status).toBe(404);
});

test('a detail is asked for one thing at a time, only by GET, only under this host name', async () => {
  expect((await get('/api/detail', cookie)).status).toBe(400);
  expect((await get('/api/detail?ref=DocumentReference/a&list=index', cookie)).status).toBe(400);
  expect((await get('/api/detail?ref=DocumentReference/../x', cookie)).status).toBe(400);
  expect((await get('/nope', cookie)).status).toBe(404);
  expect((await fetch(`http://127.0.0.1:${port}/api/timeline`, { method: 'POST', headers: cookie })).status).toBe(405);
  // another name for this address (DNS rebinding) is refused even with the cookie
  const status = await new Promise<number>((ok) => http.get({ host: '127.0.0.1', port, path: '/api/timeline', headers: { ...cookie, host: 'evil.example' } }, (r) => { r.resume(); ok(r.statusCode ?? 0); }));
  expect(status).toBe(403);
});

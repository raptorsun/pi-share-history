import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { createService } from '../server/index.mjs';
import extension from '../extension/index.ts';

const key = 'test-subpath-key-at-least-24-characters';
test('prefixed routes, canonical redirect, share links, assets, and SSE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-prefix-'));
  const service = createService({ dataDir: dir, uploadKey: key, publicUrl: 'https://example.com/pi-history/' });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${service.server.address().port}`, base = origin + '/pi-history';
  let share;
  try {
    for (const path of ['/', '/api/shares', '/app.js', '/pi-history-other/health']) assert.equal((await fetch(origin + path)).status, 404);
    const redirect = await fetch(base + '?test=1', { redirect: 'manual' });
    assert.equal(redirect.status, 308); assert.equal(redirect.headers.get('location'), '/pi-history/?test=1');
    assert.equal((await fetch(base + '/health')).status, 200);
    share = await fetch(base + '/api/shares', { method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify({ title: 'Prefix test' }) }).then(r => r.json());
    assert.equal(share.url, `https://example.com/pi-history/s/${share.id}`);
    for (const path of ['/', `/s/${share.id}`]) {
      const html = await fetch(base + path).then(r => r.text());
      assert.match(html, /data-base-path="\/pi-history"/);
      assert.match(html, /href="\/pi-history\/style.css"/);
      assert.match(html, /src="\/pi-history\/app.js"/);
      assert.match(html, /src="\/pi-history\/theme.js"/);
      assert.match(html, /id="theme-toggle"/);
      assert.match(html, /id="markdown-toggle"/);
      assert.match(html, /src="\/pi-history\/markdown.js"/);
      assert.match(html, /src="\/pi-history\/vendor\/purify.min.js"/);
      assert.match(html, /href="\/pi-history\/"/);
      assert.equal(html.includes('__BASE_PATH__'), false);
    }
    for (const asset of ['app.js', 'theme.js', 'markdown.js', 'vendor/marked.umd.js', 'vendor/purify.min.js', 'style.css']) assert.equal((await fetch(base + '/' + asset)).status, 200);
    const stream = await fetch(`${base}/api/shares/${share.id}/events`);
    const reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: update/);
    await reader.cancel();
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('viewer uses its configured prefix for API, directory links, and live events', async () => {
  const code = readFileSync(new URL('../web/app.js', import.meta.url), 'utf8');
  const id = 'a'.repeat(32);
  for (const prefix of ['', '/pi-history']) for (const viewer of [false, true]) {
    const requests = [], events = [], links = [];
    const makeNode = () => ({ textContent: '', children: [], dataset: {}, setAttribute() {}, addEventListener() {}, append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; } });
    const elements = Object.fromEntries(['search', 'follow', 'records', 'status', 'title', 'draft', 'draft-text', 'markdown-toggle'].map(name => [name, makeNode()]));
    elements.search.value = '';
    const context = {
      document: { documentElement: { dataset: { basePath: prefix } }, body: { scrollHeight: 100 }, getElementById: name => elements[name], createElement: tag => { const node = makeNode(); if (tag === 'a') links.push(node); return node; } },
      location: { pathname: prefix + (viewer ? `/s/${id}` : '/') },
      window: { addEventListener() {}, scrollTo() {} },
      fetch: async url => { requests.push(url); return { ok: true, json: async () => viewer ? { title: 'Test', records: [], updated: Date.now() } : [{ id, title: 'Test', updated: Date.now() }] }; },
      EventSource: class { constructor(url) { events.push(url); } addEventListener() {} },
      AbortSignal, setInterval() {}, setTimeout() {}, clearTimeout() {},
    };
    vm.runInNewContext(code, context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(requests[0], prefix + '/api/shares' + (viewer ? `/${id}` : ''));
    if (viewer) assert.equal(events[0], `${prefix}/api/shares/${id}/events`);
    else assert.equal(links[0].href, `${prefix}/s/${id}`);
  }
});

for (const destination of ['https://logs.example.com/pi-history/', 'https://other.example.com/pi-history']) test(`owner state migration respects origin: ${destination}`, async () => {
  const previous = process.env.PI_SHARE_URL;
  process.env.PI_SHARE_URL = destination;
  try {
    const id = 'b'.repeat(32), entries = [{ type: 'custom', customType: 'pi-share-history-owner-v1', data: { id, ownerKey: 'private', server: 'https://logs.example.com', url: `https://logs.example.com/s/${id}` } }];
    const hooks = new Map();
    extension({ on: (name, handler) => hooks.set(name, handler), registerCommand() {}, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) });
    await hooks.get('session_start')({}, { sessionManager: { getBranch: () => entries }, ui: { setStatus() {} } });
    const sameOrigin = new URL(destination).origin === 'https://logs.example.com';
    const expected = sameOrigin ? 'https://logs.example.com/pi-history' : 'https://logs.example.com';
    assert.equal(entries.length, sameOrigin ? 2 : 1);
    assert.equal(entries.at(-1).data.server, expected);
    assert.equal(entries.at(-1).data.url, `${expected}/s/${id}`);
    assert.equal(entries.at(-1).data.ownerKey, 'private');
  } finally {
    if (previous === undefined) delete process.env.PI_SHARE_URL;
    else process.env.PI_SHARE_URL = previous;
  }
});

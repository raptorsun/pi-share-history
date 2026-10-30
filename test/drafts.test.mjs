import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import extension from '../extension/index.ts';
import { createService } from '../server/index.mjs';

const key = 'draft-test-key-at-least-24-characters';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await pause(30); }
  assert.fail('Timed out waiting for draft update');
}
async function fixture(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'pi-draft-'));
  let service;
  let base;
  async function open() {
    service = createService({ dataDir: dir, uploadKey: key, ...options });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${service.server.address().port}`;
  }
  await open();
  return {
    get service() { return service; }, get base() { return base; },
    async api(path, data, token = '') {
      return fetch(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}` }, body: data === undefined ? undefined : JSON.stringify(data) });
    },
    async restart() { await service.close(); await open(); },
    async close() { await service.close(); rmSync(dir, { recursive: true, force: true }); },
  };
}

test('drafts are owner-only writes, ephemeral, revision-ordered, and atomically cleared on submission', async () => {
  const f = await fixture({ draftTtlMs: 100 });
  try {
    const share = await f.api('/api/shares', { title: 'Draft test' }, key).then(r => r.json());
    const path = `/api/shares/${share.id}`;
    const post = (action, body, token = share.ownerKey) => f.api(path + '/' + action, body, token);
    const get = () => f.api(path).then(r => r.json());
    assert.equal((await post('draft', { revision: 1, text: 'unsent secret' }, key)).status, 401);
    assert.equal((await post('draft', { revision: 1, text: 'unsent secret' })).status, 409);
    await post('records', { records: [], live: true });
    assert.equal((await post('draft', { revision: 1, text: 'unsent secret' })).status, 200);
    assert.equal((await get()).draft.text, 'unsent secret');
    assert.equal((await get()).records.length, 0);
    assert.equal(f.service.db.prepare('SELECT count(*) AS n FROM records').get().n, 0);
    assert.equal(JSON.stringify(f.service.db.prepare('SELECT * FROM shares').all()).includes('unsent secret'), false);
    await post('draft', { revision: 0, text: 'stale preview' });
    assert.equal((await get()).draft.text, 'unsent secret');
    const submitted = { id: 'message:user:1', kind: 'user', text: 'sent message' };
    await post('records', { records: [submitted], live: true, draft: { revision: 2, text: '' } });
    let data = await get(); assert.equal(data.draft, null); assert.equal(data.records.length, 1);
    // A lost acknowledgement/retry cannot resurrect an older draft or duplicate history.
    await post('draft', { revision: 1, text: 'unsent secret' });
    await post('records', { records: [submitted], live: true, draft: { revision: 2, text: '' } });
    data = await get(); assert.equal(data.draft, null); assert.equal(data.records.length, 1);
    assert.equal((await post('draft', { revision: 3, text: 'x'.repeat(24001) })).status, 400);
    assert.equal((await post('draft', { revision: 1.2, text: 'bad' })).status, 400);
    await post('draft', { revision: 3, text: 'expires' });
    await pause(140); assert.equal((await get()).draft, null);
    await post('draft', { revision: 4, text: 'not persisted' });
    await f.restart(); data = await get();
    assert.equal(data.draft, null); assert.equal(data.records.length, 1);
    await post('draft', { revision: 5, text: 'clear on stop' });
    await post('stop', {}); assert.equal((await get()).draft, null);
    await post('records', { records: [], live: true });
    await post('draft', { revision: 6, text: 'clear on revoke' });
    await post('revoke', {}); assert.equal((await f.api(path)).status, 404);
  } finally { await f.close(); }
});

test('extension draft sharing is opt-in, supports edits/deletions, and submits once', async () => {
  const f = await fixture();
  const previous = { url: process.env.PI_SHARE_URL, key: process.env.PI_SHARE_KEY };
  process.env.PI_SHARE_URL = f.base; process.env.PI_SHARE_KEY = key;
  let editor = 'private until enabled', reads = 0, allow = true, command;
  const hooks = new Map(), entries = [], notices = [];
  const ctx = {
    mode: 'tui', cwd: '/tmp/project', sessionManager: { getBranch: () => entries },
    ui: { getEditorText: () => { reads++; return editor; }, setStatus() {}, confirm: async () => allow, notify: (message, level) => notices.push({ message, level }) },
  };
  extension({ on: (name, handler) => hooks.set(name, handler), registerCommand: (_name, options) => { command = options.handler; }, appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }) });
  try {
    await hooks.get('session_start')({}, ctx);
    await command('start', ctx);
    const share = entries[0].data;
    const get = () => f.api(`/api/shares/${share.id}`).then(r => r.json());
    await pause(450); assert.equal(reads, 0); assert.equal((await get()).draft, null);
    allow = false; await command('drafts on', ctx);
    await pause(450); assert.equal(reads, 0);
    allow = true; await command('drafts on', ctx);
    assert.match(notices.at(-1).message, /PUBLIC/);
    await until(async () => (await get()).draft?.text === editor);
    editor = 'edited draft'; await until(async () => (await get()).draft?.text === editor);
    editor = ''; await until(async () => (await get()).draft === null);
    editor = '/secret-command do not preview'; await pause(450); assert.equal((await get()).draft, null);
    editor = 'submitted text'; await until(async () => (await get()).draft?.text === editor);
    await hooks.get('input')({ source: 'interactive', text: editor }, ctx);
    const message = { role: 'user', timestamp: 12345, content: editor };
    await hooks.get('message_start')({ message }, ctx);
    await hooks.get('message_end')({ message }, ctx);
    await until(async () => (await get()).records.length === 1);
    let data = await get(); assert.equal(data.draft, null); assert.equal(data.records.length, 1);
    // Simulate the editor retaining its old buffer briefly after submission.
    await pause(450); assert.equal((await get()).draft, null);
    editor = 'another draft'; await until(async () => (await get()).draft?.text === editor);
    await command('drafts off', ctx); assert.equal((await get()).draft, null);
    editor = 'private again'; await pause(450); assert.equal((await get()).draft, null);
    await command('drafts on', ctx); await until(async () => (await get()).draft?.text === editor);
    await command('stop', ctx); data = await get(); assert.equal(data.draft, null); assert.equal(data.live, false);
    await hooks.get('session_shutdown')({}, ctx);
    await hooks.get('session_start')({}, ctx);
    await command('start', ctx);
    const oldReads = reads; await pause(450); assert.equal(reads, oldReads);
    ctx.mode = 'rpc'; await command('drafts on', ctx); assert.equal(notices.at(-1).level, 'error');
  } finally {
    await hooks.get('session_shutdown')({}, ctx);
    if (previous.url === undefined) delete process.env.PI_SHARE_URL; else process.env.PI_SHARE_URL = previous.url;
    if (previous.key === undefined) delete process.env.PI_SHARE_KEY; else process.env.PI_SHARE_KEY = previous.key;
    await f.close();
  }
});

test('viewer keeps draft outside history and removes it on submission, expiry, or disconnect', async () => {
  const id = 'a'.repeat(32), listeners = {};
  const makeNode = () => ({ textContent: '', children: [], hidden: false, classList: { toggle() {} }, parts: {}, addEventListener() {}, append(...nodes) { this.children.push(...nodes); }, replaceChildren(...nodes) { this.children = nodes; }, querySelector(name) { return this.parts[name] ??= makeNode(); } });
  const elements = Object.fromEntries(['search', 'follow', 'records', 'status', 'title', 'draft', 'draft-text'].map(name => [name, makeNode()]));
  elements.search.value = '';
  let payload = { title: 'Draft test', updated: Date.now(), records: [], draft: { text: '<script>unsent</script>', expiresIn: 8000 } }, expiry, source;
  vm.runInNewContext(readFileSync(new URL('../web/app.js', import.meta.url), 'utf8'), {
    document: { documentElement: { dataset: { basePath: '/pi-history' } }, body: { scrollHeight: 100 }, getElementById: name => elements[name], createElement: makeNode },
    location: { pathname: `/pi-history/s/${id}` }, window: { addEventListener() {}, scrollTo() {} },
    fetch: async () => ({ ok: true, json: async () => payload }),
    EventSource: class { constructor() { source = this; } addEventListener(name, fn) { listeners[name] = fn; } close() {} },
    AbortSignal, setInterval() {}, setTimeout(fn) { expiry = fn; }, clearTimeout() {},
  });
  const tick = () => new Promise(resolve => setImmediate(resolve));
  await tick();
  assert.equal(elements['draft-text'].textContent, '<script>unsent</script>');
  assert.equal(elements.records.children.length, 0); assert.equal(elements.draft.hidden, false);
  payload = { ...payload, draft: null, records: [{ id: 'user:1', kind: 'user', label: 'user', text: 'sent once', timestamp: Date.now() }] };
  listeners.update(); await tick();
  assert.equal(elements.draft.hidden, true); assert.equal(elements['draft-text'].textContent, ''); assert.equal(elements.records.children.length, 1);
  payload = { ...payload, draft: { text: 'next draft', expiresIn: 8000 } };
  listeners.update(); await tick(); expiry(); assert.equal(elements.draft.hidden, true);
  listeners.update(); await tick(); source.onerror(); assert.equal(elements.draft.hidden, true);
});

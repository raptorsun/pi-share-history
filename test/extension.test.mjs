import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import extension from '../extension/index.ts';
import { createService } from '../server/index.mjs';

for (const prefix of ['', '/pi-history']) test(`extension lifecycle at ${prefix || '/'}; resumed session stays offline`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-ext-'));
  const key = 'extension-test-team-key-at-least-24-characters';
  const service = createService({ dataDir: dir, uploadKey: key, publicUrl: `http://localhost:9080${prefix}` });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}${prefix}`;
  const previous = { url: process.env.PI_SHARE_URL, key: process.env.PI_SHARE_KEY };
  process.env.PI_SHARE_URL = base + '/'; process.env.PI_SHARE_KEY = key;
  const entries = [{ type: 'message', message: { role: 'user', timestamp: 100, content: 'Historical prompt' } }];
  const hooks = new Map(), notifications = [];
  let command;
  const pi = {
    on: (name, handler) => hooks.set(name, handler),
    registerCommand: (_name, options) => { command = options.handler; },
    appendEntry: (customType, data) => entries.push({ type: 'custom', customType, data }),
  };
  const ctx = { cwd: '/tmp/project', sessionManager: { getBranch: () => entries }, ui: { setStatus() {}, confirm: async () => true, notify: (text, level) => notifications.push({ text, level }) } };
  try {
    extension(pi);
    await hooks.get('session_start')({}, ctx);
    await command('start', ctx);
    assert.equal(notifications.at(-1).level, 'info');
    const share = entries.find(entry => entry.type === 'custom').data;
    assert.equal(share.server, base);
    assert.equal(new URL(share.url).pathname, `${prefix}/s/${share.id}`);
    await hooks.get('message_update')({ message: { role: 'assistant', timestamp: 200, content: [{ type: 'text', text: 'Streaming…' }] } }, ctx);
    await hooks.get('message_end')({ message: { role: 'assistant', timestamp: 200, content: [{ type: 'text', text: 'Complete' }] } }, ctx);
    await command('stop', ctx);
    let data = await fetch(base + `/api/shares/${share.id}`).then(r => r.json());
    assert.equal(data.live, false); assert.equal(data.records.length, 2);
    assert.equal(data.records[1].text, 'Complete');
    assert.equal(JSON.stringify(data).includes(share.ownerKey), false);
    await hooks.get('session_shutdown')({}, ctx);
    await hooks.get('session_start')({}, ctx);
    await hooks.get('message_end')({ message: { role: 'user', timestamp: 300, content: 'Must remain private' } }, ctx);
    await hooks.get('session_shutdown')({}, ctx);
    data = await fetch(base + `/api/shares/${share.id}`).then(r => r.json());
    assert.equal(data.records.length, 2);
    await command('revoke', ctx);
    assert.equal((await fetch(base + `/api/shares/${share.id}`)).status, 404);
    await command('delete', ctx);
    assert.equal(entries.at(-1).data, null);
  } finally {
    await hooks.get('session_shutdown')?.({}, ctx);
    if (previous.url === undefined) delete process.env.PI_SHARE_URL; else process.env.PI_SHARE_URL = previous.url;
    if (previous.key === undefined) delete process.env.PI_SHARE_KEY; else process.env.PI_SHARE_KEY = previous.key;
    await service.close(); rmSync(dir, { recursive: true, force: true });
  }
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createService } from '../server/index.mjs';
import { messageRecord, toolRecord } from '../extension/records.mjs';

const key = 'test-team-key-at-least-24-characters';
test('multi-publisher history, auth, SSE, persistence, revocation and deletion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pi-share-'));
  let service, base;
  async function open() {
    service = createService({ dataDir: dir, uploadKey: key });
    await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${service.server.address().port}`;
  }
  const api = (path, method = 'GET', data, token = '') => fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  try {
    await open();
    assert.equal((await api('/api/shares', 'POST', { title: 'bad' })).status, 401);
    const create = () => api('/api/shares', 'POST', { title: '<script>public title</script>' }, key).then(r => r.json());
    const a = await create(), b = await create();
    const path = `/api/shares/${a.id}`;
    assert.notEqual(a.id, b.id);
    assert.equal((await api(path + '/records', 'POST', { records: [], live: true }, b.ownerKey)).status, 401);
    const payload = { records: [{ id: 'm1', kind: 'user', text: '<img src=x onerror=alert(1)>' }], live: true };
    assert.equal((await api(path + '/records', 'POST', payload, a.ownerKey)).status, 200);
    await api(path + '/records', 'POST', payload, a.ownerKey);
    let data = await api(path).then(r => r.json());
    assert.equal(data.records.length, 1); assert.equal(data.live, true); assert.equal(data.ownerKey, undefined);
    const controller = new AbortController();
    const stream = await fetch(base + path + '/events', { signal: controller.signal });
    assert.match(stream.headers.get('content-type'), /event-stream/);
    const reader = stream.body.getReader();
    assert.match(new TextDecoder().decode((await reader.read()).value), /event: update/);
    controller.abort(); await reader.cancel().catch(() => {});
    await api(path + '/stop', 'POST', undefined, a.ownerKey);
    assert.equal((await api(path).then(r => r.json())).live, false);
    await service.close(); await open();
    data = await api(path).then(r => r.json()); assert.equal(data.records.length, 1);
    assert.equal((await api('/api/shares').then(r => r.json())).length, 2);
    assert.equal((await api(path + '/revoke', 'POST', undefined, a.ownerKey)).status, 200);
    assert.equal((await api(path)).status, 404);
    assert.equal((await api('/api/shares').then(r => r.json())).length, 1);
    assert.equal((await api(path, 'DELETE', undefined, a.ownerKey)).status, 200);
    assert.equal((await api(path)).status, 404);
    assert.equal((await api('/')).headers.get('content-security-policy').includes("script-src 'self'"), true);
    assert.equal((await api('/api/shares/' + b.id + '/records', 'POST', { records: [{ id: 42 }], live: true }, b.ownerKey)).status, 400);
  } finally { if (service?.server.listening) await service.close(); rmSync(dir, { recursive: true, force: true }); }
});
test('record allowlist omits credentials, metadata, images, and thinking', () => {
  assert.equal(messageRecord({ role: 'system', content: 'secret' }), null);
  const record = messageRecord({ role: 'assistant', timestamp: 123, details: { key: 'secret' }, content: [{ type: 'text', text: 'Hello' }, { type: 'thinking', thinking: 'secret' }, { type: 'image', data: 'secret' }], thinkingSignature: 'secret' });
  assert.equal(JSON.stringify(record).includes('secret'), false);
  assert.match(record.text, /Hello/);
  assert.equal(record.id, messageRecord({ role: 'assistant', timestamp: 123, content: 'updated' }).id);
  assert.equal(toolRecord({ type: 'tool_execution_end', toolCallId: 'a', toolName: 'bash', result: { content: [{ type: 'text', text: 'done' }], details: { key: 'secret' } } }).text, 'done');
  assert.ok(Buffer.byteLength(JSON.stringify(messageRecord({ role: 'user', timestamp: 1, content: '😀'.repeat(100000) }))) < 128 * 1024);
});
test('storage quota rollback and config validation', async () => {
  assert.throws(() => createService({ uploadKey: 'short' }), /24/);
  const dir = mkdtempSync(join(tmpdir(), 'pi-quota-'));
  const service = createService({ dataDir: dir, uploadKey: key, maxRecords: 1 });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  const post = (path, data, token) => fetch(base + path, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(data) });
  try {
    const share = await post('/api/shares', { title: 'Quota' }, key).then(r => r.json());
    const result = await post(`/api/shares/${share.id}/records`, { live: true, records: [{ id: '1', kind: 'user' }, { id: '2', kind: 'user' }] }, share.ownerKey);
    assert.equal(result.status, 413);
    assert.equal((await fetch(base + `/api/shares/${share.id}`).then(r => r.json())).records.length, 0);
  } finally { await service.close(); rmSync(dir, { recursive: true, force: true }); }
});

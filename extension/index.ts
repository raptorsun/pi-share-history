import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { basename } from 'node:path';
import { messageRecord, toolRecord } from './records.mjs';

type Share = { id: string; ownerKey: string; url: string; server: string };
const STATE = 'pi-share-history-owner-v1';

export default function (pi: ExtensionAPI) {
  let share: Share | undefined;
  let ctx: ExtensionContext | undefined;
  let live = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let pending = new Map<string, any>();
  let sending: Promise<void> | undefined;
  let lastError = '';
  const server = () => {
    if (!process.env.PI_SHARE_URL) throw new Error('Set PI_SHARE_URL to your sharing service URL before starting Pi');
    const url = new URL(process.env.PI_SHARE_URL);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new Error('PI_SHARE_URL requires HTTPS (HTTP is permitted only on localhost)');
    }
    const path = url.pathname.replace(/\/+$/, '');
    if (url.search || url.hash || url.username || url.password || (path && !/^(\/[A-Za-z0-9_-]+)+$/.test(path))) throw new Error('PI_SHARE_URL must be an HTTPS URL with an optional simple path prefix, without credentials, query or fragment');
    return url.origin + path;
  };
  async function request(base: string, path: string, key: string, payload?: unknown, method = 'POST') {
    const response = await fetch(base + path, { method, redirect: 'error', signal: AbortSignal.timeout(5000), headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: payload === undefined ? undefined : JSON.stringify(payload) });
    if (!response.ok) throw new Error(`Sharing server returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
    return response.json();
  }
  function status() {
    ctx?.ui.setStatus('pi-share-history', share ? `share: ${lastError ? 'sync error' : pending.size ? `${pending.size} pending` : live ? 'live' : 'saved'}` : undefined);
  }
  function put(record: any) { if (record) { pending.set(record.id, record); status(); } }
  function capture(context: ExtensionContext) {
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type === 'message') put(messageRecord(entry.message));
      else if (entry.type === 'compaction' || entry.type === 'branch_summary') {
        put({ id: `entry:${entry.id}`, kind: entry.type, timestamp: Date.parse(entry.timestamp), text: entry.summary.slice(0, 24000), label: entry.type });
      }
    }
  }
  function flush(): Promise<void> {
    if (sending) return sending;
    if (!share) return Promise.resolve();
    const current = share;
    sending = (async () => {
      // Bounded batches. Upserts make retrying a lost acknowledgement safe.
      do {
        const batch: any[] = []; let bytes = 0;
        for (const record of pending.values()) {
          const size = Buffer.byteLength(JSON.stringify(record));
          if (batch.length && (bytes + size > 800000 || batch.length >= 100)) break;
          bytes += size; batch.push(record);
        }
        await request(current.server, `/api/shares/${current.id}/records`, current.ownerKey, { records: batch, live });
        for (const record of batch) if (pending.get(record.id) === record) pending.delete(record.id);
        lastError = '';
      } while (pending.size);
    })().catch(error => {
      lastError = String(error.message || error);
      throw error;
    }).finally(() => { sending = undefined; status(); });
    return sending;
  }
  function startTimer() {
    if (!timer) timer = setInterval(() => { void flush().catch(() => {}); }, 1500);
    timer?.unref();
  }
  async function stop() {
    live = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    await flush();
    if (share) await request(share.server, `/api/shares/${share.id}/stop`, share.ownerKey);
    status();
  }
  pi.on('session_start', (_event, context) => {
    ctx = context; share = undefined; pending = new Map(); live = false;
    for (const entry of context.sessionManager.getBranch()) {
      if (entry.type === 'custom' && entry.customType === STATE) share = entry.data as Share | undefined;
    }
    // Explicit configuration can move a saved share to another path on the
    // same origin, but must never redirect owner credentials to another host.
    if (share && process.env.PI_SHARE_URL) {
      const destination = server();
      if (share.server !== destination && new URL(share.server).origin === new URL(destination).origin) {
        share = { ...share, server: destination, url: `${destination}/s/${share.id}` };
        pi.appendEntry(STATE, share);
      }
    }
    status(); // Resume never automatically starts publishing.
  });
  pi.on('message_start', (event) => { if (live) put(messageRecord(event.message)); });
  pi.on('message_update', (event) => { if (live) put(messageRecord(event.message)); });
  pi.on('message_end', (event) => { if (live) put(messageRecord(event.message)); });
  for (const name of ['tool_execution_start', 'tool_execution_update', 'tool_execution_end'] as const) {
    pi.on(name, event => { if (live) put(toolRecord(event)); });
  }
  pi.on('session_tree', (_event, context) => {
    if (live) {
      put({ id: `branch:${Date.now()}`, kind: 'notice', timestamp: Date.now(), text: 'Publisher navigated to another branch. Previously shared history remains visible.', label: 'Branch change' });
      capture(context);
    }
  });
  pi.on('agent_settled', (_event, context) => { if (live) capture(context); });
  pi.on('session_shutdown', async () => {
    try { await stop(); }
    catch { ctx?.ui.notify('Share final sync failed. The server retains only acknowledged uploads; resume this session and run /share upload to retry history.', 'warning'); }
    ctx?.ui.setStatus('pi-share-history', undefined);
  });
  pi.registerCommand('share', {
    description: 'Share current session: start | upload | stop | status | revoke | delete',
    handler: async (args, context) => {
      ctx = context;
      const action = args.trim() || 'status';
      try {
        if (action === 'status') {
          return context.ui.notify(share ? `${share.url}\n${live ? 'Live sharing enabled' : 'Live sharing stopped'}; ${pending.size} pending updates${lastError ? `\n${lastError}` : ''}` : 'Not shared. Use /share start or /share upload.', 'info');
        }
        if (action === 'stop') { await stop(); context.ui.notify('Live updates stopped; the saved transcript is still public.', 'info'); return; }
        if (action === 'revoke' || action === 'delete') {
          if (!share) throw new Error('No share for this session');
          if (!await context.ui.confirm(`${action} shared transcript?`, 'This affects the hosted copy, not your local Pi history.')) return;
          live = false; if (timer) clearInterval(timer); timer = undefined;
          if (sending) await sending.catch(() => {});
          await request(share.server, `/api/shares/${share.id}${action === 'revoke' ? '/revoke' : ''}`, share.ownerKey, undefined, action === 'delete' ? 'DELETE' : 'POST');
          pending.clear();
          if (action === 'delete') { share = undefined; pi.appendEntry(STATE, null); }
          status(); context.ui.notify(`Share ${action === 'delete' ? 'deleted' : 'revoked; use /share delete to remove stored data'}.`, 'info'); return;
        }
        if (action !== 'start' && action !== 'upload') throw new Error('Usage: /share start|upload|stop|status|revoke|delete');
        if (!await context.ui.confirm('Publish current session publicly?', 'The current branch, prompts, source code and tool output will be readable by anyone on the internet. There is no automatic secret redaction. System prompts, thinking, images and internal metadata are omitted. Previously published history is retained.')) return;
        if (!share) {
          const key = process.env.PI_SHARE_KEY;
          if (!key) throw new Error('Set PI_SHARE_KEY to the team upload key before starting Pi');
          const base = server();
          const result = await request(base, '/api/shares', key, { title: `${basename(context.cwd)} — ${new Date().toISOString()}` });
          share = { id: result.id, ownerKey: result.ownerKey, url: result.url, server: base };
          pi.appendEntry(STATE, share);
        }
        live = action === 'start'; capture(context);
        // Start retries before the first request so transient failures do not strand live shares.
        if (live) startTimer();
        if (!live && timer) { clearInterval(timer); timer = undefined; }
        await flush();
        if (!live) await request(share.server, `/api/shares/${share.id}/stop`, share.ownerKey);
        context.ui.notify(`${live ? 'Live share' : 'Saved transcript'}: ${share.url}`, 'info');
      } catch (error: any) { context.ui.notify(error.message || String(error), 'error'); }
    },
  });
}

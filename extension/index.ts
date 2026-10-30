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
  let draftsEnabled = false;
  let draftTimer: ReturnType<typeof setInterval> | undefined;
  let pendingDraft: { revision: number; text: string } | undefined;
  let draftRevision = 0;
  let draftText = '';
  let draftHeartbeat = 0;
  let submittedText: string | undefined;
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
    ctx?.ui.setStatus('pi-share-history', share ? `share: ${lastError ? 'sync error' : pending.size ? `${pending.size} pending` : live ? 'live' : 'saved'}${draftsEnabled ? ' · DRAFTS PUBLIC' : ''}` : undefined);
  }
  function setDraft(text: string, force = false) {
    text = text.slice(0, 24000);
    if (!force && text === draftText) return;
    draftText = text;
    draftHeartbeat = Date.now();
    draftRevision = Math.max(draftRevision + 1, Date.now());
    pendingDraft = { revision: draftRevision, text };
  }
  function disableDrafts() {
    const wasEnabled = draftsEnabled;
    draftsEnabled = false;
    if (draftTimer) clearInterval(draftTimer);
    draftTimer = undefined;
    submittedText = undefined;
    if (wasEnabled || draftText || pendingDraft) setDraft('', true);
    status();
  }
  function pollDraft() {
    if (!live || !draftsEnabled || ctx?.mode !== 'tui') return;
    const text = ctx.ui.getEditorText();
    // Never republish an editor buffer that has just been submitted but not
    // cleared yet. Also keep slash/shell command drafts out of the preview.
    if (submittedText !== undefined && text !== submittedText) submittedText = undefined;
    const preview = text === submittedText || /^[/!]/.test(text.trimStart()) ? '' : text;
    setDraft(preview, Boolean(preview) && Date.now() - draftHeartbeat >= 2000);
    if (pendingDraft) void flush().catch(() => {});
  }
  function clearSubmittedDraft(text?: string) {
    if (!draftsEnabled) return;
    submittedText = text ?? ctx?.ui.getEditorText();
    setDraft('', true);
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
        const draft = pendingDraft;
        if (!batch.length && draft && live) {
          await request(current.server, `/api/shares/${current.id}/draft`, current.ownerKey, draft);
        } else {
          await request(current.server, `/api/shares/${current.id}/records`, current.ownerKey, { records: batch, live, draft });
        }
        for (const record of batch) if (pending.get(record.id) === record) pending.delete(record.id);
        if (pendingDraft === draft) pendingDraft = undefined;
        lastError = '';
      } while (pending.size || pendingDraft);
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
    disableDrafts();
    live = false;
    if (timer) clearInterval(timer);
    timer = undefined;
    await flush();
    if (share) await request(share.server, `/api/shares/${share.id}/stop`, share.ownerKey);
    status();
  }
  pi.on('session_start', (_event, context) => {
    disableDrafts(); pendingDraft = undefined; draftText = '';
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
  pi.on('input', event => {
    if (live && event.source === 'interactive') clearSubmittedDraft(event.text);
  });
  pi.on('message_start', (event) => {
    if (live) {
      if (event.message.role === 'user' && draftText && messageRecord(event.message)?.text === draftText) clearSubmittedDraft();
      put(messageRecord(event.message));
    }
  });
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
    description: 'Share current session: start | upload | stop | status | revoke | delete | drafts on|off',
    handler: async (args, context) => {
      ctx = context;
      const action = args.trim() || 'status';
      try {
        if (action === 'drafts on' || action === 'drafts off') {
          if (action === 'drafts off') {
            disableDrafts(); await flush();
            context.ui.notify('Draft sharing disabled; any submitted history remains public.', 'info'); return;
          }
          if (!live || !share) throw new Error('Run /share start before enabling draft sharing');
          if (context.mode !== 'tui') throw new Error('Draft sharing is only available in Pi interactive terminal mode');
          if (!await context.ui.confirm('Share what you type before sending?', 'Anyone viewing this public share can read your unsent text, including text you later delete. Draft previews are temporary, but viewers can copy them.')) return;
          draftsEnabled = true; submittedText = undefined;
          if (!draftTimer) draftTimer = setInterval(pollDraft, 400);
          draftTimer.unref(); status();
          context.ui.notify('Draft sharing ON — unsent text is PUBLIC. Use /share drafts off to disable.', 'warning');
          return;
        }
        if (action === 'status') {
          return context.ui.notify(share ? `${share.url}\n${live ? 'Live sharing enabled' : 'Live sharing stopped'}; draft sharing ${draftsEnabled ? 'ON — PUBLIC' : 'off'}; ${pending.size} pending updates${lastError ? `\n${lastError}` : ''}` : 'Not shared. Use /share start or /share upload.', 'info');
        }
        if (action === 'stop') { await stop(); context.ui.notify('Live updates stopped; the saved transcript is still public.', 'info'); return; }
        if (action === 'revoke' || action === 'delete') {
          if (!share) throw new Error('No share for this session');
          if (!await context.ui.confirm(`${action} shared transcript?`, 'This affects the hosted copy, not your local Pi history.')) return;
          disableDrafts();
          live = false; if (timer) clearInterval(timer); timer = undefined;
          if (sending) await sending.catch(() => {});
          await request(share.server, `/api/shares/${share.id}${action === 'revoke' ? '/revoke' : ''}`, share.ownerKey, undefined, action === 'delete' ? 'DELETE' : 'POST');
          pending.clear(); pendingDraft = undefined;
          if (action === 'delete') { share = undefined; pi.appendEntry(STATE, null); }
          status(); context.ui.notify(`Share ${action === 'delete' ? 'deleted' : 'revoked; use /share delete to remove stored data'}.`, 'info'); return;
        }
        if (action !== 'start' && action !== 'upload') throw new Error('Usage: /share start|upload|stop|status|revoke|delete|drafts on|off');
        if (!await context.ui.confirm('Publish current session publicly?', 'The current branch, prompts, source code and tool output will be readable by anyone on the internet. There is no automatic secret redaction. System prompts, thinking, images and internal metadata are omitted. Previously published history is retained.')) return;
        if (!share) {
          const key = process.env.PI_SHARE_KEY;
          if (!key) throw new Error('Set PI_SHARE_KEY to the team upload key before starting Pi');
          const base = server();
          const result = await request(base, '/api/shares', key, { title: `${basename(context.cwd)} — ${new Date().toISOString()}` });
          share = { id: result.id, ownerKey: result.ownerKey, url: result.url, server: base };
          pi.appendEntry(STATE, share);
        }
        if (action === 'upload') disableDrafts();
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

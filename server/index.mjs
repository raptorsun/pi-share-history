import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hash = value => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(24).toString('base64url');
const equal = (a, b) => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
const failure = (status, message) => Object.assign(new Error(message), { status });

export function createService({ dataDir = './data', uploadKey, publicUrl = 'http://localhost:9080', maxShares = 1000, maxRecords = 10000, maxShareBytes = 20 * 1024 * 1024, draftTtlMs = 8000 } = {}) {
  if (!uploadKey || uploadKey.length < 24) throw new Error('UPLOAD_KEY must contain at least 24 characters');
  const publicAddress = new URL(publicUrl);
  if (!['http:', 'https:'].includes(publicAddress.protocol) || publicAddress.search || publicAddress.hash || publicAddress.username || publicAddress.password) throw new Error('PUBLIC_URL must be an HTTP(S) URL without credentials, query or fragment');
  const basePath = publicAddress.pathname.replace(/\/+$/, '');
  if (basePath && !/^(\/[A-Za-z0-9_-]+)+$/.test(basePath)) throw new Error('PUBLIC_URL path must contain simple slash-separated segments');
  publicUrl = publicAddress.origin + basePath;
  mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(resolve(dataDir, 'history.sqlite'));
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS shares (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL, live INTEGER NOT NULL DEFAULT 0, revoked INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS records (share TEXT NOT NULL REFERENCES shares(id) ON DELETE CASCADE, id TEXT NOT NULL, body TEXT NOT NULL, position INTEGER NOT NULL, PRIMARY KEY (share,id));
    CREATE INDEX IF NOT EXISTS record_order ON records(share,position);`);
  // Drafts and revision tombstones are memory-only: never written to SQLite.
  const drafts = new Map();
  const validateDraft = draft => {
    if (!draft || !Number.isSafeInteger(draft.revision) || draft.revision < 0 || typeof draft.text !== 'string' || draft.text.length > 24000) throw failure(400, 'Invalid draft');
    return { revision: draft.revision, text: draft.text };
  };
  const updateDraft = (id, draft) => {
    if (draft && (!drafts.has(id) || draft.revision > drafts.get(id).revision)) {
      drafts.set(id, { ...draft, expiresAt: Date.now() + draftTtlMs });
    }
  };
  const publicDraft = id => {
    const draft = drafts.get(id);
    const expiresIn = draft ? draft.expiresAt - Date.now() : 0;
    return draft?.text && expiresIn > 0 ? { text: draft.text, expiresIn } : null;
  };
  const viewers = new Map();
  const assets = new Map(['index.html', 'app.js', 'theme.js', 'style.css'].map(name => [name, readFileSync(new URL(`../web/${name}`, import.meta.url))]));
  const get = id => db.prepare('SELECT * FROM shares WHERE id=?').get(id);
  const notify = (id, event = 'update') => {
    for (const res of viewers.get(id) || []) {
      if (res.writableLength > 65536) res.destroy();
      else res.write(`event: ${event}\ndata: {}\n\n`);
    }
  };
  const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  async function body(req) {
    let size = 0; const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw failure(413, 'Upload batch exceeds 1 MiB');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString()); }
    catch { throw failure(400, 'Invalid JSON'); }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
    try {
      const url = new URL(req.url, 'http://localhost');
      if (basePath && url.pathname === basePath) {
        res.writeHead(308, { Location: `${basePath}/${url.search}` });
        return res.end();
      }
      if (basePath && !url.pathname.startsWith(basePath + '/')) throw failure(404, 'Not found');
      const path = url.pathname.slice(basePath.length);
      const token = (req.headers.authorization || '').replace(/^Bearer /, '');
      if (req.method === 'GET' && path === '/health') return json(res, 200, { ok: true });
      if (req.method === 'GET' && path === '/api/shares') {
        return json(res, 200, db.prepare('SELECT id,title,created,updated,live FROM shares WHERE revoked=0 ORDER BY updated DESC LIMIT 200').all().map(s => ({ ...s, live: Boolean(s.live && Date.now() - s.updated < 20000) })));
      }
      if (req.method === 'POST' && path === '/api/shares') {
        if (!equal(token, uploadKey)) throw failure(401, 'Invalid team upload key');
        if (db.prepare('SELECT count(*) AS n FROM shares').get().n >= maxShares) throw failure(507, 'Share limit reached');
        const input = await body(req);
        if (!input || typeof input.title !== 'string' || input.title.length > 200) throw failure(400, 'Invalid title');
        const id = secret(), ownerKey = secret(), now = Date.now();
        db.prepare('INSERT INTO shares (id,owner,title,created,updated) VALUES (?,?,?,?,?)').run(id, hash(ownerKey), input.title, now, now);
        return json(res, 201, { id, ownerKey, url: `${publicUrl}/s/${id}` });
      }
      const match = path.match(/^\/api\/shares\/([\w-]{32})(?:\/(records|events|stop|revoke|draft))?$/);
      if (match) {
        const [, id, action] = match;
        const share = get(id);
        if (!share) throw failure(404, 'Share not found');
        const isRead = req.method === 'GET';
        if (!isRead && !equal(hash(token), share.owner)) throw failure(401, 'Invalid share owner key');
        if (req.method === 'DELETE' && !action) {
          db.prepare('DELETE FROM shares WHERE id=?').run(id); drafts.delete(id); notify(id, 'removed');
          for (const client of viewers.get(id) || []) client.end();
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && action === 'revoke') {
          db.prepare('UPDATE shares SET revoked=1,live=0 WHERE id=?').run(id); drafts.delete(id); notify(id, 'removed');
          for (const client of viewers.get(id) || []) client.end();
          return json(res, 200, { ok: true });
        }
        if (share.revoked) throw failure(404, 'Share not found');
        if (req.method === 'GET' && !action) {
          return json(res, 200, { id, title: share.title, updated: share.updated, live: Boolean(share.live && Date.now() - share.updated < 20000), draft: publicDraft(id), records: db.prepare('SELECT body FROM records WHERE share=? ORDER BY position').all(id).map(r => JSON.parse(r.body)) });
        }
        if (req.method === 'GET' && action === 'events') {
          const count = [...viewers.values()].reduce((n, set) => n + set.size, 0);
          if (count >= 200) throw failure(503, 'Viewer limit reached');
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write('event: update\ndata: {}\n\n');
          if (!viewers.has(id)) viewers.set(id, new Set());
          viewers.get(id).add(res);
          req.on('close', () => { viewers.get(id)?.delete(res); if (!viewers.get(id)?.size) viewers.delete(id); });
          return;
        }
        if (req.method === 'POST' && action === 'stop') {
          db.prepare('UPDATE shares SET live=0 WHERE id=?').run(id);
          const draft = drafts.get(id);
          if (draft) drafts.set(id, { ...draft, text: '' });
          notify(id); return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && action === 'draft') {
          const draft = validateDraft(await body(req));
          if (!share.live || Date.now() - share.updated >= 20000) throw failure(409, 'Drafts require a live share');
          updateDraft(id, draft);
          db.prepare('UPDATE shares SET updated=? WHERE id=?').run(Date.now(), id);
          notify(id);
          return json(res, 200, { ok: true });
        }
        if (req.method === 'POST' && action === 'records') {
          const input = await body(req);
          if (!input || !Array.isArray(input.records) || input.records.length > 200 || typeof input.live !== 'boolean') throw failure(400, 'Invalid records batch');
          const draft = input.draft === undefined ? undefined : validateDraft(input.draft);
          const rows = input.records.map(record => {
            if (!record || typeof record.id !== 'string' || record.id.length > 200 || typeof record.kind !== 'string') throw failure(400, 'Invalid record');
            const text = JSON.stringify(record);
            if (Buffer.byteLength(text) > 128 * 1024) throw failure(413, 'Record exceeds 128 KiB');
            return [record.id, text];
          });
          db.exec('BEGIN');
          try {
            let position = db.prepare('SELECT coalesce(max(position),0) AS n FROM records WHERE share=?').get(id).n;
            const insert = db.prepare('INSERT INTO records (share,id,body,position) VALUES (?,?,?,?) ON CONFLICT(share,id) DO UPDATE SET body=excluded.body');
            for (const [key, text] of rows) insert.run(id, key, text, ++position);
            const totals = db.prepare('SELECT count(*) AS n,coalesce(sum(length(CAST(body AS BLOB))),0) AS bytes FROM records WHERE share=?').get(id);
            if (totals.n > maxRecords || totals.bytes > maxShareBytes) throw failure(413, 'Share storage limit reached');
            db.prepare('UPDATE shares SET updated=?,live=? WHERE id=?').run(Date.now(), input.live ? 1 : 0, id);
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          // Publish history and its draft-clear in one snapshot, after commit.
          updateDraft(id, draft);
          if (!input.live && drafts.has(id)) drafts.set(id, { ...drafts.get(id), text: '' });
          notify(id); return json(res, 200, { ok: true });
        }
      }
      if (req.method === 'GET') {
        const name = path === '/' || /^\/s\/[\w-]{32}$/.test(path) ? 'index.html' : path.slice(1);
        if (assets.has(name)) {
          res.writeHead(200, { 'Content-Type': name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html; charset=utf-8' });
          return res.end(name === 'index.html' ? assets.get(name).toString().replaceAll('__BASE_PATH__', basePath) : assets.get(name));
        }
      }
      throw failure(404, 'Not found');
    } catch (error) {
      if (res.headersSent) return res.destroy();
      if (!error.status) console.error(error);
      json(res, error.status || 500, { error: error.status ? error.message : 'Internal error' });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  const heartbeat = setInterval(() => { for (const id of viewers.keys()) notify(id); }, 10000);
  heartbeat.unref();
  const expiry = setInterval(() => {
    for (const [id, draft] of drafts) {
      if (draft.text && draft.expiresAt <= Date.now()) {
        drafts.set(id, { ...draft, text: '' }); notify(id);
      }
    }
  }, 1000);
  expiry.unref();
  return { server, db, close: async () => {
    clearInterval(heartbeat); clearInterval(expiry);
    for (const set of viewers.values()) for (const res of set) res.end();
    await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); });
    db.close();
  } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const service = createService({ dataDir: process.env.DATA_DIR, uploadKey: process.env.UPLOAD_KEY, publicUrl: process.env.PUBLIC_URL });
  service.server.listen(Number(process.env.PORT || 9080), process.env.HOST || '0.0.0.0', () => console.log(`Pi history listening on port ${process.env.PORT || 9080}`));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await service.close(); process.exit(0); });
}

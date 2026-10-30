const $ = id => document.getElementById(id);
const basePath = document.documentElement.dataset.basePath || '';
const id = location.pathname.slice(basePath.length).match(/^\/s\/([\w-]{32})$/)?.[1];
const nodes = new Map();
let follow = true, busy = false, again = false, stream, draftExpiry;
const markdownKey = 'pi-share-history-markdown';
let markdownEnabled = true, currentRecords = [];
const bodyCache = new WeakMap();
try { markdownEnabled = localStorage.getItem(markdownKey) !== 'off'; } catch { /* Storage can be blocked. */ }
const setText = (element, text) => { if (element.textContent !== text) element.textContent = text; };
const when = value => new Date(value).toLocaleString();
function renderBody(node, record) {
  const text = (record.text || '') + (record.errorMessage ? `\n${record.errorMessage}` : '');
  const useMarkdown = markdownEnabled && ['user', 'assistant'].includes(record.kind);
  const previous = bodyCache.get(node);
  if (previous?.text === text && previous.useMarkdown === useMarkdown) return;
  const plain = node.querySelector('pre');
  const formatted = node.querySelector('.markdown-content');
  setText(plain, text);
  const rendered = useMarkdown && Boolean(window.PiMarkdown?.render(formatted, text));
  plain.hidden = rendered;
  formatted.hidden = !rendered;
  if (!rendered) formatted.replaceChildren();
  bodyCache.set(node, { text, useMarkdown });
}
function updateMarkdownButton() {
  $('markdown-toggle').textContent = `Markdown: ${markdownEnabled ? 'On' : 'Off'}`;
  $('markdown-toggle').setAttribute('aria-pressed', String(markdownEnabled));
}
updateMarkdownButton();
$('markdown-toggle').addEventListener('click', () => {
  markdownEnabled = !markdownEnabled;
  try { localStorage.setItem(markdownKey, markdownEnabled ? 'on' : 'off'); } catch { /* Keep the page-local choice. */ }
  updateMarkdownButton();
  for (const record of currentRecords) {
    const node = nodes.get(record.id);
    if (node) renderBody(node, record);
  }
  applySearch();
});
function renderDraft(draft) {
  clearTimeout(draftExpiry);
  const visible = Boolean(id && draft?.text && draft.expiresIn > 0);
  $('draft').hidden = !visible;
  setText($('draft-text'), visible ? draft.text : '');
  if (visible) draftExpiry = setTimeout(() => renderDraft(null), draft.expiresIn);
}
function applySearch() {
  const query = $('search').value.toLowerCase();
  for (const node of $('records').children) node.hidden = !node.textContent.toLowerCase().includes(query);
}
$('search').addEventListener('input', applySearch);
$('follow').hidden = !id;
$('follow').onclick = () => { follow = true; window.scrollTo(0, document.body.scrollHeight); $('follow').textContent = 'Following live'; };
window.addEventListener('scroll', () => {
  follow = window.innerHeight + window.scrollY >= document.body.scrollHeight - 100;
  $('follow').textContent = follow ? 'Following live' : 'Follow live';
}, { passive: true });
async function refresh() {
  if (busy) { again = true; return; }
  busy = true;
  try {
    const response = await fetch(basePath + (id ? `/api/shares/${id}` : '/api/shares'), { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      if (response.status === 404) {
        stream?.close(); $('records').replaceChildren(); nodes.clear(); currentRecords = [];
        throw new Error('Transcript deleted, revoked, or not found');
      }
      throw new Error(`Server returned ${response.status}`);
    }
    const data = await response.json();
    if (!id) {
      $('status').textContent = 'Public session directory';
      $('records').replaceChildren(...data.map(share => {
        const article = document.createElement('article'), link = document.createElement('a'), meta = document.createElement('p');
        link.href = `${basePath}/s/${share.id}`; link.textContent = share.title;
        meta.textContent = `${share.live ? '● Live' : 'Saved'} · Updated ${when(share.updated)}`;
        article.append(link, meta); return article;
      }));
    } else {
      // Clear the temporary preview before rendering the submitted history.
      // Both changes paint together; drafts never become transcript nodes.
      renderDraft(data.draft);
      document.title = `${data.title} — Pi history`;
      setText($('title'), data.title);
      setText($('status'), `${data.live ? '● Live' : 'Offline — saved transcript'} · Synced ${when(data.updated)}`);
      currentRecords = data.records;
      for (const record of currentRecords) {
        let node = nodes.get(record.id);
        if (!node) {
          node = document.createElement('article');
          const heading = document.createElement('h2'), meta = document.createElement('p');
          const details = document.createElement('details'), summary = document.createElement('summary'), output = document.createElement('pre'), formatted = document.createElement('div');
          formatted.className = 'markdown-content'; formatted.hidden = true;
          details.open = !['tool', 'toolResult'].includes(record.kind);
          summary.textContent = 'Content / output'; details.append(summary, output, formatted); node.append(heading, meta, details);
          nodes.set(record.id, node); $('records').append(node);
        }
        node.classList.toggle('error', Boolean(record.error));
        setText(node.querySelector('h2'), record.label || record.kind);
        setText(node.querySelector('p'), [when(record.timestamp), record.model, record.status].filter(Boolean).join(' · '));
        renderBody(node, record);
      }
    }
    applySearch();
    if (id && follow) window.scrollTo(0, document.body.scrollHeight);
  } catch (error) { renderDraft(null); $('status').textContent = error.message + ' — reconnecting if available'; }
  finally { busy = false; if (again) { again = false; void refresh(); } }
}
void refresh();
if (id) {
  stream = new EventSource(`${basePath}/api/shares/${id}/events`);
  stream.addEventListener('update', () => void refresh());
  stream.addEventListener('removed', () => { renderDraft(null); stream.close(); $('records').replaceChildren(); nodes.clear(); currentRecords = []; $('status').textContent = 'This transcript was revoked or deleted.'; });
  stream.onerror = () => { renderDraft(null); $('status').textContent = 'Connection interrupted — reconnecting…'; };
} else setInterval(refresh, 10000);

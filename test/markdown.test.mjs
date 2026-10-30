import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

const readWeb = name => readFileSync(new URL(`../web/${name}`, import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
function browser() {
  const dom = new JSDOM(readWeb('index.html').replaceAll('__BASE_PATH__', '/pi-history'), { url: 'https://logs.example.com/pi-history/s/' + 'a'.repeat(32), runScripts: 'outside-only' });
  for (const name of ['vendor/marked.umd.js', 'vendor/purify.min.js', 'markdown.js']) dom.window.eval(readWeb(name));
  return dom;
}

test('browser renders Markdown headings, lists, links, tables, and escaped fenced code', () => {
  const dom = browser();
  try {
    const { window } = dom, output = window.document.createElement('div');
    const source = '# Heading\n\n**bold** and *italic*\n\n- one\n- two\n\n[site](https://example.com)\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\n<script>alert(1)</script>\n```';
    assert.equal(window.PiMarkdown.render(output, source), true);
    assert.equal(output.querySelector('h1').textContent, 'Heading');
    assert.equal(output.querySelector('strong').textContent, 'bold');
    assert.equal(output.querySelector('em').textContent, 'italic');
    assert.equal(output.querySelectorAll('li').length, 2);
    assert.equal(output.querySelector('a').href, 'https://example.com/');
    assert.equal(output.querySelectorAll('td').length, 2);
    assert.equal(output.querySelector('pre code').textContent.trim(), '<script>alert(1)</script>');
    assert.equal(output.querySelector('script'), null);
  } finally { dom.window.close(); }
});

test('raw HTML, scripts, unsafe links, clobbering attributes, and tracking images are blocked', () => {
  const dom = browser();
  try {
    const { window } = dom, output = window.document.createElement('div');
    const attacks = [
      '<img src=x onerror=alert(1)>', '<svg onload=alert(1)>', '<script>alert(1)</script>',
      '<form id=records><input name=attributes></form>', '[bad](javascript:alert%281%29)',
      '[bad](data:text/html,evil)', '[bad](jav&#x61;script:alert%281%29)',
      '![tracking](https://tracker.example/pixel.png)',
    ];
    for (const source of attacks) {
      assert.equal(window.PiMarkdown.render(output, source), true);
      assert.equal(output.querySelector('script,img,svg,form,input,iframe,style'), null);
      assert.equal(output.querySelector('[onerror],[onload],[id],[name]'), null);
      for (const link of output.querySelectorAll('a[href]')) assert.doesNotMatch(link.getAttribute('href'), /^(javascript|data):/i);
    }
  } finally { dom.window.close(); }
});

test('sanitizer is a separate defense after parsing; missing or broken renderer fails closed', () => {
  const dom = browser();
  try {
    const { window } = dom, output = window.document.createElement('div');
    window.marked = { ...window.marked, Marked: class { parse() { return '<p id="records" onclick="alert(1)">safe</p><img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a>'; } } };
    window.eval(readWeb('markdown.js'));
    assert.equal(window.PiMarkdown.render(output, 'test'), true);
    assert.equal(output.querySelector('p').textContent, 'safe');
    assert.equal(output.querySelector('[id],[onclick],img,a[href]'), null);
    window.DOMPurify = undefined;
    assert.equal(window.PiMarkdown.render(output, 'test'), false);
    window.marked = undefined;
    window.eval(readWeb('markdown.js'));
    assert.equal(window.PiMarkdown.render(output, 'test'), false);
  } finally { dom.window.close(); }
});

async function viewer({ saved, blocked = false, missing = false } = {}) {
  const dom = browser(), { window } = dom;
  if (saved) window.localStorage.setItem('pi-share-history-markdown', saved);
  if (blocked) Object.defineProperty(window, 'localStorage', { get() { throw new Error('Storage blocked'); } });
  if (missing) window.PiMarkdown = undefined;
  let payload = {
    title: 'Rendering test', updated: Date.now(), draft: { text: '**unsent**', expiresIn: 8000 },
    records: [
      { id: 'a', kind: 'assistant', label: 'assistant', text: '# Reply\n\n**bold**', timestamp: 1 },
      { id: 'u', kind: 'user', label: 'user', text: '*hello*', timestamp: 2 },
      { id: 't', kind: 'toolResult', label: 'bash', text: '**literal tool output**', timestamp: 3 },
    ],
  };
  let fetches = 0, source;
  window.fetch = async () => { fetches++; return { ok: true, json: async () => payload }; };
  window.AbortSignal = AbortSignal;
  window.setInterval = () => 1;
  window.scrollTo = () => {};
  window.EventSource = class {
    listeners = {};
    constructor() { source = this; }
    addEventListener(name, fn) { this.listeners[name] = fn; }
    close() {}
  };
  window.eval(readWeb('app.js'));
  await tick();
  return { dom, window, get fetches() { return fetches; }, async update(records) { payload = { ...payload, records }; source.listeners.update(); await tick(); } };
}

test('Markdown defaults on, toggles existing messages locally, persists, and leaves tools/drafts plain', async () => {
  const ui = await viewer();
  try {
    const document = ui.window.document, button = document.getElementById('markdown-toggle');
    const [assistant, user, tool] = document.querySelectorAll('#records > article');
    assert.equal(button.getAttribute('aria-pressed'), 'true');
    assert.equal(assistant.querySelector('.markdown-content h1').textContent, 'Reply');
    assert.equal(user.querySelector('.markdown-content em').textContent, 'hello');
    assert.equal(tool.querySelector('pre').hidden, false);
    assert.equal(tool.querySelector('pre').textContent, '**literal tool output**');
    assert.equal(tool.querySelector('.markdown-content').hidden, true);
    assert.equal(document.getElementById('draft-text').textContent, '**unsent**');
    assistant.querySelector('details').open = false;
    const requests = ui.fetches;
    button.click();
    assert.equal(button.getAttribute('aria-pressed'), 'false');
    assert.equal(assistant.querySelector('pre').hidden, false);
    assert.equal(assistant.querySelector('pre').textContent, '# Reply\n\n**bold**');
    assert.equal(assistant.querySelector('.markdown-content').hidden, true);
    assert.equal(assistant.querySelector('details').open, false);
    assert.equal(ui.fetches, requests); // No API calls or server-side rendering on toggle.
    assert.equal(ui.window.localStorage.getItem('pi-share-history-markdown'), 'off');
    button.click();
    assert.equal(assistant.querySelector('.markdown-content strong').textContent, 'bold');
    await ui.update([{ id: 'a', kind: 'assistant', text: '## Streamed update', timestamp: 1 }]);
    assert.equal(assistant.querySelector('.markdown-content h2').textContent, 'Streamed update');
  } finally { ui.dom.window.close(); }
});

test('saved plain-text preference, blocked storage, and missing libraries work safely', async () => {
  for (const options of [{ saved: 'off' }, { blocked: true }, { missing: true }]) {
    const ui = await viewer(options);
    try {
      const assistant = ui.window.document.querySelector('#records > article');
      assert.equal(assistant.querySelector('pre').hidden, Boolean(options.blocked));
      ui.window.document.getElementById('markdown-toggle').click();
      assert.notEqual(ui.window.document.getElementById('status').textContent, 'Connecting…');
    } finally { ui.dom.window.close(); }
  }
});

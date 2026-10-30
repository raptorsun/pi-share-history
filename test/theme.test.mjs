import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../web/theme.js', import.meta.url), 'utf8');
const key = 'pi-share-history-theme';
function setup({ dark = false, saved, blocked = false, loading = false } = {}) {
  const storage = new Map(saved === undefined ? [] : [[key, saved]]);
  const listeners = {}, documentListeners = {}, mediaListeners = {}, buttonListeners = {};
  const button = { attributes: {}, addEventListener: (type, fn) => { buttonListeners[type] = fn; }, setAttribute(name, value) { this.attributes[name] = value; } };
  const root = { dataset: {} };
  const media = { matches: dark, addEventListener: (type, fn) => { mediaListeners[type] = fn; } };
  vm.runInNewContext(code, {
    window: { matchMedia: query => { assert.equal(query, '(prefers-color-scheme: dark)'); return media; }, addEventListener: (type, fn) => { listeners[type] = fn; } },
    document: { documentElement: root, readyState: loading ? 'loading' : 'complete', getElementById: id => { assert.equal(id, 'theme-toggle'); return button; }, addEventListener: (type, fn) => { documentListeners[type] = fn; } },
    localStorage: {
      getItem: name => { if (blocked) throw new Error('Storage blocked'); return storage.get(name) ?? null; },
      setItem: (name, value) => { if (blocked) throw new Error('Storage blocked'); storage.set(name, value); },
      removeItem: name => { if (blocked) throw new Error('Storage blocked'); storage.delete(name); },
    },
  });
  return { root, button, storage, click: () => buttonListeners.click(), load: () => documentListeners.DOMContentLoaded(), changeSystem(value) { media.matches = value; mediaListeners.change(); }, storageEvent: event => listeners.storage(event) };
}

for (const dark of [false, true]) test(`theme defaults to system (${dark ? 'dark' : 'light'}) and follows changes`, () => {
  const ui = setup({ dark });
  assert.equal(ui.root.dataset.theme, dark ? 'dark' : 'light');
  assert.match(ui.button.textContent, /System/);
  ui.changeSystem(!dark);
  assert.equal(ui.root.dataset.theme, dark ? 'light' : 'dark');
  assert.equal(ui.storage.size, 0);
});

for (const dark of [false, true]) test(`theme button switches colors, persists, and returns to system (${dark})`, () => {
  const ui = setup({ dark });
  ui.click();
  assert.equal(ui.root.dataset.theme, dark ? 'light' : 'dark');
  assert.equal(ui.storage.get(key), dark ? 'light' : 'dark');
  assert.equal(setup({ dark, saved: ui.storage.get(key) }).root.dataset.theme, dark ? 'light' : 'dark');
  ui.click();
  assert.equal(ui.root.dataset.theme, dark ? 'dark' : 'light');
  ui.click();
  assert.match(ui.button.textContent, /System/);
  assert.equal(ui.storage.has(key), false);
  ui.changeSystem(!dark);
  assert.equal(ui.root.dataset.theme, dark ? 'light' : 'dark');
});

test('saved override survives OS changes; storage events synchronize tabs', () => {
  const ui = setup({ saved: 'light', dark: true });
  ui.changeSystem(false); ui.changeSystem(true);
  assert.equal(ui.root.dataset.theme, 'light');
  ui.storageEvent({ key, newValue: 'dark' });
  assert.equal(ui.root.dataset.theme, 'dark');
  ui.storageEvent({ key, newValue: null });
  assert.match(ui.button.textContent, /System/);
  ui.changeSystem(false);
  assert.equal(ui.root.dataset.theme, 'light');
  ui.storageEvent({ key: null, newValue: null });
  assert.match(ui.button.textContent, /System/);
});

test('blocked storage and invalid preferences do not break the controls', () => {
  const ui = setup({ blocked: true });
  ui.click(); assert.equal(ui.root.dataset.theme, 'dark');
  ui.changeSystem(false); assert.equal(ui.root.dataset.theme, 'dark');
  assert.match(setup({ saved: 'invalid' }).button.textContent, /System/);
});

test('theme applies before DOM ready and the button connects afterward', () => {
  const ui = setup({ saved: 'dark', loading: true });
  assert.equal(ui.root.dataset.theme, 'dark');
  ui.load();
  assert.match(ui.button.textContent, /dark/);
  assert.match(ui.button.attributes['aria-label'], /Color theme/);
  ui.click(); assert.equal(ui.root.dataset.theme, 'light');
});

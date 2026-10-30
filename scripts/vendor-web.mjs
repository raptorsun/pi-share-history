// Commit these browser assets so production needs no npm install, build, or CDN.
import { copyFileSync, mkdirSync } from 'node:fs';
const root = new URL('../', import.meta.url);
mkdirSync(new URL('web/vendor/', root), { recursive: true });
for (const [source, target] of [
  ['marked/lib/marked.umd.js', 'marked.umd.js'],
  ['marked/LICENSE', 'marked.LICENSE'],
  ['dompurify/dist/purify.min.js', 'purify.min.js'],
  ['dompurify/LICENSE', 'dompurify.LICENSE'],
  ['dompurify/LICENSE-MPL', 'dompurify.LICENSE-MPL'],
]) copyFileSync(new URL(`node_modules/${source}`, root), new URL(`web/vendor/${target}`, root));

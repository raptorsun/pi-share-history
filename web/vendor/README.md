# Browser libraries

These pinned, locally served assets support client-side Markdown rendering. There are no CDN requests.

- Marked **18.1.2**: `marked.umd.js`, MIT license in `marked.LICENSE`. Source: https://github.com/markedjs/marked
- DOMPurify **3.4.17**: `purify.min.js`, dual Apache-2.0/MPL-2.0 licenses in `dompurify.LICENSE` and `dompurify.LICENSE-MPL`. Source: https://github.com/cure53/DOMPurify

To update, change the exact dev dependency versions and lockfile, run `npm ci --legacy-peer-deps --ignore-scripts`, then `npm run vendor:web` and `npm test`. Commit the regenerated assets and their licenses along with the lockfile. Keep the sanitizer up to date.

Production serves the committed assets directly; it does not install or import these packages on the server.

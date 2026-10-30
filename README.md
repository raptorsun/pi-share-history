# Pi share history

A Pi extension and self-hosted service for sharing session history live and after Pi closes. Multiple publishers use the same server; teammates read and scroll independently in a browser.

**Published transcripts are public.** Anyone who reaches the website can browse the session directory and read logs. There is no viewer login. Use a VPN or authenticated reverse proxy if access should be limited to your team. Prompts, code, tool arguments, and command output may contain secrets; no automatic secret redaction is performed.

## Quickstart: publish a Pi session

You need Pi, a running sharing service, and its team upload key. To host your own service, see [Server setup](#server-setup).

All domains, server addresses, and deployment paths below are examples. Replace `logs.example.com`, `192.0.2.10`, and the `deploy` SSH user with your own values. The example IP is reserved for documentation and is not a live server.

### 1. Install the extension

```sh
pi install https://github.com/raptorsun/pi-share-history
```

If already installed as a Git package:

```sh
pi update --extensions
```

For a local checkout, run `pi install /absolute/path/to/pi-share-history` instead. Developed against Pi 1.4.0; use a version supporting the extension lifecycle APIs used here.

### 2. Set the service URL and upload key

In the shell where you will start Pi:

```sh
export PI_SHARE_URL=https://logs.example.com/pi-history
export PI_SHARE_KEY='your-team-upload-key'
pi
```

**Always set `PI_SHARE_URL` explicitly for your deployment.** It must match the server's `PUBLIC_URL`, including any path prefix. Restart Pi after changing these variables. Keep the key private and avoid committing it to Git or putting it into shared shell configuration.

### 3. Start sharing

Inside Pi:

```text
/share start
```

Confirm publication, then send teammates the returned viewer link. Existing history from the current branch is uploaded, followed by live updates. Viewers can also browse the directory at `https://logs.example.com/pi-history/`; they do not need the upload key.

After pair programming, use `/share stop` to stop live updates while keeping the saved transcript available. To publish a finished session, resume it in Pi and run `/share upload` instead.

### Commands

| Command | Action |
| --- | --- |
| `/share start` | Publish current-branch history and stream new activity |
| `/share upload` | Publish or refresh saved history without live streaming |
| `/share status` | Show the viewer link, pending updates, and sync errors |
| `/share stop` | Stop live updates; keep the saved transcript |
| `/share revoke` | Disable public access; retain stored data |
| `/share delete` | Delete the hosted copy, not local Pi history |
| `/share drafts on` | Opt in to sharing unsent editor text while live sharing |
| `/share drafts off` | Disable draft previews and clear the current preview |

Resuming Pi never automatically resumes publishing. Uploading again updates the same share when its saved owner entry is available. A revoked share cannot be restarted; delete its hosted copy before creating a new share.

### Optional: share what you are typing

In Pi's interactive terminal, enable live sharing first, then opt in separately:

```text
/share start
/share drafts on
```

After confirmation, viewers see a **Typing… — not submitted** preview below the transcript. Edits and deletions are sampled about every 400 ms, subject to network latency. A visible **DRAFTS PUBLIC** status in Pi reminds you that unsent text is being shared. Slash-command and shell-command drafts starting with `/` or `!` are excluded.

When you submit, the preview clears and the message appears once in normal history. Drafts are never stored as history entries or written to SQLite. They are held in memory, renewed while sharing, and expire after eight seconds without an update. The browser also clears previews on connection errors and expiry. Viewers can still copy or record anything they see.

Use `/share drafts off` to stop sharing editor text. Stopping live sharing, uploading without streaming, revoking, deleting, shutting down, or replacing the session also disables draft sharing. It is **off by default**, is never automatically re-enabled after resuming a session, and is unavailable in RPC/print modes. Update both the extension and server before using this feature.

### Finding the upload key

The administrator sets `UPLOAD_KEY` in the server's private `.env` file. Publishers use that same value as `PI_SHARE_KEY`. Ask the administrator to provide it securely.

If you administer the server over SSH and keep the checkout at `~/pi-share-history`, load the key without displaying it:

```sh
export PI_SHARE_KEY="$(ssh deploy@192.0.2.10 \
  'cd ~/pi-share-history && . ./.env && printf %s "$UPLOAD_KEY"')"
```

To display it in your terminal instead:

```sh
ssh deploy@192.0.2.10 \
  'cd ~/pi-share-history && . ./.env && printf "%s\n" "$UPLOAD_KEY"'
```

Only source a `.env` file you trust. Anyone with the team key can create new shares. Each publisher receives a separate owner key for modifying or deleting their own share; the team key cannot modify someone else's existing share.

## Server setup

The example deployment uses Docker Compose for the application and Caddy on the host for HTTPS. No npm install or browser build is needed for the service.

### 1. Clone and configure

On your server:

```sh
git clone https://github.com/raptorsun/pi-share-history.git
cd pi-share-history
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

Edit `.env`, replacing `UPLOAD_KEY` with the generated random value and **setting `PUBLIC_URL` to your own domain**:

```dotenv
UPLOAD_KEY=replace-with-your-generated-random-key
PUBLIC_URL=https://logs.example.com/pi-history
```

The upload key must contain at least 24 characters. Do not publish or commit `.env`.

### 2. Start the application

```sh
docker compose up -d --build
curl --fail http://127.0.0.1:9080/pi-history/health
```

The health endpoint should return `{"ok":true}`. Compose binds **127.0.0.1:9080**, intended for a reverse proxy on the same host. SQLite lives in the persistent `history-data` Docker volume. `docker compose down` keeps it; **`docker compose down -v` destroys it**.

### 3. Configure DNS and HTTPS

- Point your domain's DNS records at the server's public IP. Dynamic DNS also works; a hostname is not access control.
- If the server is behind a router, forward public TCP **80 and 443** to the reverse proxy. Allow those ports through the server firewall.
- Do **not** expose the plain HTTP application port `9080` directly to the internet.
- If your ISP uses CGNAT, use a tunnel or another reachable ingress.
- Avoid stale AAAA records unless IPv6 also reaches the proxy.

Install Caddy using your operating system's instructions. Add this site block to its configuration, replacing the example domain:

```caddyfile
logs.example.com {
    redir /pi-history /pi-history/ 308

    handle /pi-history/* {
        reverse_proxy 127.0.0.1:9080 {
            flush_interval -1
        }
    }

    handle {
        respond "Not found" 404
    }
}
```

Validate the configuration and start or reload Caddy as appropriate for your installation. Caddy obtains and renews the TLS certificate and redirects HTTP to HTTPS. Keep its validation ports reachable for renewal.

Open `https://logs.example.com/pi-history/`. Check the public health endpoint:

```sh
curl --fail https://logs.example.com/pi-history/health
```

`deploy/Caddyfile` is another template, including redirects for legacy `/s/<id>` viewer links. **Replace its site hostname before using it.** Merge the relevant handlers into an existing proxy configuration rather than overwriting unrelated sites.

### Path prefixes and proxy networking

`PUBLIC_URL` controls generated viewer links and the application's route prefix. Set publishers' `PI_SHARE_URL` to the same URL. Other simple path prefixes and root deployments are supported.

The proxy must **preserve** `/pi-history` when forwarding requests: use Caddy `handle`, not `handle_path`. Disable proxy buffering for `/pi-history/api/shares/*/events` so live updates arrive promptly. The domain root is available for other applications.

If the proxy runs in Docker, `127.0.0.1` inside that container is not the host. Attach both containers to the same Docker network and proxy to `history:9080`, or configure the host gateway explicitly. Remove the host port mapping if it is unnecessary.

If `9080` must be the externally visible **HTTPS** port, terminate TLS on that port at your proxy and move the private application binding to a different port. Set `PUBLIC_URL` and `PI_SHARE_URL` to `https://logs.example.com:9080/pi-history`. Certificate issuance still needs a supported validation route, such as public port 80 or DNS validation; forwarding port 9080 alone is insufficient.

## Features and limitations

- Browser viewer with search, expandable tool output, independent scrolling, follow-live mode, and automatic reconnection.
- Light and dark themes follow the system preference by default. The **Theme** button in the header cycles through both explicit themes and back to **System**. Your selection is remembered in the browser; System mode follows OS theme changes automatically.
- Persistent SQLite storage, separate per-share owner keys, idempotent record upserts, and batched uploads with live retries.
- User prompts, assistant text, tool calls, output, and errors are shared. System prompts, model thinking, image data, provider signatures, raw provider events, and arbitrary tool-result metadata are omitted.
- User and assistant messages render Markdown **in the browser only**, enabled by default. The header's **Markdown: On/Off** button switches between formatting and the original text, remembers your choice in that browser, and applies to streaming updates. Headings, lists, tables, links, and fenced code blocks are supported. Tool output and unsent draft previews always remain plain text.
- Markdown uses locally served Marked and DOMPurify libraries, with raw HTML disabled, sanitized output, and images replaced by text to avoid tracking requests. No CDN is used. Stored messages and API responses remain unchanged; rendering never runs on the server. If rendering is unavailable, the viewer falls back to plain text.
- Text and tool records are capped at 24,000 characters. This is a readable log, not an exact terminal mirror or restorable Pi session export.
- Navigating branches adds selected history to the share; it does not unpublish previously shared records. Compaction does not remove already shared history.

## Reliability and privacy

- Live updates are coalesced and uploaded roughly every 1.5 seconds. Live status expires after 20 seconds without a publisher heartbeat.
- Failed uploads remain **in process memory** for retry. `/share status` shows failures. Graceful shutdown attempts a final flush; an abrupt kill, power loss, or network outage can lose unacknowledged updates. Resume the session and run `/share upload` to backfill persisted conversation history. Ephemeral tool progress cannot be recovered this way.
- Requests have 5-second timeouts. Large backfills may require several batches and delay shutdown. There is no durable offline upload queue.
- Owner credentials are saved in a custom entry in the local Pi session and excluded by the upload allowlist. Treat raw local session exports as sensitive. Branching to before that entry may create a new share rather than finding the old one.
- Saved owner entries remember their server URL. Setting `PI_SHARE_URL` to a new path on the same origin migrates that session's saved endpoint without enabling publishing. A different origin never receives the saved owner credentials automatically. Legacy viewer redirects do not migrate old API clients.
- The server administrator can read all logs. TLS provides transport encryption, not end-to-end encryption. Revocation and deletion cannot erase copies viewers already downloaded; backups may also retain deleted data.
- There is no automatic expiry. Delete unwanted shares and monitor disk space. Defaults: 1 MiB/request, 128 KiB/record, 10,000 records and 20 MiB/share, 1,000 shares, and 200 concurrent SSE viewers. These limits do not prevent all denial-of-service attacks.
- Rotating `UPLOAD_KEY` and restarting the service prevents new shares with the old team key; existing per-share owner keys remain valid. There is no publisher account system or admin dashboard.
- The viewer fetches the saved transcript on live invalidations. This MVP is intended for a small team and has not been load-tested. Add proxy request/connection limits and consider team access control for internet deployments.

### Backups

Stop the service briefly and copy its volume, or use a SQLite-aware backup tool. Do not copy only the `.sqlite` file from a running WAL database: acknowledged writes may remain in the `-wal` file. Keep backups off the server and test restores.

## Local development

Node **22.18+** is required for the development/test workflow. The server uses built-in `node:sqlite`, which may print an experimental warning.

```sh
UPLOAD_KEY=local-development-key-at-least-24-characters \
PUBLIC_URL=http://localhost:9080 npm start
```

In another shell:

```sh
export PI_SHARE_URL=http://localhost:9080
export PI_SHARE_KEY=local-development-key-at-least-24-characters
pi --extension ./extension/index.ts
```

HTTP is accepted by the extension only for localhost; use HTTPS for remote services.

Install development/test dependencies, then run the tests:

```sh
npm ci --legacy-peer-deps --ignore-scripts
npm test
```

Production needs no npm install or asset build: browser libraries are pinned and committed under `web/vendor/` with their licenses. After updating Marked or DOMPurify, run `npm run vendor:web` and commit the regenerated assets. See `web/vendor/README.md`.

Tests cover server authentication, publisher isolation, persistence across restart, SSE, deduplication, revocation/deletion, quota rollback, upload allowlisting, the extension lifecycle with a simulated Pi context, prefixed routing, browser URL construction, legacy owner-state migration, theme switching, client-side Markdown formatting/toggling and sanitization, and opt-in ephemeral drafts (edits, deletion, expiry, submission without duplicates, and disconnect cleanup). Browser interaction and real network deployments also require manual verification.

## Layout

- `extension/index.ts` — Pi commands and live synchronization.
- `extension/records.mjs` — upload allowlist and truncation.
- `server/index.mjs` — HTTP API, SQLite persistence, and SSE.
- `web/` — read-only browser viewer, with locally bundled Markdown parser and sanitizer.
- `scripts/vendor-web.mjs` — reproduce the bundled browser libraries from pinned dev dependencies.
- `compose.yaml`, `Dockerfile`, `deploy/Caddyfile` — deployment templates; configure your own domain before use.

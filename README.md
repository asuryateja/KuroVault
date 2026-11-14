<p align="center"><img src="client/public/logo.svg" width="96" alt="Kurovault logo"></p>

# Kurovault

**A watchful, self-hosted vault for your Telegram files.** Drawn like a manga page in soft ink on charcoal: rounded ink panels, slanted labels and speed lines. The logo is a rounded ink panel with a K. Kurovault puts your Telegram library (Saved Messages, your channels, or the Telegram Drive desktop app's folders) in any browser — phone, tablet, laptop or a large desktop screen — behind hardened, monitored access.

- **Straight from Telegram, from anywhere.** Sign Kurovault into your own Telegram account (API ID + hash, then a login code or QR scan), host it on Railway, Render or Fly.io, and stream whatever is in your Saved Messages, channels, groups and private chats (bots included); the Vault is organised the way Telegram is, with a searchable home screen. Forwarded videos get readable names from their captions. Protected channels can be watched but never downloaded. A Telegram sessions panel shows every device on your account and can sign them out.
- **Your files, playable in the browser.** Stream videos with a custom player (seek, speed, picture-in-picture, fullscreen, keyboard shortcuts), play audio with a live visualizer, read PDFs page by page with zoom, and view images full size. Move between files with arrow keys or swipes, and the viewer animates open and closed. Grid view shows thumbnails, and filters split the library into videos, audio, images and PDFs. 
- **Watch without buffering.** For long Telegram videos, *Prepare for smooth playback* has the server fetch the file from Telegram first. The player shows the progress, download speed and the exact point when playback can start without stopping (calculated from the video's bitrate, its length and the download speed), then plays from the server's copy while the rest keeps arriving. Space is capped by `TDC_VIDEO_CACHE_MB` (oldest copies are removed first).
- **Open ZIP and RAR archives in place.** Browse folders inside an archive, search it, and play videos, music, PDFs and images straight out of it, with seeking, without downloading or unpacking anything yourself. ZIPs are read directly with byte ranges, so even a multi-gigabyte ZIP opens instantly. RARs are fetched once into a size-limited server cache, then single files are extracted with the official unrar engine. Download any single file from inside an archive (except in protected chats).
- **Folder and file management like the desktop app.** A nested folder tree; create, rename and delete folders; rename, move and copy files through a folder picker or by drag-and-drop; multi-select with bulk move, delete and zip download; sorting by name, date or size. Recents, Favorites and Pinned lists live on the Kurovault server. Storage insights cover Large files, Old files, Duplicates (with reclaimable space) and Empty folders. Uploads are resumable and chunked, up to Telegram's 2 GB limit, with progress, cancel, and drag-and-drop from your desktop.
- **Simple accounts.** Sign in with a username and password, or create an account (name, username, password). No setup token, no authenticator app. A browser stays signed in until you press **Sign out**, which ends only that browser. Each member connects their own Telegram once and it is remembered.
- **One administrator.** The account named `admin` (password set on the server with `TDC_ADMIN_PASSWORD`) is the only one that sees sign-in attempts, visitors and their IP locations, sessions, accounts and the audit trail. Everyone else sees just their Vault and account.
- **Monitored access.** Every visitor IP (with city, state and country from an offline database), every request and every sign-in attempt (successful or not, with the username tried) is recorded for the administrator.
- **Live system checks before sign-in.** The login screen runs real server-side checks one by one: database integrity, audit-chain integrity, transport security, security headers, key-file permissions, authentication policy, intrusion defenses, the Drive link and host resources. It also shows the visitor their own connection. Other people's IPs are never shown before sign-in.
- **An intelligence dashboard** after sign-in: sign-in attempts, visitors by IP with risk and the usernames they tried, per-IP request trails, active sessions with remote revocation, a tamper-evident audit trail, threat sources and 24-hour traffic.
- **Fully responsive.** A sidebar on desktops; a slide-in drawer, card-style tables, a two-column file grid and a full-screen viewer on phones.

Kurovault either talks to Telegram directly (cloud hosting, no PC needed) or to the Telegram Drive desktop app's local REST API. Either way the credentials (Telegram session, API hash, desktop API key) are sealed on the server and never reach a browser. It cannot run on Vercel. **[DEPLOYMENT.md](DEPLOYMENT.md)** walks through Railway, Render, Fly.io and the PC + tunnel setup.

## Quick start

Requirements: Node.js **22.13 or later**. Then either a Telegram API ID and hash from [my.telegram.org](https://my.telegram.org) (direct mode), or the Telegram Drive desktop app with **Settings → Advanced → REST API** enabled.

```bash
cd kurovault
cp .env.example .env   # optional: adjust settings
npm ci
npm run build          # builds the browser UI into client/dist
npm start              # http://127.0.0.1:8640 (reads .env if present)
```

Set `TDC_ADMIN_PASSWORD` (12+ characters) before the first start: that creates the `admin` account. Anyone else can use **Create account** on the sign-in page (turn that off with `TDC_ALLOW_REGISTRATION=0`). After signing in, open **Vault** and connect your Telegram account. The admin can instead choose *Use the Telegram Drive desktop app instead* and paste the desktop app's API key.

## Configuration

All settings are environment variables, which you can also put in a `.env` file. The defaults are the safe choice.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TDC_HOST` | `127.0.0.1` | Bind address. Keep loopback unless TLS is in front. |
| `TDC_PORT` | `8640` | Port. Falls back to the platform's `PORT`. |
| `TDC_DATA_DIR` | `./data` | Database and keys (created with mode 0700). |
| `TDC_MASTER_KEY` | – | Recommended on cloud hosts. Seals the key file at rest; secrets cannot be opened without it. 24+ characters. |
| `TDC_UPLOAD_DIR` | `<data>/uploads` | Where upload chunks are staged before going to Telegram. |
| `TDC_TLS_CERT` / `TDC_TLS_KEY` | – | PEM files. Enables HTTPS, HSTS and `__Host-` secure cookies. |
| `TDC_TRUST_PROXY` | off | Number of proxy hops to trust in `X-Forwarded-For` (`1` on Railway, Render, Fly, Tailscale or a tunnel), or a list of proxy addresses. Extra entries a visitor adds are ignored. |
| `TDC_VIDEO_CACHE_MB` | `4096` | Space for videos prepared for smooth playback (one per person at a time). |
| `TDC_VIDEO_CACHE_DIR` | system temp folder | Where prepared videos are kept. Cleared on every start. |
| `TDC_ARCHIVE_CACHE_DIR` | system temp folder | Where RAR archives are cached while you browse them. Cleared on every start. |
| `TDC_ARCHIVE_CACHE_MB` | `6144` | Cache size limit. Least recently used archives are evicted first. |
| `TDC_ARCHIVE_MAX_MB` | `4096` | Largest RAR that can be opened. ZIPs have no limit because they are never cached. |
| `TDC_CLIENT_IP_HEADER` | – | Header your edge proxy fills with the visitor IP (`true-client-ip` on Render, `fly-client-ip` on Fly.io, `cf-connecting-ip` behind Cloudflare). Takes priority over `X-Forwarded-For`. Only set it when every request passes through that proxy. |
| `TDC_COOKIE_SECURE` | off (on with TLS) | Force `Secure` cookies when TLS terminates at a proxy. |
| `TDC_DRIVE_API_URL` | `http://127.0.0.1:8550/api/v1` | Desktop app REST API (can also be changed in the UI). |
| `TDC_DRIVE_API_KEY` | – | Optional. Prefer setting it in the UI, where it is sealed at rest. |
| `TDC_ADMIN_PASSWORD` | – | Creates the `admin` account on first start (12+ characters). |
| `TDC_ALLOW_REGISTRATION` | `1` | Show **Create account** on the sign-in page. |
| `TDC_INVITE_CODE` | – | When set, new accounts must enter this invitation code. |
| `TDC_SIGNUPS_PER_IP_PER_DAY` | `3` | New accounts allowed from one address per day. |
| `TDC_MAX_USERS` | `200` | Total accounts the server will accept. |
| `TDC_SESSION_DAYS` | `30` | A browser stays signed in until sign-out, or after this many days unused. |
| `TDC_TELEGRAM_API_ID` / `TDC_TELEGRAM_API_HASH` | – | One Telegram app for everyone, so people sign in with just their phone number. |
| `TDC_RATE_GLOBAL_PER_MINUTE` | `3000` | Requests per IP per minute. |
| `TDC_RATE_AUTH_PER_MINUTE` | `10` | Sign-in requests per IP per minute. |
| `TDC_LOCK_AFTER_FAILURES` | `5` | Account lock threshold (15 min, doubling to 24 h). |
| `TDC_BLOCK_AFTER_FAILURES` | `20` | Failed sign-ins per IP per hour before an automatic 1-hour block. |
| `TDC_RETENTION_DAYS` | `30` | Visit and sign-in log retention. The audit trail is never pruned. |
| `TDC_MAX_UPLOAD_MB` | `1907` | Upload size limit (≈ 2 GB, Telegram's maximum). |
| `TDC_UPLOAD_CHUNK_MB` | `16` | Upload chunk size. Keep it below any proxy or tunnel request cap. |

### Reaching it from your phone and other devices

Never serve it over plain HTTP on a network. Use Tailscale Serve (private to your devices) or Cloudflare Tunnel (public with your own domain). Step-by-step instructions, and why Vercel can't host it, are in **[DEPLOYMENT.md](DEPLOYMENT.md)**.

## Security model

| Layer | Implementation |
| --- | --- |
| Passwords | scrypt (N=32768, r=8, p=1), 16-byte salt, constant-time compare. Unknown usernames take the same time as known ones. Strength policy blocks short, common and username-based passwords. |
| Accounts | One administrator (`admin`, password from `TDC_ADMIN_PASSWORD`, reserved so nobody else can register it). Members can only reach their own Vault and Telegram; every intelligence endpoint answers 403 to them. |
| Brute force | Per-IP sliding-window limits (global and sign-in), progressive account lockout, automatic IP blocking, manual blocklist. |
| Sessions | 256-bit opaque tokens stored only as SHA-256. Cookies are HttpOnly and SameSite=Strict (plus Secure/`__Host-` with TLS). Sliding expiry: a browser stays signed in while used (`TDC_SESSION_DAYS` unused ends it). Sign out ends only that browser. IP moves are audited. The admin can revoke any session remotely. |
| Request forgery | Per-session CSRF token, plus Origin and `Sec-Fetch-Site` checks on every state-changing request. |
| Telegram | Each member's Telegram session and API hash are sealed separately with AES-256-GCM and never sent to a browser. |
| Browser hardening | Strict CSP (`script-src 'self'`, no inline code), `frame-ancestors 'none'`, nosniff, no referrer, COOP/COEP/CORP isolation, HSTS with TLS, `no-store` on API responses. |
| Audit | Append-only log; each entry is HMAC-SHA256 sealed and chained to the previous one. Any edit or deletion is detected and reported (UI, system check, `npm run admin -- verify-audit`). |
| Static files | Served only from a fixed list built at startup, so path traversal is impossible by design. |
| Media streaming | Range-aware pass-through with no length limit (only the wait for the first response is time-limited; the transfer stops the moment the viewer closes). Only passive media types (video, audio, raster images, PDF) are ever served inline; HTML, SVG and everything else is forced to download, and every streamed response also carries a `sandbox` CSP. Encrypted vault files are refused, since their key stays in the desktop app. |
| Privacy | No third-party scripts, fonts or analytics. IP locations come from an offline database on the server, so visitor data never leaves it. |
| Dependencies | Runtime: `fastify`, `qrcode`, `telegram` (GramJS), `node-unrar-js`, `maxmind` and the DB-IP database. `npm audit` reports 0 known vulnerabilities. |

## Break-glass administration (server shell)

```bash
npm run admin -- blocks                 # list blocked IPs
npm run admin -- unblock 203.0.113.9    # if you blocked yourself
npm run admin -- unlock admin           # clear an account lock
TDC_NEW_PASSWORD='…' npm run admin -- set-password admin   # forgot the admin password
npm run admin -- verify-audit           # exit code 2 if the chain is broken
```

## Tests

```bash
npm test     # archive unit checks, then builds the UI, starts two real servers plus simulated Telegram backends and runs 49 browser journeys
```

The suite covers folder create/rename/delete and the nested tree; file rename, move, copy and drag-and-drop; favorites, pins and recents; bulk move, zip and delete; storage insights; a 40 MB chunked upload verified by checksum; video playback with byte-range seeking (WebM and H.264 MP4), audio with visualizer, PDF rendering, paging and zoom, images, file-to-file navigation, thumbnails, encrypted-file handling, safe inline serving, layouts on phone, tablet, laptop and 2560-px screens with no sideways scrolling, headers, the pre-login sweep, offline IP locations, registration rules and password policy, admin-only intelligence (members get 403), sign-out ending only one browser, cookie flags, sign-in logging with IPs, automatic IP blocking, rate limiting, CSRF/Origin/Fetch-Metadata refusal, remote session revocation, the Drive flow (admin link setup, browse, download, upload, delete, key never exposed or stored in plaintext), the blocklist, overview metrics, audit tamper detection and account lockout. Only the Telegram Drive desktop API is simulated (`tests/fake-drive.js`, with real media fixtures in `tests/fixtures/`).

`tests/telegram.spec.ts` covers direct mode: phone-code, two-step and QR sign-in, secrets never stored in plaintext or returned to the browser, clean names for forwarded media, video playback and seeking, byte-exact range requests across Telegram's 1 MiB block boundaries, uploads, rename/move/copy/delete, valid zip archives, channel create/rename/delete, protected-chat refusals, permission errors and terminating Telegram sessions. Telegram is simulated by `server/telegram/adapter-fake.js`, which only loads when both `TDC_TELEGRAM_ADAPTER=fake` and `TDC_ALLOW_FAKE_TELEGRAM=1` are set. The real connection (GramJS) could not be reached from the development sandbox, so the first live sign-in is its first real test.

## Known limits

- Archives: password-protected and multi-part (`.part1.rar`, `.z01`) archives are not supported yet, and nor are ZIPs using rare compression methods (bzip2, LZMA, Deflate64); those files are listed but marked *unsupported*. Archives inside archives can be downloaded, not opened. Seeking in a *compressed* (deflated) ZIP entry re-reads it from its start, which is fine for music and documents. Video in ZIPs is almost always stored uncompressed, which seeks instantly.
- Videos play if the browser supports their codec (MP4/H.264, WebM/VP9, and so on). Anything else shows a clear message with a download button.
- Recents, Favorites and Pinned are Kurovault's own lists. The desktop app doesn't share its lists through its API, so the two don't sync.
- New folders are created at the top level, because the desktop API has no "parent folder" option. Existing nested folders show as a tree.
- Group names aren't available through the API, so the desktop app's Groups section isn't shown. Offline files are a desktop-only feature.
- In desktop-app mode, the REST API does not expose your Telegram account's device sessions, so only the console's own sessions are shown. Direct mode shows the Telegram sessions too.
- Direct mode reads up to the 20,000 most recent media messages per chat. Rename in direct mode is a Kurovault label; the message in Telegram keeps its original name.
- IP locations come from the free DB-IP *IP to City Lite* database (CC BY 4.0, "IP Geolocation by DB-IP", https://db-ip.com), bundled with the server and looked up locally, so no visitor address is sent to a third party. City-level accuracy is approximate (often the internet provider's location), and the database is as current as the installed package; `npm update @ip-location-db/dbip-city-mmdb` refreshes it. It needs about 135 MB of memory once loaded.

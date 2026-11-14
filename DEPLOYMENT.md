# Deploying Kurovault

Kurovault can get your files two ways. Pick one:

| | **A. Direct to Telegram** (cloud) | **B. Through the desktop app** (your PC) |
|---|---|---|
| Where it runs | Railway, Render or Fly.io | The PC running Telegram Drive |
| What it shows | Saved Messages + channels/groups you add | Telegram Drive's folders |
| PC must stay on | No | Yes |
| Speed limit | The host's bandwidth (and Telegram's download speed) | Your home upload speed |
| Cost | A few dollars a month plus bandwidth | Free |

Forward a video from any channel to **Saved Messages** and, with option A, it is ready to stream in the browser a few seconds later, from anywhere.

## Can it go on Vercel?

**No, for either option.** Kurovault needs three things Vercel functions don't offer:

1. **A process that stays running.** Option A keeps one live connection to Telegram open; option B needs to reach `127.0.0.1` on your PC, which a cloud server cannot.
2. **A permanent disk.** The security database (sign-in attempts, visitor IPs, sessions, the sealed audit chain, the sealed Telegram session) is SQLite on disk. Vercel's filesystem is read-only apart from a temporary `/tmp`, so every cold start would wipe it.
3. **Long streaming responses.** Vercel caps function request and response bodies at 4.5 MB, and a film is gigabytes.

Use Railway, Render or Fly.io (option A below) or your own PC (option B).

---

# Option A — Direct to Telegram, hosted in the cloud

## 1. Get your Telegram API ID and hash (2 minutes)

1. Open **https://my.telegram.org** and sign in with your phone number. The code arrives in your Telegram app.
2. Choose **API development tools** and fill in the form (App title `Kurovault`, short name `kurovault`, platform `Web`; the URL can stay empty).
3. Copy the **App api_id** (a number) and **App api_hash** (32 characters).

**Who needs one?** Every Telegram client app (Telegram Desktop included) identifies itself with an api_id/api_hash. It belongs to the *app*, not to each person. So you can create it once and put it on the server as `TDC_TELEGRAM_API_ID` / `TDC_TELEGRAM_API_HASH`: then everyone who uses your Kurovault signs in to Telegram with **only their phone number and the code** (or a QR scan). Without those variables, each person types their own api_id/hash into the Vault once. Telegram allows one api_id per phone number and monitors API apps for abuse, so use it for your own and your friends' accounts, not as a public service.

> ⚠️ **What you are handing over.** Once signed in, Kurovault's server holds a Telegram session: full access to your account, like any logged-in device. That is why it is sealed with AES-256-GCM under `TDC_MASTER_KEY`, never sent to a browser, and kept separately for each Kurovault account. Use a strong Kurovault password. Turn on Telegram's own **two-step verification** (Settings → Privacy and Security) as well. You can end Kurovault's access at any time: **Disconnect Telegram** in the Vault, or Telegram → Settings → Devices → terminate "Kurovault".

## 2. Generate a master key

The master key encrypts everything secret on the disk. Keep a copy in your password manager: without it the sealed data cannot be opened. Generate one on any computer:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 3. Deploy

All three hosts build the included `Dockerfile`. All state lives in `/data`, which **must be a persistent volume**; without one you would have to sign in again after every deploy. The container fixes the volume's ownership itself and then runs as an unprivileged user.

Environment variables (same on every host):

| Variable | Value |
|---|---|
| `TDC_ADMIN_PASSWORD` | password for the `admin` sign-in, 12+ characters (**secret**) |
| `TDC_MASTER_KEY` | the key from step 2 (**secret**) |
| `TDC_TELEGRAM_API_ID` / `TDC_TELEGRAM_API_HASH` | optional, from step 1: phone-number-only Telegram sign-in for everyone |
| `TDC_TRUST_PROXY` | `1` |
| `TDC_COOKIE_SECURE` | `1` |
| `TDC_DATA_DIR` | `/data` |

### Railway

1. Push the repository to GitHub (see the end of this file). In Railway: **New Project → Deploy from GitHub repo**.
2. Service **Settings**:
   - **Root Directory:** `kurovault`
   - **Config-as-code path:** `/kurovault/railway.json` (Railway does not look inside the root directory for it on its own)
3. **Variables:** add the four variables above.
4. Right-click the service → **Attach volume**, mount path `/data`.
5. **Settings → Networking → Generate Domain.** Railway gives you `https://<name>.up.railway.app`.

### Render

1. In Render: **New → Blueprint**, pick the repository. It reads `render.yaml` at the repository root.
2. That file asks for the **Starter** plan with a 1 GB disk at `/data`. Free instances can't keep a disk. It also generates `TDC_MASTER_KEY` for you; copy the generated value from the dashboard into your password manager.
3. Deploy. The site is at `https://kurovault-xxxx.onrender.com`.

### Fly.io

```bash
cd kurovault
fly launch --copy-config --no-deploy      # pick a unique app name; it is written into fly.toml
fly volumes create kurovault_data --size 1 --region fra
fly secrets set TDC_MASTER_KEY="<the key from step 2>"
fly deploy
```

`fly.toml` keeps one machine always running, because sessions and the Telegram connection live in memory. Pick the region closest to you; it affects how fast videos start.

## 4. First sign-in

1. Open your site and sign in as **admin** with the `TDC_ADMIN_PASSWORD` you set. (Changed your mind about the password? Change it under **Account & security**. Forgot it? See *Break-glass administration* in the README.)
2. Friends and family use **Create account** (name, username, password). They only ever see their own Vault. To make sign-up invitation-only, set `TDC_INVITE_CODE` and share the code privately; to stop new sign-ups entirely, set `TDC_ALLOW_REGISTRATION=0`. As admin you can switch off or remove any account under **Sessions & users**.
3. Go to **Vault**. Enter your API ID and hash (skipped if the server has its own), then either:
   - **Phone number** → enter the code Telegram sends to your app → your two-step password if you have one, or
   - **QR code** → on your phone: Telegram → Settings → Devices → **Link Desktop Device**, then scan the code.
4. Kurovault remembers your API ID and hash (encrypted). If Telegram ever disconnects (you pressed **Disconnect Telegram**, or ended the session from your phone), reconnecting asks only for your phone number. **Use a different API ID** lets you change it.
5. The Vault opens on **Home**: Saved Messages, then every channel, group and private chat (including bots) you're in, most recent first, with a search box. Open any of them to browse and play its videos, music, photos and documents. Next time you sign in, it is all there straight away; signing out of Kurovault doesn't disconnect Telegram.

**Visitor IPs.** Kurovault recognises Render, Fly.io and Railway by itself and reads the real visitor address from their edge proxy (`True-Client-IP` on Render, `Fly-Client-IP` on Fly.io, one proxy hop on Railway), and turns on secure cookies. You don't need to set `TDC_TRUST_PROXY`, `TDC_COOKIE_SECURE` or `TDC_CLIENT_IP_HEADER` there; the server log says `Host: render — visitor IPs from true-client-ip` at start-up.

Check **Overview → Your connection** (or the sign-in page) shows *your* public IP. If it shows a private 10.x / 172.x / 100.x address, the host adds an extra proxy hop: set `TDC_TRUST_PROXY=2` and redeploy.

## What works in the cloud

- **Stream** videos, audio, PDFs and images from Saved Messages and any added channel/group, with seeking. Kurovault asks Telegram for 1 MiB-aligned blocks and trims them to exactly the bytes the player asked for, so seeking anywhere in a long film starts quickly.
- **Clean names:** forwarded videos often have no file name. Kurovault uses the first line of the caption (without links, hashtags and emoji), and otherwise `Video 2026-10-31 #1234.mp4`. **Rename** stores your own name in Kurovault; Telegram is unchanged.
- **Upload** files up to 2 GB. They go to Saved Messages or a channel where you can post.
- **Move / copy** = forward without the "Forwarded from" header (and delete the original, for move). **Delete** removes the message for everyone where you have permission.
- **New folder** creates a private channel that only you can see. **Delete channel** only works on channels you created; **Remove from Kurovault** just hides a chat.
- **Archives:** open a `.zip` or `.rar` to browse it and play what is inside. ZIPs stream straight from Telegram. A RAR is first fetched to the server (you see a progress bar), which counts against your host's disk: the cache lives in the container's temp folder and is limited by `TDC_ARCHIVE_CACHE_MB` (default 6 GB). On a small Render or Fly instance with little temp space, lower it, e.g. `TDC_ARCHIVE_CACHE_MB=2048`.
- **Protected chats** (channels with "restrict saving content"): you can watch in Kurovault, but download, zip, copy and move are refused, just as in Telegram.
- **Security → Telegram sessions** lists every device signed into your account (device, app, IP, location, last active) and can terminate any of them.

## Costs and speed

Every minute of video you watch is downloaded from Telegram by the server (normally free inbound traffic), then sent to you (**outbound traffic, billed**). Rough guide: one hour of 1080p is about 2–4 GB.

| Host | Outbound traffic | Volume | Notes |
|---|---|---|---|
| Railway | ~$0.05 / GB | ~$0.15 / GB-month | usage-based plans |
| Render | included allowance, then billed | ~$0.25 / GB-month | disk needs a paid instance |
| Fly.io | ~$0.02 / GB (North America & Europe) | ~$0.15 / GB-month | no free tier |

Prices change; check each host's pricing page before you commit.

**Speed.** Playback is limited by the slower of (a) Telegram → server and (b) server → you. Telegram gives Premium accounts faster downloads, so on a free account high-bitrate 4K files can buffer; 1080p usually plays fine. Pick a server region close to you.

**Smooth playback.** Long videos from Telegram can buffer while they start, because the server is fetching them from Telegram at the same time. Open the video and press **Prepare for smooth playback**: the server downloads it first, shows the percentage and speed, and tells you when it is safe to press Play (often well before 100%). Prepared videos live in the server's temporary space, limited by `TDC_VIDEO_CACHE_MB` (default 4096 MB). On a small instance set it lower, or point `TDC_VIDEO_CACHE_DIR` at your Render disk (for example `/data/prepared`) and give the disk room for a few films.

**Videos that won't play.** Newer Telegram videos are often HEVC (H.265), which Firefox and Chrome on many PCs can't decode. Telegram often keeps an extra H.264 copy, and Kurovault plays that copy automatically when your browser can't handle the original. If a video still fails, the player now shows the real reason (for example a Telegram error), and Render's **Logs** tab shows a `stream interrupted` or `request failed` line with the cause.

**Formats** are the same as option B. MKV files play in Chrome and Edge when they contain H.264/VP9 video. See [Streaming full-length videos](#streaming-full-length-videos) below.

## What was and wasn't tested

The whole cloud mode (Telegram sign-in by code, Telegram two-step password and QR, per-member separation, listing, clean names, byte-exact range streaming, video playback and seeking, uploads, rename/move/copy/delete, zip, channels, protected chats, Telegram sessions) is covered by `tests/telegram.spec.ts` against a **Telegram simulator**. The development sandbox could not open a real connection to Telegram's servers, so **your first real sign-in is the first live test**. If anything fails, the error is shown in the Vault and recorded in the audit trail.

---

# Option B — Through the Telegram Drive desktop app on your PC

## Run it on the PC and reach it from your devices

Run Kurovault **on the same computer as the Telegram Drive desktop app**. Then reach it from your phone, tablet or laptop over HTTPS with one of these tunnels. Neither needs router port forwarding.

### Tailscale Serve — private to your own devices (most secure)

Only devices signed in to your Tailscale account can even see the site. Strangers on the internet cannot reach the login page at all.

1. Install Tailscale on the PC and on your phone, tablet and laptop. Sign in with the same account.
2. On the PC: `cd kurovault && npm ci && npm run build && npm start`
3. On the PC: `tailscale serve 8640`. It prints a stable `https://<pc-name>.<tailnet>.ts.net` address.
4. In `.env`, set `TDC_COOKIE_SECURE=1` and `TDC_TRUST_PROXY=1`, then restart `npm start`.
5. Open that address on any of your devices and sign in with your username and password.

### Cloudflare Tunnel — reachable from anywhere (not recommended for video)

Use this if you need to sign in from devices that can't run Tailscale. You need a free Cloudflare account and a domain whose DNS is on Cloudflare.

**Two caveats for media:**
- Cloudflare's terms restrict serving video and other large files through its CDN unless they are hosted on a Cloudflare service (Stream, Images, R2). Whether that covers streaming through a tunnel is disputed, so heavy video use through Cloudflare carries a risk of being throttled. For watching videos, prefer Tailscale.
- Cloudflare caps each upload *request* at 100 MB on the Free and Pro plans. Kurovault already sends uploads in 16 MB chunks, so files up to Telegram's 2 GB limit still work.

1. Install `cloudflared` on the PC, then run `cloudflared tunnel login`.
2. Create a named tunnel that routes `vault.yourdomain.com` to `http://localhost:8640`. Follow Cloudflare's Tunnel guide, and install it as a service so it starts with the PC.
3. In `.env`, set `TDC_COOKIE_SECURE=1` and `TDC_TRUST_PROXY=1`, then restart Kurovault.
4. Strongly recommended: add a **Cloudflare Access** policy (for example "only my email") in front of the hostname. Strangers then hit Cloudflare's gate before they ever reach Kurovault's login.

The quick `cloudflared tunnel --url http://localhost:8640` command gives a random public URL. It is fine for a one-off test, but don't leave it running as your real setup.

## Streaming full-length videos

Kurovault puts **no limit on video length or file size** for playback.
- **Streaming:** the server passes the video through as it arrives, never buffering the whole file, and the browser seeks with byte-range requests. Only the first response from the desktop app has a time limit (30 s). After that a stream can run as long as you keep watching, and if you close the player or skip ahead, Kurovault stops the unused transfer immediately.
- **Uploads:** files up to Telegram's 2 GB limit go up in resumable 16 MB chunks, written to disk, never held in memory. A dropped connection retries the chunk and resumes where it stopped.

What actually limits playback, and what to set up:

1. **Your home upload speed.** When you watch away from home, the video travels from your PC over your internet *upload* bandwidth. For smooth 1080p (H.264) you typically want roughly 8–10 Mbps of spare upload. Lower-bitrate files play more smoothly on slow links.
2. **The file format.** Browsers play **MP4 with H.264 video + AAC audio** almost everywhere, and **WebM (VP9/AV1 + Opus)** in Chrome, Edge, Firefox and newer Safari. MKV, AVI, WMV and most HEVC files will not play in a browser; Kurovault shows a message and a download button instead. To convert:
   ```bash
   # Already H.264/AAC inside MKV? Just rewrap it (fast, no quality loss):
   ffmpeg -i movie.mkv -c copy -movflags +faststart movie.mp4
   # Anything else: re-encode once to a universally playable MP4
   ffmpeg -i movie.mkv -c:v libx264 -preset veryfast -crf 20 -c:a aac -b:a 160k -movflags +faststart movie.mp4
   ```
   `-movflags +faststart` puts the index at the start of the file so playback and seeking begin instantly.
3. **The PC must stay awake.** Turn off sleep while you're away, keep the Telegram Drive desktop app open and signed in, and keep its REST API enabled.
4. **Tunnel choice.** Tailscale Serve has no per-request upload cap and no CDN video restrictions. It is the right choice for media.
5. **If you put your own reverse proxy in front** (nginx, Caddy, Traefik), turn off buffering and long-request timeouts for the media routes, or long videos stall:
   ```nginx
   location /api/drive/ {
       proxy_pass http://127.0.0.1:8640;
       proxy_buffering off;            # stream video as it arrives
       proxy_request_buffering off;    # stream upload chunks straight through
       client_max_body_size 100m;      # chunks are 16 MB; leave headroom
       proxy_read_timeout 6h;          # long films / slow Telegram uploads
       proxy_send_timeout 6h;
   }
   ```
   With Caddy, `reverse_proxy 127.0.0.1:8640 { flush_interval -1 }` does the same.

Related settings in `.env`:

| Variable | Default | When to change |
| --- | --- | --- |
| `TDC_UPLOAD_CHUNK_MB` | `16` | Raise (up to 90) on a fast, reliable connection for slightly faster uploads; lower on flaky mobile links. Keep it under any proxy's request cap. |
| `TDC_MAX_UPLOAD_MB` | `1907` (≈ 2 GB) | Lower it to restrict upload size. It can't go above Telegram's 2 GB limit. |

### Keep it running

- **Windows:** create a Task Scheduler task "At log on" that runs `npm start` in the `kurovault` folder, or use a service wrapper such as NSSM.
- **macOS:** a `launchd` agent. **Linux:** a `systemd` service.
- The desktop app must be open and signed in, with **Settings → Advanced → REST API** enabled.

### Want it in the cloud instead?

Use option A at the top of this file. It talks to Telegram directly, so your PC can stay off.

## Putting the code on GitHub

Everything in `kurovault/` is new code. Publish it as **its own repository**, not as a copy of the whole Telegram Drive repo: that project doesn't include a license file, so republishing its code is not clearly allowed.

```bash
cd kurovault
git init
git add .
git commit -m "Kurovault"
git branch -M main
git remote add origin https://github.com/<you>/kurovault.git
git push -u origin main
```

Before pushing, check that `data/` and `.env` are **not** listed by `git status`. They hold your keys and the logs, and `.gitignore` already excludes them. Make the repository **private** if you don't want people to know how your instance is set up. The security doesn't depend on keeping the code secret, but there is no reason to advertise.

## Updating

```bash
git pull
npm ci
npm run build
npm start
```

The database upgrades in place and your logs are kept. Only the account named `admin` is an administrator; an existing Telegram connection from an older version moves to the admin account.

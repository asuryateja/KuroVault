// Direct Telegram source: Saved Messages plus the channels/groups you add become folders.
// Produces the same JSON shapes as the desktop REST API, so the browser UI works unchanged.
import { getSetting, setSetting } from '../db.js';
import { createFakeAdapter } from './adapter-fake.js';
import { createGramjsAdapter, describeTelegramError } from './adapter-gramjs.js';
import { zipStream } from './zip.js';

const REQUEST_SIZE = 1024 * 1024; // Telegram's maximum upload.getFile block; offsets stay 1 MiB aligned.
const FULL_RESCAN_MS = 10 * 60_000;
const INCREMENTAL_MS = 30_000;
const EXT_BY_MIME = {
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a',
  'audio/ogg': '.ogg', 'audio/flac': '.flac', 'audio/x-wav': '.wav', 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'application/pdf': '.pdf', 'application/zip': '.zip',
};
const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e.slice(1), m]));
Object.assign(MIME_BY_EXT, { jpeg: 'image/jpeg', m4v: 'video/mp4', opus: 'audio/ogg', txt: 'text/plain' });

export class TgError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const wrap = e => {
  if (e instanceof TgError) return e;
  const d = describeTelegramError(e);
  return new TgError(d.status, d.code, d.message);
};

/** Readable names for media that has no file name (videos forwarded from channels, photos). */
export function cleanName(item, alias) {
  if (alias) return alias;
  if (item.name) return item.name;
  const ext = EXT_BY_MIME[item.mime] ?? '';
  const line = (item.caption ?? '').split('\n').map(s => s.trim()).find(Boolean) ?? '';
  const text = line
    .replace(/https?:\/\/\S+/g, '')
    .replace(/(^|\s)[@#][\w.]+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+/u, '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
    .trim();
  if (text.length >= 2) return `${text}${ext}`;
  const kind = item.voice ? 'Voice note' : item.mime.startsWith('video/') ? 'Video' : item.mime.startsWith('audio/') ? 'Audio' : item.mime.startsWith('image/') ? 'Photo' : 'File';
  const day = new Date(item.date * 1000).toISOString().slice(0, 10);
  return `${kind} ${day} #${item.id}${ext}`;
}

export function ensureTelegramTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tg_user_folders (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, peer TEXT NOT NULL, title TEXT NOT NULL, type TEXT NOT NULL, added_at INTEGER NOT NULL, PRIMARY KEY (user_id, peer)) STRICT;
    CREATE TABLE IF NOT EXISTS tg_user_names (user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, peer TEXT NOT NULL, msg_id INTEGER NOT NULL, name TEXT NOT NULL, PRIMARY KEY (user_id, peer, msg_id)) STRICT;
  `);
}

/** One instance per Kurovault user: each user signs in to their own Telegram account. */
export function createTelegramService({ config, db, vault, audit, userId }) {
  const uid = Number(userId);
  const key = name => `${name}:${uid}`;
  const factory = config.telegramAdapter === 'fake' ? createFakeAdapter : createGramjsAdapter;
  let adapter = null;
  let account = null;
  let connectState = { state: 'idle', error: null };
  const index = new Map(); // peer -> { items: Map<id, item>, fullAt, syncedAt, complete }
  const syncing = new Map();
  let dialogCache = { at: 0, list: [] };
  const logins = new Map(); // userId -> pending login
  let reconnecting = null;

  const mode = () => getSetting(db, key('source_mode')) ?? 'desktop';
  const sealed = name => { const v = getSetting(db, key(name)); if (!v) return null; try { return vault.open(v, key(name)); } catch { return null; } };
  const seal = (name, value) => setSetting(db, key(name), value === null ? null : vault.seal(value, key(name)));
  const peerOf = folder => (folder === undefined || folder === null || folder === '' || folder === 'home' ? 'me' : String(folder));
  const folderJson = peer => (peer === 'me' ? null : Number(peer));

  async function connectSaved() {
    const api = sealed('tg_api');
    const session = sealed('tg_session');
    if (!api || !session) { connectState = { state: 'idle', error: null }; return; }
    connectState = { state: 'connecting', error: null };
    try {
      const { apiId, apiHash } = JSON.parse(api);
      const next = factory({ apiId, apiHash, session });
      await next.connect();
      if (!(await next.isAuthorized())) throw new TgError(401, 'TELEGRAM_SIGNED_OUT', 'The saved Telegram session is no longer valid. Connect your account again.');
      adapter = next;
      account = await adapter.me();
      connectState = { state: 'connected', error: null };
    } catch (e) {
      adapter = null;
      const w = wrap(e);
      // Telegram ended this login (e.g. terminated from the phone): forget it so the person can
      // simply sign in again with their phone number. Their saved API ID/hash are kept.
      if (w.code === 'TELEGRAM_SIGNED_OUT') { seal('tg_session', null); setSetting(db, key('source_mode'), null); connectState = { state: 'idle', error: 'Telegram signed this account out. Sign in again with your phone number.' }; return; }
      connectState = { state: 'error', error: w.message };
    }
  }

  function requireAdapter() {
    if (!adapter) throw new TgError(503, 'TELEGRAM_NOT_CONNECTED', connectState.error ?? 'Telegram is not connected. Connect your account under Security.');
    return adapter;
  }
  const call = async fn => { try { return await fn(requireAdapter()); } catch (e) { throw wrap(e); } };

  // ─── Index ─────────────────────────────────────────────────────────
  async function sync(peer, force = false) {
    const ix = index.get(peer);
    const now = Date.now();
    const full = force || !ix || now - ix.fullAt > FULL_RESCAN_MS;
    if (!full && now - ix.syncedAt < INCREMENTAL_MS) return ix;
    if (syncing.has(peer)) return syncing.get(peer);
    const job = (async () => {
      try {
        if (full) {
          const { items, complete } = await call(a => a.listMedia(peer, {}));
          const fresh = { items: new Map(items.map(i => [i.id, i])), fullAt: Date.now(), syncedAt: Date.now(), complete };
          index.set(peer, fresh);
          return fresh;
        }
        const maxId = Math.max(0, ...ix.items.keys());
        const { items } = await call(a => a.listMedia(peer, { minId: maxId }));
        for (const i of items) ix.items.set(i.id, i);
        ix.syncedAt = Date.now();
        return ix;
      } finally {
        syncing.delete(peer);
      }
    })();
    syncing.set(peer, job);
    return job;
  }

  const names = peer => new Map(db.prepare('SELECT msg_id, name FROM tg_user_names WHERE user_id = ? AND peer = ?').all(uid, peer).map(r => [r.msg_id, r.name]));
  const vaultPeers = () => db.prepare('SELECT * FROM tg_user_folders WHERE user_id = ? ORDER BY title COLLATE NOCASE').all(uid);
  const saveFolder = (peer, title, type) => db.prepare('INSERT OR REPLACE INTO tg_user_folders(user_id, peer, title, type, added_at) VALUES(?, ?, ?, ?, ?)').run(uid, String(peer), title, type, Date.now());
  const saveName = (peer, msgId, name) => db.prepare('INSERT OR REPLACE INTO tg_user_names(user_id, peer, msg_id, name) VALUES(?, ?, ?, ?)').run(uid, String(peer), Number(msgId), name);

  function fileJson(peer, item, aliases) {
    const name = cleanName(item, aliases?.get(item.id));
    return {
      id: item.id,
      folder_id: folderJson(peer),
      name,
      size: item.size,
      mime_type: item.mime,
      created_at: new Date(item.date * 1000).toISOString(),
      encrypted: /\.tdenc$/i.test(item.name || ''),
      protected: Boolean(item.protected),
      forwarded: Boolean(item.forwarded),
      video_codec: item.codec ?? null,
      variants: (item.variants ?? []).map(v => ({ index: v.index, codec: v.codec, width: v.width, height: v.height, size: v.size, mime: v.mime })),
      caption: (item.caption ?? '').slice(0, 500),
    };
  }

  async function item(peer, id) {
    let ix = await sync(peer);
    let it = ix.items.get(Number(id));
    if (!it) { ix = await sync(peer, true); it = ix.items.get(Number(id)); }
    if (!it) throw new TgError(404, 'NOT_FOUND', 'File not found.');
    return it;
  }

  async function dialogs(force = false) {
    if (!force && Date.now() - dialogCache.at < 60_000) return dialogCache.list;
    const list = await call(a => a.dialogs());
    dialogCache = { at: Date.now(), list };
    return list;
  }
  async function caps(peer) {
    if (peer === 'me') return { canPost: true, canDelete: true, canEdit: false, owned: true, protected: false, type: 'saved' };
    const d = (await dialogs()).find(x => x.id === peer) ?? (await dialogs(true)).find(x => x.id === peer);
    if (!d) throw new TgError(404, 'NOT_FOUND', 'That chat is not available to this account.');
    return d;
  }

  // ─── Login ─────────────────────────────────────────────────────────
  async function finishLogin(userId, pending, actor, ip) {
    const session = pending.adapter.sessionString();
    seal('tg_api', JSON.stringify({ apiId: pending.apiId, apiHash: pending.apiHash }));
    seal('tg_session', session);
    setSetting(db, key('source_mode'), 'telegram');
    if (adapter && adapter !== pending.adapter) await adapter.disconnect();
    adapter = pending.adapter;
    account = await adapter.me();
    connectState = { state: 'connected', error: null };
    index.clear();
    dialogCache = { at: 0, list: [] };
    logins.delete(userId);
    // Start with the channels you own (like Telegram Drive's folders); add others from the picker.
    try {
      const owned = (await dialogs(true)).filter(d => d.owned && d.type === 'channel').slice(0, 30);
      for (const d of owned) if (!vaultPeers().some(r => r.peer === d.id)) saveFolder(d.id, d.title, d.type);
    } catch { /* folders can be added later */ }
    audit.record('telegram.connected', { severity: 'high', actor, ip, detail: { account: account.username ? `@${account.username}` : account.name, method: pending.kind } });
  }

  function newLogin(userId, kind, apiId, apiHash) {
    const old = logins.get(userId);
    if (old && old.adapter !== adapter) void old.adapter.disconnect();
    let created;
    try { created = factory({ apiId, apiHash, session: '' }); } catch (e) { throw wrap(e); }
    const pending = { kind, apiId: String(apiId), apiHash: String(apiHash), adapter: created, step: 'connecting', expires: Date.now() + 10 * 60_000, error: null, qr: null, passwordWaiter: null, hint: '' };
    logins.set(userId, pending);
    return pending;
  }
  const pendingFor = userId => {
    const p = logins.get(userId);
    if (!p || p.expires < Date.now()) throw new TgError(409, 'NO_LOGIN', 'Start the Telegram sign-in again.');
    return p;
  };

  return {
    mode,
    active: () => mode() === 'telegram',
    connectSaved,
    connected: () => Boolean(adapter),
    /** The API ID/hash this person used before (sealed), so reconnecting needs only a phone number. */
    savedCredentials() {
      const api = sealed('tg_api');
      if (!api) return null;
      try { const { apiId, apiHash } = JSON.parse(api); return apiId && apiHash ? { apiId: String(apiId), apiHash: String(apiHash) } : null; } catch { return null; }
    },
    forgetCredentials() { seal('tg_api', null); },
    /** Reconnects the saved Telegram session on first use (after a restart or a new sign-in). */
    ready() {
      if (adapter || !sealed('tg_session')) return Promise.resolve();
      if (connectState.state === 'error' && Date.now() - (connectState.at ?? 0) < 30_000) return Promise.resolve();
      reconnecting ??= connectSaved().finally(() => { reconnecting = null; if (connectState.state === 'error') connectState.at = Date.now(); });
      return reconnecting;
    },
    async close() {
      for (const p of logins.values()) if (p.adapter !== adapter) await p.adapter.disconnect().catch(() => undefined);
      logins.clear();
      if (adapter) await adapter.disconnect().catch(() => undefined);
    },
    async setMode(next) {
      if (next === 'telegram' && !sealed('tg_session')) throw new TgError(409, 'NOT_CONNECTED', 'Connect a Telegram account first.');
      setSetting(db, key('source_mode'), next);
      if (next === 'telegram' && !adapter) await connectSaved();
    },

    status() {
      return {
        mode: 'telegram',
        ok: Boolean(adapter),
        authorized: Boolean(adapter),
        keyConfigured: Boolean(sealed('tg_session')),
        savedApp: (() => { const c = this.savedCredentials(); return c ? { apiIdHint: `••${c.apiId.slice(-3)}` } : null; })(),
        version: 'Telegram',
        ms: 0,
        state: connectState.state,
        error: connectState.error,
        account: account ? { name: account.name, username: account.username } : null,
      };
    },

    // Login flows ----------------------------------------------------
    async loginStart(userId, { apiId, apiHash, phone }) {
      const pending = newLogin(userId, 'phone', apiId, apiHash);
      try {
        await pending.adapter.connect();
        const r = await pending.adapter.sendCode(phone);
        pending.step = 'code';
        return { step: 'code', viaApp: r.viaApp };
      } catch (e) {
        logins.delete(userId);
        void pending.adapter.disconnect();
        throw wrap(e);
      }
    },
    async loginCode(userId, code, actor, ip) {
      const pending = pendingFor(userId);
      if (pending.step !== 'code') throw new TgError(409, 'WRONG_STEP', 'Not waiting for a code.');
      try {
        const r = await pending.adapter.signIn(code);
        if (r.needPassword) { pending.step = 'password'; return { step: 'password', hint: r.hint }; }
        await finishLogin(userId, pending, actor, ip);
        return { step: 'done', account };
      } catch (e) { throw wrap(e); }
    },
    async loginPassword(userId, password, actor, ip) {
      const pending = pendingFor(userId);
      if (pending.kind === 'qr') {
        if (pending.step !== 'password' || !pending.passwordWaiter) throw new TgError(409, 'WRONG_STEP', 'Not waiting for a password.');
        const waiter = pending.passwordWaiter;
        pending.passwordWaiter = null;
        pending.step = 'checking';
        waiter.resolve(password);
        for (let i = 0; i < 100 && pending.step === 'checking'; i += 1) await new Promise(r => setTimeout(r, 100));
        if (pending.step === 'done') return { step: 'done', account };
        throw new TgError(401, 'BAD_PASSWORD', pending.error ?? 'The two-step verification password is not correct.');
      }
      if (pending.step !== 'password') throw new TgError(409, 'WRONG_STEP', 'Not waiting for a password.');
      try {
        await pending.adapter.checkPassword(password);
        await finishLogin(userId, pending, actor, ip);
        return { step: 'done', account };
      } catch (e) { throw wrap(e); }
    },
    async qrStart(userId, { apiId, apiHash }, actor, ip) {
      const pending = newLogin(userId, 'qr', apiId, apiHash);
      try { await pending.adapter.connect(); } catch (e) { logins.delete(userId); throw wrap(e); }
      pending.step = 'waiting';
      void pending.adapter.qrLogin({
        onToken: (url, expires) => { pending.qr = { url, expires }; },
        getPassword: hint => new Promise((resolve, reject) => {
          pending.step = 'password';
          pending.hint = hint ?? '';
          pending.passwordWaiter = { resolve, reject };
        }),
      }).then(async () => {
        await finishLogin(userId, pending, actor, ip);
        pending.step = 'done';
      }).catch(e => {
        const w = wrap(e);
        if (pending.step === 'checking' && w.code === 'BAD_PASSWORD') { pending.error = w.message; pending.step = 'error'; return; }
        pending.error = w.message;
        pending.step = 'error';
      });
      for (let i = 0; i < 50 && !pending.qr && pending.step === 'waiting'; i += 1) await new Promise(r => setTimeout(r, 100));
      if (!pending.qr) throw new TgError(502, 'QR_UNAVAILABLE', pending.error ?? 'Telegram did not return a login QR code. Try the phone-number method.');
      return { step: 'waiting', url: pending.qr.url, expires: pending.qr.expires };
    },
    qrStatus(userId) {
      const pending = logins.get(userId);
      if (!pending) return account && adapter ? { step: 'done', account } : { step: 'none' };
      return { step: pending.step, url: pending.qr?.url ?? null, expires: pending.qr?.expires ?? null, hint: pending.hint, error: pending.error };
    },
    cancelLogin(userId) {
      const p = logins.get(userId);
      if (p) { logins.delete(userId); if (p.adapter !== adapter) void p.adapter.disconnect(); }
    },
    async logout(actor, ip) {
      if (adapter) { try { await adapter.logOut(); } catch { /* session may already be dead */ } await adapter.disconnect(); }
      adapter = null;
      account = null;
      connectState = { state: 'idle', error: null };
      seal('tg_session', null);
      setSetting(db, key('source_mode'), null);
      index.clear();
      audit.record('telegram.disconnected', { severity: 'high', actor, ip });
    },

    // Account intelligence -----------------------------------------
    async account() {
      const sessions = await call(a => a.authorizations());
      return { me: account, sessions };
    },
    async terminateSession(hash) {
      const sessions = await call(a => a.authorizations());
      const target = sessions.find(s => s.hash === String(hash));
      if (!target) throw new TgError(404, 'NOT_FOUND', 'Session not found.');
      if (target.current) throw new TgError(400, 'CURRENT_SESSION', 'This is Kurovault’s own session. Use “Disconnect Telegram” instead.');
      await call(a => a.resetAuthorization(hash));
      return target;
    },

    // Folders --------------------------------------------------------
    /** Every chat the account is in, like Telegram itself: channels, groups and private chats/bots. */
    async folders() {
      let live = [];
      try { live = await dialogs(); } catch {
        // Offline: fall back to the chats remembered from earlier.
        return vaultPeers().map((r, rank) => ({ id: Number(r.peer), name: r.title, parent_id: null, kind: r.type, rank, offline: true }));
      }
      return live.map((d, rank) => ({
        id: Number(d.id), name: d.title, parent_id: null, kind: d.type, bot: Boolean(d.bot), rank,
        owned: Boolean(d.owned), can_post: Boolean(d.canPost), can_delete: Boolean(d.canDelete), can_edit: Boolean(d.canEdit),
        protected: Boolean(d.protected), members: d.members ?? null, username: d.username ?? null,
      }));
    },
    async availableChats() {
      const rows = new Set(vaultPeers().map(r => r.peer));
      return (await dialogs(true)).map(d => ({ id: Number(d.id), title: d.title, type: d.type, owned: d.owned, protected: d.protected, members: d.members ?? null, added: rows.has(d.id) }));
    },
    async addFolder(peer) {
      const d = (await dialogs()).find(x => x.id === String(peer));
      if (!d) throw new TgError(404, 'NOT_FOUND', 'That chat is not available to this account.');
      saveFolder(d.id, d.title, d.type);
      return { id: Number(d.id), name: d.title };
    },
    removeFolder(peer) {
      db.prepare('DELETE FROM tg_user_folders WHERE user_id = ? AND peer = ?').run(uid, String(peer));
      index.delete(String(peer));
    },
    async createFolder(name) {
      const d = await call(a => a.createChannel(name));
      dialogCache.at = 0;
      saveFolder(d.id, d.title, 'channel');
      return { id: Number(d.id), name: d.title, parent_id: null };
    },
    async renameFolder(peer, name) {
      const c = await caps(String(peer));
      if (!c.canEdit) throw new TgError(403, 'TELEGRAM_FORBIDDEN', 'Only owners and admins can rename this chat.');
      await call(a => a.editTitle(String(peer), name));
      db.prepare('UPDATE tg_user_folders SET title = ? WHERE user_id = ? AND peer = ?').run(name, uid, String(peer));
      dialogCache.at = 0;
    },
    async deleteFolder(peer) {
      const c = await caps(String(peer));
      if (!c.owned || c.type !== 'channel') throw new TgError(403, 'TELEGRAM_FORBIDDEN', 'You can only delete channels you created. Use “Remove from Kurovault” to just hide it.');
      await call(a => a.deleteChannel(String(peer)));
      this.removeFolder(peer);
      dialogCache.at = 0;
    },
    async emptyFolders() {
      const out = [];
      for (const f of await this.folders()) {
        const ix = await sync(String(f.id));
        if (ix.items.size === 0) out.push(f);
      }
      return out;
    },

    // Files ----------------------------------------------------------
    async listFiles(q) {
      const peers = q.folder_id === undefined ? ['me', ...vaultPeers().map(r => r.peer)] : [peerOf(q.folder_id)];
      let rows = [];
      let complete = true;
      for (const peer of peers) {
        const ix = await sync(peer, q.refresh === 'true');
        complete &&= ix.complete;
        const aliases = names(peer);
        for (const it of ix.items.values()) rows.push(fileJson(peer, it, aliases));
      }
      if (q.mime_type) rows = rows.filter(f => f.mime_type.toLowerCase().includes(String(q.mime_type).toLowerCase()));
      if (q.search) { const s = String(q.search).toLowerCase(); rows = rows.filter(f => f.name.toLowerCase().includes(s) || f.caption.toLowerCase().includes(s)); }
      const dir = q.order === 'asc' ? 1 : -1;
      rows.sort((a, b) => (q.sort === 'name' ? a.name.localeCompare(b.name) : q.sort === 'size' ? a.size - b.size : a.created_at.localeCompare(b.created_at) || a.id - b.id) * dir);
      const limit = Math.min(100, Math.max(1, Number(q.limit) || 50));
      const page = Math.max(1, Number(q.page) || 1);
      const total = rows.length;
      const data = rows.slice((page - 1) * limit, page * limit);
      return { data, files: data, page, limit, total, complete, pagination: { page, limit, total, total_pages: Math.max(1, Math.ceil(total / limit)), has_next: page * limit < total, has_prev: page > 1 } };
    },
    async meta(id, folder) {
      const peer = peerOf(folder);
      return fileJson(peer, await item(peer, id), names(peer));
    },
    async mediaInfo(id, folder) {
      const it = await item(peerOf(folder), id);
      return { duration_secs: it.duration, width: it.width, height: it.height, audio_title: it.title, audio_performer: it.performer };
    },
    async thumbnail(id, folder) {
      const peer = peerOf(folder);
      const it = await item(peer, id);
      if (!it.hasThumb) return null;
      return call(a => a.thumbnail(peer, it.id));
    },
    /** Range-aware read. Telegram serves 1 MiB-aligned blocks; we trim to the exact bytes asked for. */
    async open(id, folder, { range, signal, purpose, variant = null }) {
      const peer = peerOf(folder);
      const main = await item(peer, id);
      const alt = variant === null ? null : (main.variants ?? []).find(v => v.index === Number(variant));
      if (variant !== null && !alt) throw new TgError(404, 'NOT_FOUND', 'That video quality is not available.');
      const it = alt ? { ...main, size: alt.size, mime: alt.mime } : main;
      if (/\.tdenc$/i.test(it.name || '')) throw new TgError(409, 'ENCRYPTED', 'This file is end-to-end encrypted by Telegram Drive. Open it in the desktop app.');
      if (purpose === 'download' && it.protected) throw new TgError(403, 'PROTECTED_CONTENT', 'This chat has content protection: you can watch it here, but not download it.');
      const total = it.size;
      let start = 0;
      let end = total - 1;
      let partial = false;
      const m = /^bytes=(\d*)-(\d*)$/.exec(range ?? '');
      if (m && (m[1] !== '' || m[2] !== '')) {
        partial = true;
        if (m[1] === '') { start = Math.max(0, total - Number(m[2])); }
        else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), total - 1); }
        if (start >= total || start > end) return { status: 416, headers: { 'content-range': `bytes */${total}` }, body: null, item: it };
      }
      const aligned = start - (start % REQUEST_SIZE);
      const count = Math.ceil((end + 1 - aligned) / REQUEST_SIZE);
      const source = requireAdapter();
      async function* body() {
        let skip = start - aligned;
        let remaining = end - start + 1;
        try {
          for await (const block of source.download(peer, it.id, { offset: aligned, count, requestSize: REQUEST_SIZE, signal, variant: alt ? alt.index : null })) {
            let c = block;
            if (skip) { if (c.length <= skip) { skip -= c.length; continue; } c = c.subarray(skip); skip = 0; }
            if (c.length > remaining) c = c.subarray(0, remaining);
            remaining -= c.length;
            yield c;
            if (remaining <= 0) return;
          }
        } catch (e) { if (!signal?.aborted) throw wrap(e); }
      }
      return {
        status: partial ? 206 : 200,
        headers: { 'content-length': String(end - start + 1), ...(partial ? { 'content-range': `bytes ${start}-${end}/${total}` } : {}) },
        body: body(),
        item: it,
        file: { ...fileJson(peer, main, names(peer)), ...(alt ? { mime_type: alt.mime, size: alt.size } : {}) },
      };
    },
    async archive(ids, folder, signal) {
      const peer = peerOf(folder);
      const aliases = names(peer);
      const entries = [];
      let total = 0;
      for (const id of ids) {
        const it = await item(peer, id);
        if (it.protected) throw new TgError(403, 'PROTECTED_CONTENT', `“${cleanName(it, aliases.get(it.id))}” is from a protected chat and cannot be downloaded.`);
        total += it.size;
        entries.push({ name: cleanName(it, aliases.get(it.id)), date: it.date * 1000, open: () => (async function* () { const r = await this.open(it.id, folder, { signal, purpose: 'download' }); yield* r.body; }).call(this) });
      }
      if (total > 0xf0000000) throw new TgError(413, 'TOO_LARGE', 'That selection is over 4 GB. Download the files separately.');
      return zipStream(entries);
    },
    async upload(path, { name, size, folder }) {
      const peer = peerOf(folder);
      const c = await caps(peer);
      if (!c.canPost) throw new TgError(403, 'TELEGRAM_FORBIDDEN', 'You cannot post files in this chat.');
      const mime = MIME_BY_EXT[name.toLowerCase().split('.').pop()] ?? 'application/octet-stream';
      const it = await call(a => a.sendFile(peer, path, { name, size, mime }));
      const ix = index.get(peer);
      if (ix && it) ix.items.set(it.id, it);
      return it ? fileJson(peer, it, names(peer)) : { success: true };
    },
    renameFile(id, folder, name) {
      saveName(peerOf(folder), id, name);
    },
    async deleteFiles(ids, folder) {
      const peer = peerOf(folder);
      const c = await caps(peer);
      if (!c.canDelete) throw new TgError(403, 'TELEGRAM_FORBIDDEN', 'You do not have permission to delete messages in this chat.');
      await call(a => a.deleteMessages(peer, ids));
      const ix = index.get(peer);
      for (const id of ids) { ix?.items.delete(Number(id)); db.prepare('DELETE FROM tg_user_names WHERE user_id = ? AND peer = ? AND msg_id = ?').run(uid, peer, Number(id)); }
      return { success: true, count: ids.length };
    },
    async copyFiles(ids, from, to) {
      const fromPeer = peerOf(from);
      const toPeer = peerOf(to);
      for (const id of ids) {
        const it = await item(fromPeer, id);
        if (it.protected) throw new TgError(403, 'PROTECTED_CONTENT', 'This chat has content protection: its files cannot be copied or moved.');
      }
      const target = await caps(toPeer);
      if (!target.canPost) throw new TgError(403, 'TELEGRAM_FORBIDDEN', 'You cannot post files in the destination chat.');
      const newIds = (await call(a => a.forward(fromPeer, ids, toPeer))) ?? [];
      // Renames made in Kurovault travel with the file.
      const aliases = names(fromPeer);
      newIds.forEach((nid, i) => {
        const alias = aliases.get(Number(ids[i]));
        if (nid && alias) saveName(toPeer, nid, alias);
      });
      if (index.has(toPeer)) await sync(toPeer, true);
      return { success: true, count: ids.length };
    },
    async moveFiles(ids, from, to) {
      const fromPeer = peerOf(from);
      if (fromPeer === peerOf(to)) return { success: true, count: 0 };
      const source = await caps(fromPeer);
      if (!source.canDelete) throw new TgError(403, 'TELEGRAM_FORBIDDEN', 'Moving needs permission to delete in the source chat. Use “Copy to…” instead.');
      await this.copyFiles(ids, from, to);
      await this.deleteFiles(ids, from);
      return { success: true, count: ids.length };
    },
    async storage() {
      const folders = [];
      let totalBytes = 0;
      let totalCount = 0;
      for (const peer of ['me', ...vaultPeers().map(r => r.peer)]) {
        const ix = await sync(peer);
        const size = [...ix.items.values()].reduce((s, i) => s + i.size, 0);
        totalBytes += size;
        totalCount += ix.items.size;
        if (peer !== 'me') folders.push({ id: Number(peer), name: vaultPeers().find(r => r.peer === peer)?.title, file_count: ix.items.size, size_bytes: size });
      }
      return { total_storage_used_bytes: totalBytes, total_file_count: totalCount, complete: true, folders, mime_types: [] };
    },
    async duplicates() {
      const groups = new Map();
      for (const peer of ['me', ...vaultPeers().map(r => r.peer)]) {
        const ix = await sync(peer);
        const aliases = names(peer);
        for (const it of ix.items.values()) {
          const f = fileJson(peer, it, aliases);
          const key = `${f.name}|${f.size}`;
          groups.set(key, [...(groups.get(key) ?? []), f]);
        }
      }
      return [...groups.values()].filter(g => g.length > 1).map(g => ({ name: g[0].name, size: g[0].size, files: g }));
    },
  };
}

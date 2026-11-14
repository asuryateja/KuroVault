// Real Telegram adapter (MTProto via GramJS). Everything Telegram-shaped lives here; the
// service above it only sees plain objects, which is what lets tests swap in a fake adapter.
import { randomBytes } from 'node:crypto';
import bigIntLib from 'big-integer';
import tg from 'telegram';
import passwordLib from 'telegram/Password.js';
import uploads from 'telegram/client/uploads.js';
import sessions from 'telegram/sessions/index.js';

const { TelegramClient, Api, utils } = tg;
const { StringSession } = sessions;
const { CustomFile } = uploads;
const { computeCheck } = passwordLib;
const bigInt = bigIntLib;

const errText = e => String(e?.errorMessage ?? e?.message ?? e);

function docAttrs(document) {
  const out = {};
  for (const a of document.attributes ?? []) {
    if (a instanceof Api.DocumentAttributeFilename) out.fileName = a.fileName;
    else if (a instanceof Api.DocumentAttributeVideo) Object.assign(out, { video: true, duration: a.duration, width: a.w, height: a.h, codec: a.videoCodec ? String(a.videoCodec).toLowerCase() : null });
    else if (a instanceof Api.DocumentAttributeAudio) Object.assign(out, { audio: true, voice: a.voice, duration: a.duration, title: a.title, performer: a.performer });
    else if (a instanceof Api.DocumentAttributeImageSize) Object.assign(out, { width: a.w, height: a.h });
  }
  return out;
}

function photoSize(photo) {
  let best = 0;
  let w = 0;
  let h = 0;
  for (const s of photo.sizes ?? []) {
    const size = s instanceof Api.PhotoSizeProgressive ? Math.max(...s.sizes) : Number(s.size ?? 0);
    if (size > best) { best = size; w = s.w; h = s.h; }
  }
  return { size: best, width: w, height: h };
}

/** Normalises a message with downloadable media; returns null for anything else. */
function toItem(message, chatProtected) {
  const media = message.media;
  const base = { id: message.id, date: message.date, caption: message.message ?? '', protected: Boolean(message.noforwards || chatProtected), forwarded: Boolean(message.fwdFrom) };
  if (media instanceof Api.MessageMediaDocument && media.document instanceof Api.Document) {
    const d = media.document;
    const a = docAttrs(d);
    // Telegram keeps extra encodings of some videos (e.g. an H.264 copy of an HEVC upload) in altDocuments.
    const variants = (media.altDocuments ?? []).map((alt, index) => {
      if (!(alt instanceof Api.Document)) return null;
      const v = docAttrs(alt);
      return { index, codec: v.codec ?? null, width: v.width ?? null, height: v.height ?? null, size: Number(alt.size.toString()), mime: alt.mimeType ?? 'video/mp4' };
    }).filter(Boolean);
    return { ...base, name: a.fileName ?? '', mime: d.mimeType ?? 'application/octet-stream', size: Number(d.size.toString()), duration: a.duration ?? null, width: a.width ?? null, height: a.height ?? null, title: a.title ?? null, performer: a.performer ?? null, hasThumb: Boolean(d.thumbs?.length), voice: Boolean(a.voice), codec: a.codec ?? null, variants };
  }
  if (media instanceof Api.MessageMediaPhoto && media.photo instanceof Api.Photo) {
    const p = photoSize(media.photo);
    return { ...base, name: '', mime: 'image/jpeg', size: p.size, duration: null, width: p.width, height: p.height, title: null, performer: null, hasThumb: true, voice: false };
  }
  return null;
}

export function createGramjsAdapter({ apiId, apiHash, session = '' }) {
  const client = new TelegramClient(new StringSession(session), Number(apiId), String(apiHash), {
    connectionRetries: 8,
    autoReconnect: true,
    deviceModel: 'Kurovault',
    systemVersion: 'Kurovault server',
    appVersion: '1.0',
    langCode: 'en',
    systemLangCode: 'en',
  });
  client.setLogLevel('error');
  const entities = new Map(); // marked peer id -> entity
  const messages = new Map(); // `${peer}:${id}` -> { message, at }
  let pendingCode = null;

  async function peerOf(peer) {
    if (peer === 'me') return 'me';
    if (!entities.has(peer)) await dialogs();
    const entity = entities.get(peer);
    if (!entity) throw Object.assign(new Error('That chat is not available to this account any more.'), { status: 404 });
    return entity;
  }

  async function message(peer, id, fresh = false) {
    const key = `${peer}:${id}`;
    const hit = messages.get(key);
    if (hit && !fresh && Date.now() - hit.at < 20 * 60_000) return hit.message;
    const [m] = await client.getMessages(await peerOf(peer), { ids: [Number(id)] });
    if (!m || !m.media) throw Object.assign(new Error('File not found.'), { status: 404 });
    messages.set(key, { message: m, at: Date.now() });
    if (messages.size > 2000) messages.delete(messages.keys().next().value);
    return m;
  }

  async function dialogs() {
    const list = [];
    for await (const d of client.iterDialogs({ limit: 800 })) {
      const e = d.entity;
      // Private chats and bots: many forwarded videos and files live there too.
      if (e instanceof Api.User) {
        if (e.self || e.deleted) continue;
        const id = String(utils.getPeerId(e));
        entities.set(id, e);
        list.push({
          id, title: [e.firstName, e.lastName].filter(Boolean).join(' ') || (e.username ? `@${e.username}` : 'Telegram user'),
          type: 'chat', bot: Boolean(e.bot), owned: false, canPost: true, canDelete: true, canEdit: false, protected: false,
          username: e.username ?? null, members: null, lastDate: d.date ?? null,
        });
        continue;
      }
      if (!(e instanceof Api.Channel || e instanceof Api.Chat)) continue;
      if (e instanceof Api.Chat && (e.deactivated || e.left)) continue;
      const id = String(utils.getPeerId(e));
      entities.set(id, e);
      const creator = Boolean(e.creator);
      const admin = e.adminRights;
      const isChannel = e instanceof Api.Channel && e.broadcast;
      list.push({
        id,
        title: e.title,
        type: isChannel ? 'channel' : 'group',
        owned: creator,
        canPost: creator || (isChannel ? Boolean(admin?.postMessages) : !e.defaultBannedRights?.sendMedia || Boolean(admin)),
        canDelete: creator || Boolean(admin?.deleteMessages),
        canEdit: creator || Boolean(admin?.changeInfo),
        protected: Boolean(e.noforwards),
        username: e.username ?? null,
        members: e.participantsCount ?? null,
        lastDate: d.date ?? null,
      });
    }
    return list;
  }

  return {
    async connect() { await client.connect(); },
    async disconnect() { try { await client.disconnect(); await client.destroy(); } catch { /* already closed */ } },
    sessionString: () => client.session.save(),
    async isAuthorized() { return client.checkAuthorization(); },

    // ── sign-in ──
    async sendCode(phone) {
      const r = await client.sendCode({ apiId: Number(apiId), apiHash: String(apiHash) }, phone);
      pendingCode = { phone, hash: r.phoneCodeHash };
      return { viaApp: r.isCodeViaApp };
    },
    async signIn(code) {
      if (!pendingCode) throw new Error('Request a code first.');
      try {
        const r = await client.invoke(new Api.auth.SignIn({ phoneNumber: pendingCode.phone, phoneCodeHash: pendingCode.hash, phoneCode: String(code) }));
        if (r instanceof Api.auth.AuthorizationSignUpRequired) throw Object.assign(new Error('This phone number has no Telegram account.'), { status: 400 });
        return { done: true };
      } catch (e) {
        if (errText(e).includes('SESSION_PASSWORD_NEEDED')) {
          const pwd = await client.invoke(new Api.account.GetPassword());
          return { needPassword: true, hint: pwd.hint ?? '' };
        }
        throw e;
      }
    },
    async checkPassword(password) {
      const pwd = await client.invoke(new Api.account.GetPassword());
      await client.invoke(new Api.auth.CheckPassword({ password: await computeCheck(pwd, password) }));
      return { done: true };
    },
    async qrLogin({ onToken, getPassword }) {
      await client.signInUserWithQrCode({ apiId: Number(apiId), apiHash: String(apiHash) }, {
        qrCode: async ({ token, expires }) => onToken(`tg://login?token=${token.toString('base64url')}`, expires * 1000),
        password: async hint => getPassword(hint),
        onError: async e => { const t = errText(e); return !/PASSWORD_HASH_INVALID/.test(t); },
      });
    },

    // ── account ──
    async me() {
      const u = await client.getMe();
      return { id: String(u.id), name: [u.firstName, u.lastName].filter(Boolean).join(' '), username: u.username ?? null, phone: u.phone ?? null, premium: Boolean(u.premium) };
    },
    async authorizations() {
      const r = await client.invoke(new Api.account.GetAuthorizations());
      return r.authorizations.map(a => ({
        hash: a.hash.toString(), current: Boolean(a.current), device: a.deviceModel, platform: `${a.platform} ${a.systemVersion}`.trim(), app: `${a.appName} ${a.appVersion}`.trim(),
        ip: a.ip, country: a.country, region: a.region, created: a.dateCreated * 1000, active: a.dateActive * 1000, official: Boolean(a.officialApp),
      }));
    },
    async resetAuthorization(hash) { await client.invoke(new Api.account.ResetAuthorization({ hash: bigInt(hash) })); },
    async logOut() { await client.invoke(new Api.auth.LogOut()); },

    // ── chats and media ──
    dialogs,
    async listMedia(peer, { minId = 0, limit = 20000 } = {}) {
      const entity = await peerOf(peer);
      const chatProtected = peer !== 'me' && Boolean(entity.noforwards);
      const items = [];
      let scanned = 0;
      for await (const m of client.iterMessages(entity, { limit: Math.min(limit * 4, 80000), minId })) {
        scanned += 1;
        const item = toItem(m, chatProtected);
        if (item) {
          items.push(item);
          messages.set(`${peer}:${m.id}`, { message: m, at: Date.now() });
          if (items.length >= limit) break;
        }
      }
      return { items, complete: items.length < limit, scanned };
    },
    /** Yields the bytes of [offset, offset + count*requestSize) in requestSize blocks. */
    async *download(peer, id, { offset, count, requestSize, signal, variant = null }) {
      let m = await message(peer, id);
      let retried = false;
      for (;;) {
        try {
          const alt = variant === null ? null : m.media?.altDocuments?.[variant];
          if (variant !== null && !(alt instanceof Api.Document)) throw Object.assign(new Error('That video quality is no longer available.'), { status: 404 });
          const info = utils.getFileInfo(alt ? new Api.MessageMediaDocument({ document: alt }) : m.media);
          const iter = client.iterDownload({ file: info.location, dcId: info.dcId, offset: bigInt(offset), requestSize, limit: count, fileSize: info.size });
          for await (const chunk of iter) {
            if (signal?.aborted) return;
            yield chunk;
            offset += chunk.length;
            count -= 1;
          }
          return;
        } catch (e) {
          if (!retried && /FILE_REFERENCE_(EXPIRED|INVALID)/.test(errText(e))) { retried = true; m = await message(peer, id, true); continue; }
          throw e;
        }
      }
    },
    async thumbnail(peer, id) {
      const m = await message(peer, id);
      const thumbs = m.media?.document?.thumbs ?? m.media?.photo?.sizes ?? [];
      if (!thumbs.length) return null;
      const pick = thumbs.findIndex(t => t.type === 'm') >= 0 ? thumbs.findIndex(t => t.type === 'm') : thumbs.length - 1;
      const buf = await client.downloadMedia(m, { thumb: pick });
      return Buffer.isBuffer(buf) ? buf : null;
    },
    async sendFile(peer, path, { name, size, mime, onProgress }) {
      const kind = mime.split('/')[0];
      const sent = await client.sendFile(await peerOf(peer), {
        file: new CustomFile(name, size, path),
        forceDocument: !['video', 'audio', 'image'].includes(kind),
        supportsStreaming: kind === 'video',
        workers: 4,
        attributes: [new Api.DocumentAttributeFilename({ fileName: name })],
        progressCallback: p => onProgress?.(p),
      });
      return toItem(sent, false);
    },
    /** Forwards without the "Forwarded from" header; returns the new message ids in the same order. */
    async forward(fromPeer, ids, toPeer) {
      const randomId = ids.map(() => bigInt(randomBytes(8).readBigInt64LE().toString()));
      const r = await client.invoke(new Api.messages.ForwardMessages({
        fromPeer: await peerOf(fromPeer), toPeer: await peerOf(toPeer), id: ids.map(Number), randomId, dropAuthor: true,
      }));
      const byRandom = new Map();
      for (const u of r?.updates ?? []) if (u.className === 'UpdateMessageID') byRandom.set(String(u.randomId), u.id);
      return randomId.map(x => byRandom.get(String(x)) ?? null);
    },
    async deleteMessages(peer, ids) {
      await client.deleteMessages(await peerOf(peer), ids.map(Number), { revoke: true });
      ids.forEach(id => messages.delete(`${peer}:${id}`));
    },
    async createChannel(title) {
      const r = await client.invoke(new Api.channels.CreateChannel({ title, about: 'Private Kurovault folder', broadcast: true }));
      const chat = r.chats?.[0];
      const id = String(utils.getPeerId(chat));
      entities.set(id, chat);
      return { id, title, type: 'channel', owned: true, canPost: true, canDelete: true, canEdit: true, protected: false };
    },
    async editTitle(peer, title) {
      const e = await peerOf(peer);
      if (e instanceof Api.Channel) await client.invoke(new Api.channels.EditTitle({ channel: e, title }));
      else await client.invoke(new Api.messages.EditChatTitle({ chatId: e.id, title }));
    },
    async deleteChannel(peer) {
      const e = await peerOf(peer);
      if (!(e instanceof Api.Channel)) throw Object.assign(new Error('Only channels can be deleted from Kurovault.'), { status: 400 });
      await client.invoke(new Api.channels.DeleteChannel({ channel: e }));
      entities.delete(peer);
    },
  };
}

/** Maps Telegram RPC errors to HTTP-friendly ones. */
export function describeTelegramError(e) {
  const t = errText(e);
  const flood = /FLOOD_WAIT_(\d+)/.exec(t);
  if (flood) return { status: 429, code: 'TELEGRAM_FLOOD_WAIT', message: `Telegram asked to slow down. Try again in ${flood[1]} s.` };
  if (/PHONE_CODE_INVALID|PHONE_CODE_EMPTY/.test(t)) return { status: 401, code: 'BAD_CODE', message: 'That login code is not correct.' };
  if (/PHONE_CODE_EXPIRED/.test(t)) return { status: 401, code: 'CODE_EXPIRED', message: 'That code expired. Request a new one.' };
  if (/PASSWORD_HASH_INVALID/.test(t)) return { status: 401, code: 'BAD_PASSWORD', message: 'The two-step verification password is not correct.' };
  if (/PHONE_NUMBER_INVALID/.test(t)) return { status: 400, code: 'BAD_PHONE', message: 'That phone number is not valid. Include the country code, e.g. +1…' };
  if (/API_ID_INVALID|API_ID_PUBLISHED_FLOOD/.test(t)) return { status: 400, code: 'BAD_API_ID', message: 'Telegram rejected this API ID / hash. Copy them again from my.telegram.org.' };
  if (/CHAT_ADMIN_REQUIRED|MESSAGE_DELETE_FORBIDDEN|CHAT_WRITE_FORBIDDEN|CHANNEL_PRIVATE|RIGHT_FORBIDDEN/.test(t)) return { status: 403, code: 'TELEGRAM_FORBIDDEN', message: 'Your Telegram account does not have permission to do that in this chat.' };
  if (/CHAT_FORWARDS_RESTRICTED/.test(t)) return { status: 403, code: 'PROTECTED_CONTENT', message: 'This chat has content protection: its files cannot be copied or saved.' };
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|USER_DEACTIVATED/.test(t)) return { status: 401, code: 'TELEGRAM_SIGNED_OUT', message: 'The Telegram session was signed out. Connect your account again.' };
  if (e?.status) return { status: e.status, code: 'TELEGRAM_ERROR', message: e.message };
  return { status: 502, code: 'TELEGRAM_ERROR', message: `Telegram error: ${t.slice(0, 160)}` };
}

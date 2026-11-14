// Test double for the Telegram adapter (enabled only with TDC_TELEGRAM_ADAPTER=fake AND
// TDC_ALLOW_FAKE_TELEGRAM=1). It enforces Telegram's real download alignment rules so the
// service's range math is exercised, and keeps state per process.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const FIX = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'tests', 'fixtures');
const fx = name => { try { return readFileSync(join(FIX, name)); } catch { return Buffer.from(name); } };
export const PHONE = '+15550001111';
export const CODE = '24680';
export const PASSWORD = 'blue-heron-77';

/** A playable 8-second WebM followed by padding, so it is big enough to need preparing. */
export function featureFilm() {
  return Buffer.concat([fx('clip.webm'), Buffer.alloc(25 * 1024 * 1024, 0)]);
}

/** Deterministic 3.5 MB payload so tests can check any byte range. */
export function datasetBytes() {
  const b = Buffer.alloc(3_500_000);
  for (let i = 0; i < b.length; i += 4) b.writeUInt32LE((i * 2654435761) >>> 0, i);
  return b;
}

const state = globalThis.__kurovaultFakeTelegram ??= (() => {
  const t = Math.floor(Date.parse('2026-10-20T10:00:00Z') / 1000);
  const media = (id, extra) => ({ id, date: t + id * 3600, caption: '', protected: false, forwarded: false, name: '', duration: null, width: null, height: null, title: null, performer: null, hasThumb: false, voice: false, ...extra });
  const chats = {
    me: { title: 'Saved Messages', items: [
      media(101, { caption: '🔥 Episode 12 — The Long Night\nFull episode, 1080p. Join @somechannel for more!', mime: 'video/webm', content: fx('clip.webm'), forwarded: true, duration: 8, width: 640, height: 360, hasThumb: true }),
      media(102, { mime: 'video/mp4', content: fx('briefing.mp4'), duration: 6, width: 640, height: 360, hasThumb: true }),
      media(103, { name: 'Night Watch.mp3', mime: 'audio/mpeg', content: fx('song.mp3'), duration: 6, title: 'Night Watch', performer: 'Kurovault Ensemble' }),
      media(104, { name: 'field-report.pdf', mime: 'application/pdf', content: fx('report.pdf') }),
      media(105, { mime: 'image/jpeg', content: fx('photo.jpg'), width: 1200, height: 800, hasThumb: true }),
      media(106, { name: 'dataset.bin', mime: 'application/octet-stream', content: datasetBytes(), slow: true }),
      media(107, { name: 'Season 1 pack.zip', mime: 'application/zip', content: fx('season.zip') }),
      media(108, { name: 'collection.rar', mime: 'application/vnd.rar', content: fx('collection.rar') }),
      // A long film that arrives slowly from "Telegram" (25 MB at ~8 MB/s), for smooth-playback preparation.
      media(112, { name: 'Feature Film.webm', mime: 'video/webm', content: featureFilm(), duration: 8, width: 640, height: 360, slowMs: 120 }),
      media(109, { name: 'odd-names.zip', mime: 'application/zip', content: fx('odd-names.zip') }),
      // An HEVC upload the browser cannot decode, with a playable alternative encoding (like Telegram's alt documents).
      media(110, { name: 'Episode 13.mp4', mime: 'video/mp4', codec: 'h265', content: Buffer.from('HEVC'.repeat(40_000)), duration: 8, width: 1920, height: 1080,
        alts: [{ codec: 'vp9', mime: 'video/webm', width: 640, height: 360, content: fx('clip.webm') }] }),
    ] },
    '-1001000000001': { title: 'Movies Archive', type: 'channel', owned: true, canPost: true, canDelete: true, canEdit: true, protected: false, items: [
      media(201, { name: 'Harbor documentary.webm', mime: 'video/webm', content: fx('clip.webm'), duration: 8, width: 640, height: 360, hasThumb: true }),
    ] },
    '-1001000000002': { title: 'News Feed', type: 'channel', owned: false, canPost: false, canDelete: false, canEdit: false, protected: true, items: [
      media(301, { caption: 'Breaking: harbor lights restored', mime: 'video/mp4', content: fx('briefing.mp4'), duration: 6, width: 640, height: 360, protected: true, hasThumb: true }),
      media(302, { name: 'press-kit.zip', mime: 'application/zip', content: fx('season.zip'), protected: true }),
    ] },
    '5000001': { title: 'Mom', type: 'chat', owned: false, canPost: true, canDelete: true, canEdit: false, protected: false, items: [
      media(501, { name: 'Birthday 2026.webm', mime: 'video/webm', content: fx('clip.webm'), duration: 8, width: 640, height: 360, hasThumb: true }),
    ] },
    '5000002': { title: 'FileStore Bot', type: 'chat', bot: true, owned: false, canPost: true, canDelete: true, canEdit: false, protected: false, items: [
      media(601, { name: 'The Harbor (2026) 1080p.mp4', mime: 'video/mp4', content: fx('briefing.mp4'), duration: 6, width: 640, height: 360, hasThumb: true }),
    ] },
    '-1001000000003': { title: 'Family', type: 'group', owned: false, canPost: true, canDelete: false, canEdit: false, protected: false, items: [
      media(401, { mime: 'image/jpeg', content: fx('photo.jpg'), width: 1200, height: 800, hasThumb: true }),
    ] },
  };
  return {
    chats,
    nextId: 1000,
    nextChannel: 1001000000100,
    authorized: false,
    sessions: [
      { hash: '1001', current: true, device: 'Kurovault', platform: 'Kurovault server', app: 'Kurovault 1.0', ip: '203.0.113.7', country: 'United States', region: 'Texas', created: Date.now() - 60_000, active: Date.now(), official: false },
      { hash: '1002', current: false, device: 'iPhone 16', platform: 'iOS 19.1', app: 'Telegram iOS 12.1', ip: '198.51.100.40', country: 'United States', region: 'Illinois', created: Date.now() - 86_400_000 * 40, active: Date.now() - 3_600_000, official: true },
      { hash: '1003', current: false, device: 'Chrome 141', platform: 'Windows 11', app: 'Telegram Web A', ip: '192.0.2.200', country: 'Germany', region: 'Berlin', created: Date.now() - 86_400_000 * 2, active: Date.now() - 86_400_000, official: true },
    ],
    stats: { downloadRequests: 0, alignmentViolations: 0, sendFile: 0 },
  };
})();
export const fakeState = state;

const pub = it => {
  const { content, alts, ...rest } = it;
  return { codec: null, ...rest, size: content.length, variants: (alts ?? []).map((a, index) => ({ index, codec: a.codec, width: a.width, height: a.height, size: a.content.length, mime: a.mime })) };
};
const find = (peer, id) => {
  const chat = state.chats[peer];
  if (!chat) throw Object.assign(new Error('CHANNEL_PRIVATE'), { errorMessage: 'CHANNEL_PRIVATE' });
  const it = chat.items.find(x => x.id === Number(id));
  if (!it) throw Object.assign(new Error('File not found.'), { status: 404 });
  return it;
};

export function createFakeAdapter({ apiId, apiHash, session = '' }) {
  if (String(apiId) === '1') throw Object.assign(new Error('API_ID_INVALID'), { errorMessage: 'API_ID_INVALID' });
  let sessionValue = session;
  let step = 'start';
  return {
    async connect() { if (session === 'fake-session-valid') state.authorized = true; },
    async disconnect() {},
    sessionString: () => sessionValue,
    async isAuthorized() { return state.authorized && sessionValue === 'fake-session-valid'; },
    async sendCode(phone) {
      if (String(apiHash).length !== 32) throw Object.assign(new Error('API_ID_INVALID'), { errorMessage: 'API_ID_INVALID' });
      if (phone.replace(/\s/g, '') !== PHONE) throw Object.assign(new Error('PHONE_NUMBER_INVALID'), { errorMessage: 'PHONE_NUMBER_INVALID' });
      step = 'code';
      return { viaApp: true };
    },
    async signIn(code) {
      if (step !== 'code') throw new Error('Request a code first.');
      if (String(code) !== CODE) throw Object.assign(new Error('PHONE_CODE_INVALID'), { errorMessage: 'PHONE_CODE_INVALID' });
      step = 'password';
      return { needPassword: true, hint: 'bird' };
    },
    async checkPassword(password) {
      if (password !== PASSWORD) throw Object.assign(new Error('PASSWORD_HASH_INVALID'), { errorMessage: 'PASSWORD_HASH_INVALID' });
      state.authorized = true;
      sessionValue = 'fake-session-valid';
      return { done: true };
    },
    async qrLogin({ onToken, getPassword }) {
      await onToken('tg://login?token=RkFLRS1RUi1UT0tFTg', Date.now() + 30_000);
      await new Promise(r => setTimeout(r, 1500));
      const pw = await getPassword('bird');
      if (pw !== PASSWORD) throw Object.assign(new Error('PASSWORD_HASH_INVALID'), { errorMessage: 'PASSWORD_HASH_INVALID' });
      state.authorized = true;
      sessionValue = 'fake-session-valid';
    },
    async me() { return { id: '777000111', name: 'Ada Lovelace', username: 'ada_ops', phone: PHONE.slice(1), premium: false }; },
    async authorizations() { return state.sessions.map(s => ({ ...s })); },
    async resetAuthorization(hash) { state.sessions = state.sessions.filter(s => s.hash !== String(hash) || s.current); },
    async logOut() { state.authorized = false; sessionValue = ''; },
    async dialogs() {
      return Object.entries(state.chats).filter(([id]) => id !== 'me').map(([id, c]) => ({ id, title: c.title, type: c.type, bot: Boolean(c.bot), owned: c.owned, canPost: c.canPost, canDelete: c.canDelete, canEdit: c.canEdit, protected: c.protected, username: null, members: c.type === 'chat' ? null : 12 }));
    },
    async listMedia(peer, { minId = 0 } = {}) {
      const chat = state.chats[peer];
      if (!chat) throw Object.assign(new Error('CHANNEL_PRIVATE'), { errorMessage: 'CHANNEL_PRIVATE' });
      return { items: chat.items.filter(x => x.id > minId).sort((a, b) => b.id - a.id).map(pub), complete: true };
    },
    async *download(peer, id, { offset, count, requestSize, signal, variant = null }) {
      const found = find(peer, id);
      const it = variant === null ? found : found.alts?.[variant];
      if (!it) throw Object.assign(new Error('That video quality is no longer available.'), { status: 404 });
      // Telegram's rules: offset divisible by the request size, request size ≤ 1 MiB and dividing 1 MiB.
      if (offset % requestSize !== 0 || requestSize > 1048576 || 1048576 % requestSize !== 0) { state.stats.alignmentViolations += 1; throw Object.assign(new Error('OFFSET_INVALID'), { errorMessage: 'OFFSET_INVALID' }); }
      for (let i = 0; i < count; i += 1) {
        if (signal?.aborted) return;
        const start = offset + i * requestSize;
        if (start >= it.content.length) return;
        state.stats.downloadRequests += 1;
        await new Promise(r => setTimeout(r, it.slowMs ?? (it.slow ? 40 : 2)));
        yield it.content.subarray(start, Math.min(it.content.length, start + requestSize));
      }
    },
    async thumbnail(peer, id) { const it = find(peer, id); return it.hasThumb ? fx('thumb.jpg') : null; },
    async sendFile(peer, path, { name, size, mime, onProgress }) {
      const chat = state.chats[peer];
      if (!chat?.canPost && peer !== 'me') throw Object.assign(new Error('CHAT_WRITE_FORBIDDEN'), { errorMessage: 'CHAT_WRITE_FORBIDDEN' });
      const content = readFileSync(path);
      if (content.length !== size) throw new Error('size mismatch');
      onProgress?.(1);
      state.stats.sendFile += 1;
      const item = { id: state.nextId++, date: Math.floor(Date.now() / 1000), caption: '', protected: false, forwarded: false, name, mime, content, duration: null, width: null, height: null, title: null, performer: null, hasThumb: false, voice: false };
      chat.items.push(item);
      return pub(item);
    },
    async forward(fromPeer, ids, toPeer) {
      const from = state.chats[fromPeer];
      const to = state.chats[toPeer];
      if (from.protected) throw Object.assign(new Error('CHAT_FORWARDS_RESTRICTED'), { errorMessage: 'CHAT_FORWARDS_RESTRICTED' });
      if (toPeer !== 'me' && !to.canPost) throw Object.assign(new Error('CHAT_WRITE_FORBIDDEN'), { errorMessage: 'CHAT_WRITE_FORBIDDEN' });
      const out = [];
      for (const id of ids) { const it = find(fromPeer, id); const nid = state.nextId++; out.push(nid); to.items.push({ ...it, id: nid, date: Math.floor(Date.now() / 1000), forwarded: false }); }
      return out;
    },
    async deleteMessages(peer, ids) {
      const chat = state.chats[peer];
      if (peer !== 'me' && !chat.canDelete) throw Object.assign(new Error('MESSAGE_DELETE_FORBIDDEN'), { errorMessage: 'MESSAGE_DELETE_FORBIDDEN' });
      chat.items = chat.items.filter(x => !ids.map(Number).includes(x.id));
    },
    async createChannel(title) {
      const id = `-${state.nextChannel++}`;
      state.chats[id] = { title, type: 'channel', owned: true, canPost: true, canDelete: true, canEdit: true, protected: false, items: [] };
      return { id, title, type: 'channel', owned: true, canPost: true, canDelete: true, canEdit: true, protected: false };
    },
    async editTitle(peer, title) { if (!state.chats[peer]?.canEdit) throw Object.assign(new Error('CHAT_ADMIN_REQUIRED'), { errorMessage: 'CHAT_ADMIN_REQUIRED' }); state.chats[peer].title = title; },
    async deleteChannel(peer) { if (!state.chats[peer]?.owned) throw Object.assign(new Error('CHAT_ADMIN_REQUIRED'), { errorMessage: 'CHAT_ADMIN_REQUIRED' }); delete state.chats[peer]; },
  };
}

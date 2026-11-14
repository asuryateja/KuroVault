// Controlled stand-in for the Telegram Drive desktop REST API (tests only).
// Validates X-API-Key like the real API, keeps files in memory, serves real
// media fixtures and honours HTTP Range requests the way the real API does.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.FAKE_DRIVE_PORT ?? 18550);
const KEY = process.env.FAKE_DRIVE_KEY ?? 'test-drive-key';
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = name => readFileSync(join(FIX, name));
const THUMB = fixture('thumb.jpg');

let folders = [
  { id: 1001, name: 'Documents', parent_id: null },
  { id: 1002, name: 'Media', parent_id: null },
  { id: 1003, name: 'Reports 2026', parent_id: 1001 },
  { id: 1004, name: 'Archive', parent_id: null },
];
let nextFolder = 2000;
let nextId = 60;
const file = (id, folder_id, name, mime_type, content, extra = {}) => ({ id, folder_id, name, mime_type, content, size: content.length, created_at: `2026-10-${String(10 + (id % 18)).padStart(2, '0')}T09:00:00Z`, encrypted: false, ...extra });
const files = [
  file(41, 1001, 'Quarterly report.pdf', 'application/pdf', fixture('report.pdf')),
  file(42, 1001, 'Contracts.zip', 'application/zip', Buffer.from('ZIP-BYTES'), { encrypted: true }),
  file(43, 1002, 'Harbor at dawn.jpg', 'image/jpeg', fixture('photo.jpg'), { thumb: true }),
  file(44, 1002, 'Night patrol.webm', 'video/webm', fixture('clip.webm'), { thumb: true, info: { duration_secs: 8, width: 640, height: 360 } }),
  file(45, 1002, 'Night Watch.mp3', 'audio/mpeg', fixture('song.mp3'), { info: { duration_secs: 6, audio_title: 'Night Watch', audio_performer: 'Kurovault Ensemble' } }),
  file(46, 1002, 'Briefing.mp4', 'video/mp4', fixture('briefing.mp4'), { thumb: true, info: { duration_secs: 6, width: 640, height: 360 } }),
  file(47, 1001, 'invite.html', 'text/html', Buffer.from('<script>document.title="pwned"</script>')),
  file(48, 1001, 'badge.svg', 'image/svg+xml', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>')),
  file(49, 1002, 'Vault footage.mp4', 'video/mp4', Buffer.from('ENVELOPE'), { encrypted: true }),
  file(50, 1003, 'Quarterly report.pdf', 'application/pdf', fixture('report.pdf')),
  file(52, 1002, 'Season pack.zip', 'application/zip', fixture('season.zip')),
  file(51, 1003, 'Budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', Buffer.alloc(2_500_000, 7)),
];
const readJson = async req => { const c = []; for await (const x of req) c.push(x); try { return JSON.parse(Buffer.concat(c).toString() || '{}'); } catch { return {}; } };
const parseFolder = v => (v === null || v === undefined || v === '' || v === 'home' ? null : Number(v));
export const stats = { rangeRequests: 0 };

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
const pub = f => ({ id: f.id, folder_id: f.folder_id, name: f.name, size: f.size, mime_type: f.mime_type, created_at: f.created_at, encrypted: f.encrypted });

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const path = url.pathname.replace(/^\/api\/v1/, '');
  if (path === '/health') return json(res, 200, { status: 'ok', version: '4.1.2' });
  if (path === '/__uploads') return json(res, 200, files.filter(f => f.id >= 60).map(f => ({ ...pub(f), sha: createHash('sha256').update(f.content).digest('hex') })));
  if (path === '/__stats') return json(res, 200, stats);
  if (req.headers['x-api-key'] !== KEY) return json(res, 401, { error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } });
  if (path === '/folders' && req.method === 'GET') return json(res, 200, folders);
  if (path === '/folders' && req.method === 'POST') {
    const { name } = await readJson(req);
    const folder = { id: nextFolder++, name, parent_id: null };
    folders.push(folder);
    return json(res, 200, folder);
  }
  if (path === '/folders/empty') return json(res, 200, folders.filter(f => !files.some(x => x.folder_id === f.id) && !folders.some(c => c.parent_id === f.id)));
  if (path === '/storage/duplicates') {
    const groups = new Map();
    for (const f of files) { const k = `${f.name}|${f.size}`; groups.set(k, [...(groups.get(k) ?? []), f]); }
    return json(res, 200, [...groups.values()].filter(g => g.length > 1).map(g => ({ name: g[0].name, size: g[0].size, files: g.map(pub) })));
  }
  const fm = /^\/folders\/(\d+)$/.exec(path);
  if (fm) {
    const folder = folders.find(f => f.id === Number(fm[1]));
    if (!folder) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'Folder not found' } });
    if (req.method === 'PATCH') { folder.name = (await readJson(req)).name; return json(res, 200, { success: true }); }
    if (req.method === 'DELETE') {
      folders = folders.filter(f => f.id !== folder.id);
      for (let i = files.length - 1; i >= 0; i -= 1) if (files[i].folder_id === folder.id) files.splice(i, 1);
      return json(res, 200, { success: true });
    }
  }
  if (path === '/files/bulk' && req.method === 'POST') {
    const body = await readJson(req);
    const ids = new Set(body.file_ids);
    if (body.action === 'archive') {
      res.writeHead(200, { 'Content-Type': 'application/zip' });
      return res.end(Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from(JSON.stringify([...ids]))]));
    }
    let count = 0;
    for (let i = files.length - 1; i >= 0; i -= 1) {
      if (!ids.has(files[i].id)) continue;
      count += 1;
      if (body.action === 'delete') files.splice(i, 1);
      else if (body.action === 'move') files[i].folder_id = parseFolder(body.payload?.folder_id);
    }
    return json(res, 200, { success: true, count });
  }
  if (path === '/storage/stats') {
    return json(res, 200, { total_storage_used_bytes: files.reduce((s, f) => s + f.size, 0), total_file_count: files.length, complete: true, folders: folders.map(f => ({ ...f, file_count: files.filter(x => x.folder_id === f.id).length })), mime_types: [] });
  }
  if (path === '/files' && req.method === 'GET') {
    const folder = url.searchParams.get('folder_id');
    const search = (url.searchParams.get('search') ?? '').toLowerCase();
    const mime = (url.searchParams.get('mime_type') ?? '').toLowerCase();
    const home = folder === 'home' || folder === '' || folder === 'null';
    const list = files.filter(f => (folder === null || (home ? f.folder_id === null : String(f.folder_id) === folder)) && f.name.toLowerCase().includes(search) && f.mime_type.toLowerCase().includes(mime));
    const sort = url.searchParams.get('sort') ?? 'created_at';
    const dir = url.searchParams.get('order') === 'asc' ? 1 : -1;
    list.sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name) : sort === 'size' ? a.size - b.size : a.created_at.localeCompare(b.created_at)) * dir);
    return json(res, 200, { data: list.map(pub), files: list.map(pub), page: 1, limit: 50, total: list.length, complete: true, pagination: { page: 1, limit: 50, total: list.length, total_pages: 1, has_next: false, has_prev: false } });
  }
  if (path === '/files' && req.method === 'POST') {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks);
    const boundary = /boundary=(.+)$/.exec(req.headers['content-type'] ?? '')?.[1];
    if (!boundary) return json(res, 400, { error: { code: 'BAD_MULTIPART', message: 'No boundary' } });
    const text = raw.toString('latin1');
    const folder = /name="folder_id"\r\n\r\n(-?\d+)/.exec(text)?.[1];
    const fileHeader = /name="file"; filename="([^"]*)"[^]*?\r\n\r\n/.exec(text);
    if (!fileHeader) return json(res, 400, { error: { code: 'BAD_MULTIPART', message: 'No file part' } });
    const start = fileHeader.index + fileHeader[0].length;
    const end = text.indexOf(`\r\n--${boundary}`, start);
    const content = raw.subarray(start, end);
    if (req.headers['content-length'] && Number(req.headers['content-length']) !== raw.length) return json(res, 400, { error: { code: 'LENGTH_MISMATCH', message: 'Length mismatch' } });
    const created = file(nextId++, folder ? Number(folder) : null, Buffer.from(fileHeader[1], 'latin1').toString('utf8'), 'application/octet-stream', content);
    files.push(created);
    return json(res, 200, pub(created));
  }
  const cm = /^\/files\/(\d+)\/copy$/.exec(path);
  if (cm && req.method === 'POST') {
    const src = files.find(f => f.id === Number(cm[1]));
    if (!src) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'File not found' } });
    const body = await readJson(req);
    files.push({ ...src, id: nextId++, folder_id: parseFolder(body.folder_id) });
    return json(res, 200, { success: true });
  }
  const m = /^\/files\/(\d+)(\/download|\/thumbnail|\/media-info)?$/.exec(path);
  if (m) {
    const idx = files.findIndex(f => f.id === Number(m[1]));
    if (idx < 0) return json(res, 404, { error: { code: 'NOT_FOUND', message: 'File not found' } });
    const f = files[idx];
    if (m[2] === '/thumbnail') {
      if (f.encrypted) return json(res, 409, { error: { code: 'ENCRYPTED', message: 'Encrypted' } });
      if (!f.thumb) return json(res, 404, { error: { code: 'NO_THUMBNAIL', message: 'No thumbnail' } });
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': THUMB.length });
      return res.end(THUMB);
    }
    if (m[2] === '/media-info') return json(res, 200, f.info ?? { duration_secs: null, width: null, height: null, audio_title: null, audio_performer: null });
    if (m[2] === '/download') {
      if (f.encrypted) return json(res, 409, { error: { code: 'ENCRYPTED_FILE', message: 'The file is encrypted' } });
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
      const base = { 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Disposition': `attachment; filename="${f.name}"` };
      if (range) {
        stats.rangeRequests += 1;
        let start = range[1] === '' ? f.size - Number(range[2]) : Number(range[1]);
        let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : f.size - 1;
        if (start >= f.size || start < 0) { res.writeHead(416, { 'Content-Range': `bytes */${f.size}` }); return res.end(); }
        end = Math.min(end, f.size - 1);
        res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${f.size}`, 'Content-Length': end - start + 1 });
        return res.end(f.content.subarray(start, end + 1));
      }
      res.writeHead(200, { ...base, 'Content-Length': f.size });
      return res.end(f.content);
    }
    if (req.method === 'DELETE') { files.splice(idx, 1); return json(res, 200, { success: true }); }
    if (req.method === 'PATCH') {
      if (f.encrypted) return json(res, 409, { error: { code: 'ENCRYPTED_FILE', message: 'Encrypted' } });
      const body = await readJson(req);
      if (body.name !== undefined) f.name = body.name;
      if (body.folder_id !== undefined) f.folder_id = parseFolder(body.folder_id);
      return json(res, 200, { success: true });
    }
    return json(res, 200, pub(f));
  }
  json(res, 404, { error: { code: 'NOT_FOUND', message: 'Unknown route' } });
}).listen(PORT, '127.0.0.1', () => console.log(`fake drive on ${PORT}`));

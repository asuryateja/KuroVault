// Archive browsing: list and play files inside ZIP and RAR archives without unpacking them for the user.
//
// ZIP  — read in place with byte ranges (central directory at the end, then each entry's data). Stored entries
//        are seekable without downloading anything else; deflated entries are inflated on the fly.
// RAR  — the format has no random-access index, so the archive is fetched once into a size-limited cache and
//        single entries are extracted with the official unrar engine (node-unrar-js, WebAssembly).
//
// Nothing is ever written using a path from inside an archive: extracted entries get numeric file names,
// so "../../" tricks and absolute paths cannot escape the cache.
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createInflateRaw } from 'node:zlib';

const require = createRequire(import.meta.url);
let unrar = null;
const loadUnrar = () => (unrar ??= require('node-unrar-js'));

export class ArchiveError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const MAX_CENTRAL_DIRECTORY = 64 * 1024 * 1024;
const MAX_ENTRIES = 50_000;
const CP437 = 'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';
const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeName(bytes, isUtf8) {
  if (isUtf8) return Buffer.from(bytes).toString('utf8');
  try { return utf8.decode(bytes); } catch { /* legacy DOS code page */ }
  let s = '';
  for (const b of bytes) s += b < 128 ? String.fromCharCode(b) : CP437[b - 128];
  return s;
}

/** Display path: forward slashes, no empty, "." or ".." segments, no control characters. */
export function cleanPath(raw) {
  return String(raw).replace(/\\/g, '/').split('/').map(p => p.replace(/[\u0000-\u001f\u007f]/g, '').trim()).filter(p => p && p !== '.' && p !== '..').join('/');
}

export function parseRange(header, total) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header ?? ''));
  if (!m || (m[1] === '' && m[2] === '')) return { start: 0, end: total - 1, partial: false };
  let start;
  let end = total - 1;
  if (m[1] === '') start = Math.max(0, total - Number(m[2]));
  else { start = Number(m[1]); if (m[2] !== '') end = Math.min(Number(m[2]), total - 1); }
  if (start >= total || start > end) return { unsatisfiable: true };
  return { start, end, partial: true };
}

async function collect(iterable, limit) {
  const parts = [];
  let n = 0;
  for await (const c of iterable) { parts.push(c); n += c.length; if (n >= limit) break; }
  return Buffer.concat(parts).subarray(0, limit);
}

// ─── ZIP ───────────────────────────────────────────────────────────────
async function readZipIndex(read, size) {
  const tailLen = Math.min(size, 22 + 0xffff + 20);
  const tail = await collect(read(size - tailLen, size - 1), tailLen);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i -= 1) {
    if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; if (i + 22 + tail.readUInt16LE(i + 20) === tail.length) break; }
  }
  if (eocd < 0) throw new ArchiveError(422, 'BAD_ARCHIVE', 'This ZIP file is damaged or incomplete (no directory found).');
  if (tail.readUInt16LE(eocd + 4) !== 0 || tail.readUInt16LE(eocd + 6) !== 0) throw new ArchiveError(422, 'SPLIT_ARCHIVE', 'Split (multi-part) ZIP archives are not supported.');
  let count = tail.readUInt16LE(eocd + 10);
  let cdSize = tail.readUInt32LE(eocd + 12);
  let cdOffset = tail.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20;
    if (loc < 0 || tail.readUInt32LE(loc) !== 0x07064b50) throw new ArchiveError(422, 'BAD_ARCHIVE', 'This ZIP64 file is damaged.');
    const recOffset = Number(tail.readBigUInt64LE(loc + 8));
    const rec = await collect(read(recOffset, recOffset + 55), 56);
    if (rec.readUInt32LE(0) !== 0x06064b50) throw new ArchiveError(422, 'BAD_ARCHIVE', 'This ZIP64 file is damaged.');
    count = Number(rec.readBigUInt64LE(32));
    cdSize = Number(rec.readBigUInt64LE(40));
    cdOffset = Number(rec.readBigUInt64LE(48));
  }
  if (cdSize > MAX_CENTRAL_DIRECTORY || count > MAX_ENTRIES) throw new ArchiveError(413, 'TOO_MANY_ENTRIES', `This archive lists more than ${MAX_ENTRIES.toLocaleString('en')} files.`);
  if (cdOffset + cdSize > size) throw new ArchiveError(422, 'BAD_ARCHIVE', 'This ZIP file is damaged or incomplete.');
  const cd = cdSize ? await collect(read(cdOffset, cdOffset + cdSize - 1), cdSize) : Buffer.alloc(0);
  const entries = [];
  let p = 0;
  while (p + 46 <= cd.length && cd.readUInt32LE(p) === 0x02014b50 && entries.length < MAX_ENTRIES) {
    const flags = cd.readUInt16LE(p + 8);
    const method = cd.readUInt16LE(p + 10);
    const time = cd.readUInt16LE(p + 12);
    const date = cd.readUInt16LE(p + 14);
    let packed = cd.readUInt32LE(p + 20);
    let size_ = cd.readUInt32LE(p + 24);
    const nameLen = cd.readUInt16LE(p + 28);
    const extraLen = cd.readUInt16LE(p + 30);
    const commentLen = cd.readUInt16LE(p + 32);
    let offset = cd.readUInt32LE(p + 42);
    const nameBytes = cd.subarray(p + 46, p + 46 + nameLen);
    const extra = cd.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);
    let name = decodeName(nameBytes, Boolean(flags & 0x0800));
    for (let e = 0; e + 4 <= extra.length;) {
      const id = extra.readUInt16LE(e);
      const len = extra.readUInt16LE(e + 2);
      const body = extra.subarray(e + 4, e + 4 + len);
      if (id === 0x0001) {
        let q = 0;
        const next = () => { const v = q + 8 <= body.length ? Number(body.readBigUInt64LE(q)) : null; q += 8; return v; };
        if (size_ === 0xffffffff) size_ = next() ?? size_;
        if (packed === 0xffffffff) packed = next() ?? packed;
        if (offset === 0xffffffff) offset = next() ?? offset;
      } else if (id === 0x7075 && body.length > 5 && body[0] === 1) {
        name = body.subarray(5).toString('utf8');
      }
      e += 4 + len;
    }
    const raw = name;
    const dir = /[\\/]$/.test(raw);
    const encrypted = Boolean(flags & 0x0001) || method === 99;
    entries.push({
      index: entries.length, path: cleanPath(raw), dir, size: dir ? 0 : size_, packed, encrypted,
      method: method === 0 ? 'store' : method === 8 ? 'deflate' : `method-${method}`,
      supported: !dir && !encrypted && (method === 0 || method === 8),
      date: new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime() || null,
      offset,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function zipEntryBody(read, entry, start, end, signal) {
  const head = await collect(read(entry.offset, entry.offset + 29), 30);
  if (head.readUInt32LE(0) !== 0x04034b50) throw new ArchiveError(422, 'BAD_ARCHIVE', 'This ZIP entry is damaged.');
  const dataStart = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
  if (entry.method === 'store') return read(dataStart + start, dataStart + end, signal);
  // Deflate: inflate from the beginning of the entry and pass on only the requested window.
  const compressed = Readable.from(read(dataStart, dataStart + entry.packed - 1, signal));
  const inflate = createInflateRaw();
  compressed.on('error', e => inflate.destroy(e));
  compressed.pipe(inflate);
  const want = end - start + 1;
  return (async function* () {
    let pos = 0;
    let sent = 0;
    try {
      for await (const chunk of inflate) {
        if (pos + chunk.length > entry.size + 1) throw new ArchiveError(422, 'BAD_ARCHIVE', 'The entry is larger than the archive claims; stopped for safety.');
        const from = Math.max(0, start - pos);
        pos += chunk.length;
        if (from >= chunk.length) continue;
        const piece = chunk.subarray(from, from + (want - sent));
        sent += piece.length;
        yield piece;
        if (sent >= want) return;
      }
    } finally {
      compressed.destroy();
      inflate.destroy();
    }
  })();
}

// ─── Service ───────────────────────────────────────────────────────────
/**
 * @param source.read(ref, start, end, signal) async iterable of the archive's bytes [start, end]
 */
export function createArchiveService({ config, source }) {
  rmSync(config.archiveCacheDir, { recursive: true, force: true });
  mkdirSync(config.archiveCacheDir, { recursive: true, mode: 0o700 });
  const listings = new Map(); // key -> { kind, entries }
  const jobs = new Map();     // key -> { received, size, promise, error }
  const extracting = new Map();
  const cache = new Map();    // path -> { bytes, used, busy }

  const keyOf = ref => createHash('sha256').update(`${ref.key}:${ref.size}`).digest('hex').slice(0, 32);
  const readerFor = ref => (start, end, signal) => source.read(ref, start, end, signal);

  function track(path, bytes) { cache.set(path, { bytes, used: Date.now(), busy: 0 }); }
  function touch(path) { const c = cache.get(path); if (c) c.used = Date.now(); return c; }
  function cacheBytes() { let n = 0; for (const c of cache.values()) n += c.bytes; return n; }
  function makeRoom(needed) {
    if (needed > config.archiveCacheBytes) throw new ArchiveError(413, 'TOO_LARGE', `This needs ${Math.ceil(needed / 1048576)} MB of cache; the limit is ${Math.floor(config.archiveCacheBytes / 1048576)} MB (TDC_ARCHIVE_CACHE_MB).`);
    const victims = [...cache.entries()].filter(([, c]) => !c.busy).sort((a, b) => a[1].used - b[1].used);
    while (cacheBytes() + needed > config.archiveCacheBytes && victims.length) {
      const [path] = victims.shift();
      rmSync(path, { recursive: true, force: true });
      cache.delete(path);
      for (const [k, l] of listings) if (l.file === path) listings.delete(k);
    }
    if (cacheBytes() + needed > config.archiveCacheBytes) throw new ArchiveError(503, 'CACHE_BUSY', 'The archive cache is full with files that are playing right now. Try again shortly.');
  }

  async function sniff(ref) {
    const head = await collect(source.read(ref, 0, Math.min(ref.size, 8) - 1), 8);
    if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return 'zip';
    if (head.length >= 4 && head.readUInt32LE(0) === 0x06054b50) return 'zip';
    if (head.subarray(0, 6).equals(Buffer.from('Rar!\x1a\x07', 'latin1'))) return 'rar';
    return null;
  }

  // RAR: fetch the whole archive once (shared by concurrent viewers), then list it.
  function fetchRar(ref, key) {
    const existing = jobs.get(key);
    if (existing) return existing;
    if (ref.size > config.archiveMaxBytes) throw new ArchiveError(413, 'TOO_LARGE', `RAR archives up to ${Math.floor(config.archiveMaxBytes / 1048576)} MB can be opened (TDC_ARCHIVE_MAX_MB). ZIP files have no size limit.`);
    makeRoom(ref.size);
    const file = join(config.archiveCacheDir, `${key}.rar`);
    const job = { received: 0, size: ref.size, error: null, done: false };
    job.promise = (async () => {
      const part = `${file}.part`;
      const fh = await openFile(part, 'w', 0o600);
      try {
        for await (const chunk of source.read(ref, 0, ref.size - 1)) { await fh.write(chunk); job.received += chunk.length; }
      } finally { await fh.close(); }
      if (job.received !== ref.size) throw new ArchiveError(502, 'INCOMPLETE', 'The archive download stopped early. Try again.');
      renameSync(part, file);
      track(file, ref.size);
      return file;
    })().then(path => { job.done = true; return path; }, error => {
      job.error = error;
      rmSync(`${file}.part`, { force: true });
      setTimeout(() => jobs.delete(key), 30_000).unref?.();
      throw error;
    });
    job.promise.catch(() => undefined);
    jobs.set(key, job);
    return job;
  }

  // Output names never come from the archive: every write goes to `<index>.bin` in our own folder.
  async function rarExtractor(file, targetPath, outName = 'unused.bin') {
    const { createExtractorFromFile } = loadUnrar();
    try { return await createExtractorFromFile({ filepath: file, targetPath, filenameTransform: () => outName }); } catch (e) { throw rarError(e); }
  }
  function rarError(e) {
    if (e instanceof ArchiveError) return e;
    const reason = String(e?.reason ?? e?.message ?? e);
    if (/password|ERAR_MISSING_PASSWORD|ERAR_BAD_PASSWORD/i.test(reason)) return new ArchiveError(409, 'PASSWORD_PROTECTED', 'This archive is password-protected. Password-protected archives are not supported yet.');
    if (/volume|ERAR_EOPEN/i.test(reason)) return new ArchiveError(422, 'SPLIT_ARCHIVE', 'This looks like one part of a multi-part RAR. Multi-part archives are not supported.');
    return new ArchiveError(422, 'BAD_ARCHIVE', `This RAR archive could not be read (${reason.slice(0, 120)}).`);
  }

  async function listRar(file) {
    const ex = await rarExtractor(file, join(config.archiveCacheDir, 'tmp'));
    let headers;
    try { headers = [...ex.getFileList().fileHeaders]; } catch (e) { throw rarError(e); }
    if (headers.length > MAX_ENTRIES) throw new ArchiveError(413, 'TOO_MANY_ENTRIES', `This archive lists more than ${MAX_ENTRIES.toLocaleString('en')} files.`);
    return headers.map((h, index) => ({
      index, rawName: h.name, path: cleanPath(h.name), dir: Boolean(h.flags.directory), size: h.flags.directory ? 0 : Number(h.unpSize), packed: Number(h.packSize),
      encrypted: Boolean(h.flags.encrypted), method: String(h.method ?? '').toLowerCase(), solid: Boolean(h.flags.solid),
      supported: !h.flags.directory && !h.flags.encrypted, date: Date.parse(h.time) || null,
    }));
  }

  /** Returns the listing, or { pending, received, size } while a RAR is still being fetched. */
  async function list(ref) {
    const key = keyOf(ref);
    const hit = listings.get(key);
    if (hit) { if (hit.file) touch(hit.file); return { kind: hit.kind, entries: hit.entries }; }
    const kind = await sniff(ref);
    if (!kind) throw new ArchiveError(415, 'NOT_AN_ARCHIVE', 'This file is not a ZIP or RAR archive.');
    if (kind === 'zip') {
      const entries = await readZipIndex(readerFor(ref), ref.size);
      listings.set(key, { kind, entries });
      return { kind, entries };
    }
    const job = fetchRar(ref, key);
    if (!job.done) {
      if (job.error) throw job.error;
      return { kind, pending: true, received: job.received, size: job.size };
    }
    const file = await job.promise;
    const entries = await listRar(file);
    listings.set(key, { kind, entries, file });
    jobs.delete(key);
    return { kind, entries };
  }

  async function ready(ref) {
    let r = await list(ref);
    for (let i = 0; r.pending && i < 600; i += 1) { await new Promise(res => setTimeout(res, 250)); r = await list(ref); }
    if (r.pending) throw new ArchiveError(504, 'STILL_FETCHING', 'The archive is still being fetched. Try again in a moment.');
    return r;
  }

  async function extractRar(ref, entry) {
    const key = keyOf(ref);
    const listing = listings.get(key);
    const dir = join(config.archiveCacheDir, key);
    const out = join(dir, `${entry.index}.bin`);
    if (existsSync(out) && statSync(out).size === entry.size) { touch(out); return out; }
    const jobKey = `${key}:${entry.index}`;
    if (extracting.has(jobKey)) return extracting.get(jobKey);
    const job = (async () => {
      makeRoom(entry.size);
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const ex = await rarExtractor(listing.file, dir, `${entry.index}.bin`);
      let i = -1;
      try {
        const result = ex.extract({ files: () => (i += 1) === entry.index });
        for (const f of result.files) void f; // drive the generator: extraction happens while iterating
      } catch (e) { rmSync(out, { force: true }); throw rarError(e); }
      if (!existsSync(out) || statSync(out).size !== entry.size) { rmSync(out, { force: true }); throw new ArchiveError(422, 'BAD_ARCHIVE', 'That file could not be extracted from the archive.'); }
      track(out, entry.size);
      return out;
    })().finally(() => extracting.delete(jobKey));
    extracting.set(jobKey, job);
    return job;
  }

  /** Range-aware read of one entry. */
  async function openEntry(ref, index, { range, signal }) {
    const { kind, entries } = await ready(ref);
    const entry = entries[Number(index)];
    if (!entry) throw new ArchiveError(404, 'NOT_FOUND', 'That file is not in the archive.');
    if (entry.dir) throw new ArchiveError(400, 'IS_FOLDER', 'That is a folder.');
    if (entry.encrypted) throw new ArchiveError(409, 'PASSWORD_PROTECTED', 'This file is password-protected inside the archive. Password-protected archives are not supported yet.');
    if (!entry.supported) throw new ArchiveError(415, 'UNSUPPORTED_METHOD', `This file uses a compression method (${entry.method}) that cannot be read in the browser. Download the whole archive instead.`);
    const r = entry.size === 0 ? { start: 0, end: -1, partial: false } : parseRange(range, entry.size);
    if (r.unsatisfiable) return { status: 416, headers: { 'content-range': `bytes */${entry.size}` }, body: null, entry };
    const headers = { 'content-length': String(r.end - r.start + 1), ...(r.partial ? { 'content-range': `bytes ${r.start}-${r.end}/${entry.size}` } : {}) };
    let body;
    if (entry.size === 0) body = (async function* () {})();
    else if (kind === 'zip') body = await zipEntryBody(readerFor(ref), entry, r.start, r.end, signal);
    else {
      const file = await extractRar(ref, entry);
      const c = touch(file);
      if (c) c.busy += 1;
      const stream = createReadStream(file, { start: r.start, end: r.end });
      stream.on('close', () => { if (c) c.busy -= 1; });
      body = stream;
    }
    return { status: r.partial ? 206 : 200, headers, body, entry };
  }

  return {
    list,
    openEntry,
    publicEntry: e => ({ index: e.index, path: e.path, dir: e.dir, size: e.size, packed: e.packed, encrypted: e.encrypted, supported: e.supported, method: e.method, date: e.date }),
    stats: () => ({ files: cache.size, bytes: cacheBytes(), limit: config.archiveCacheBytes }),
    clear() { for (const p of cache.keys()) rmSync(p, { recursive: true, force: true }); cache.clear(); listings.clear(); },
    _dirs: () => readdirSync(config.archiveCacheDir),
  };
}

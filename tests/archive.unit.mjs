// Unit checks for server/archive.js against real ZIP/ZIP64/RAR3/RAR5 fixtures. Run: node tests/archive.unit.mjs
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { createArchiveService, parseRange } from '../server/archive.js';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const F = fileURLToPath(new URL('./fixtures', import.meta.url));
const CACHE = join(tmpdir(), `kurovault-archive-unit-${process.pid}`);
let reads = 0, bytesRead = 0;
const source = { async *read(ref, start, end) { reads++; const b = readFileSync(ref.path); for (let p = start; p <= end; p += 65536) { const c = b.subarray(p, Math.min(end + 1, p + 65536)); bytesRead += c.length; yield c; } } };
const svc = createArchiveService({ config: { archiveCacheDir: CACHE, archiveCacheBytes: 50 * 1048576, archiveMaxBytes: 20 * 1048576 }, source });
const ref = name => { const path = `${F}/${name}`; return { path, key: name, size: readFileSync(path).length }; };
const body = async r => { const parts = []; for await (const c of r.body) parts.push(c); return Buffer.concat(parts); };
const wait = async r => { let x = await svc.list(r); while (x.pending) { await new Promise(s => setTimeout(s, 20)); x = await svc.list(r); } return x; };

// ZIP
const z = ref('season.zip');
bytesRead = 0;
const zl = await wait(z);
console.log('zip', zl.kind, zl.entries.map(e => `${e.path}${e.dir ? '/' : ''}:${e.method}`).join(', '), 'bytesRead for listing', bytesRead);
const files = { 'Season 1/Episode 01.webm': 'clip.webm', 'Season 1/Episode 02.mp4': 'briefing.mp4', 'Music/Night Watch.mp3': 'song.mp3', 'Docs/briefing.pdf': 'report.pdf', 'Photos/harbor.jpg': 'photo.jpg' };
for (const e of zl.entries.filter(e => !e.dir)) {
  const want = files[e.path] ? readFileSync(`${F}/${files[e.path]}`) : Buffer.from('Ravenhold archive test.\n'.repeat(200));
  assert.ok((await body(await svc.openEntry(z, e.index, {}))).equals(want), e.path);
  for (const [a, b] of [[0, 0], [100, 4099], [want.length - 50, want.length - 1], [7, 70000]]) {
    if (b >= want.length) continue;
    const r = await svc.openEntry(z, e.index, { range: `bytes=${a}-${b}` });
    assert.equal(r.status, 206); assert.equal(r.headers['content-range'], `bytes ${a}-${b}/${want.length}`);
    assert.ok((await body(r)).equals(want.subarray(a, b + 1)), `${e.path} ${a}-${b}`);
  }
}
bytesRead = 0;
await body(await svc.openEntry(z, zl.entries.find(e => e.path.endsWith('Episode 01.webm')).index, { range: 'bytes=300000-300099' }));
console.log('stored seek bytes fetched:', bytesRead, '(entry is 378 KB)');
assert.equal((await svc.openEntry(z, 1, { range: 'bytes=999999999-' })).status, 416);
const z64 = ref('zip64.zip'); const l64 = await wait(z64);
console.log('zip64', l64.entries.map(e => `${e.path}:${e.size}`));
assert.ok((await body(await svc.openEntry(z64, l64.entries.find(e => e.path.endsWith('.mp3')).index, {}))).equals(readFileSync(`${F}/song.mp3`)));

// RAR
const r1 = ref('collection.rar');
const first = await svc.list(r1); console.log('rar first call pending?', Boolean(first.pending));
const rl = await wait(r1);
console.log('rar', rl.entries.map(e => `${e.path}${e.dir ? '/' : ''}`).join(', '));
const harbor = rl.entries.find(e => e.path === 'Movies/Harbor.webm');
assert.ok((await body(await svc.openEntry(r1, harbor.index, {}))).equals(readFileSync(`${F}/clip.webm`)));
const rr = await svc.openEntry(r1, harbor.index, { range: 'bytes=1000-1999' });
assert.ok((await body(rr)).equals(readFileSync(`${F}/clip.webm`).subarray(1000, 2000)));
const solid = ref('rar-samples/rar3-solid.rar'); const sl = await wait(solid);
const s2 = await body(await svc.openEntry(solid, 1, {}));
console.log('rar3 solid compressed entry 2:', sl.entries[1].path, s2.length, JSON.stringify(s2.subarray(0, 30).toString()));
const sub = await wait(ref('rar-samples/rar5-subdirs.rar')); console.log('unicode paths', sub.entries.map(e => e.path).filter(p => /ü/.test(p)));
const psw = ref('rar-samples/rar5-psw.rar'); const pl = await wait(psw);
try { await svc.openEntry(psw, 0, {}); console.log('NO ERROR?!'); } catch (e) { console.log('encrypted ->', e.code); }
svc.clear();
rmSync(CACHE, { recursive: true, force: true });
console.log('ALL OK');

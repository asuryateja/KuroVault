// Controlled stand-in for the Streamtape API (tests only). Mirrors the request/response
// shapes Kurovault relies on: account/info, file/listfolder, file/dlticket, file/dl, and a
// tiny CDN that serves a real media fixture with HTTP Range support. Credentials are test-only.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = Number(process.env.FAKE_ST_PORT ?? 18595);
const LOGIN = process.env.FAKE_ST_LOGIN ?? 'test-st-login';
const KEY = process.env.FAKE_ST_KEY ?? 'test-st-key';
const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const CLIP = readFileSync(join(FIX, 'clip.webm'));

const FILES = {
  a1b2c3: { name: 'Lecture 01.mp4', size: CLIP.length, convert: true },
  d4e5f6: { name: 'Lecture 02.mp4', size: CLIP.length, convert: true },
  pending1: { name: 'Still processing.mp4', size: 0, convert: false },
};
const FOLDERS = [{ id: 'f100', name: 'Course notes' }];

const ok = result => JSON.stringify({ status: 200, msg: 'OK', result });
const bad = (status, msg) => JSON.stringify({ status, msg, result: false });

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  const auth = url.searchParams.get('login') === LOGIN && url.searchParams.get('key') === KEY;

  if (p === '/cdn/clip.webm') {
    const range = req.headers.range;
    const m = range && /bytes=(\d*)-(\d*)/.exec(range);
    if (m) {
      const start = m[1] ? Number(m[1]) : 0;
      const end = m[2] ? Number(m[2]) : CLIP.length - 1;
      res.writeHead(206, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${CLIP.length}`, 'Content-Length': end - start + 1 });
      res.end(CLIP.subarray(start, end + 1));
    } else {
      res.writeHead(200, { 'Content-Type': 'video/webm', 'Accept-Ranges': 'bytes', 'Content-Length': CLIP.length });
      res.end(CLIP);
    }
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  if (!auth) { res.writeHead(403); res.end(bad(403, 'Wrong auth')); return; }

  if (p === '/account/info') { res.end(ok({ email: 'me@example.com', plan: 'free' })); return; }
  if (p === '/file/listfolder') {
    const folder = url.searchParams.get('folder');
    res.end(ok({
      folders: folder ? [] : FOLDERS,
      files: Object.entries(FILES).map(([linkid, f]) => ({ linkid, name: f.name, size: f.size, convert: f.convert })),
    }));
    return;
  }
  if (p === '/file/dlticket') {
    const file = url.searchParams.get('file');
    if (!FILES[file]) { res.end(bad(404, 'Not found')); return; }
    res.end(ok({ ticket: `ticket-${file}`, wait_time: 0, valid_until: Date.now() + 60000 }));
    return;
  }
  if (p === '/file/dl') {
    const file = url.searchParams.get('file');
    const ticket = url.searchParams.get('ticket');
    if (!FILES[file] || ticket !== `ticket-${file}`) { res.end(bad(403, 'Bad ticket')); return; }
    res.end(ok({ url: `http://127.0.0.1:${PORT}/cdn/clip.webm`, name: FILES[file].name }));
    return;
  }
  if (p === '/health') { res.end(ok({ ok: true })); return; }
  res.writeHead(404); res.end(bad(404, 'No such endpoint'));
});

server.listen(PORT, '127.0.0.1', () => console.log(`fake-streamtape on ${PORT}`));

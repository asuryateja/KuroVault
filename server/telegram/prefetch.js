// Smooth playback: download a Telegram video to this server first, then stream it from local disk.
//
// While the download runs, playback can safely start as soon as the rest of the file is certain to
// arrive before the player reaches it:   downloaded ≥ (bitrate − downloadRate) × duration  (+ margin).
// Requests for bytes that are already on disk are served from the file; anything beyond falls back to
// live streaming from Telegram, so nothing ever waits on the cache.
import { createReadStream, mkdirSync, rmSync } from 'node:fs';
import { open as openFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const MIN_START_SECONDS = 12;   // always have at least this much video ready before "ready"
const SAFETY = 1.2;             // assume the video needs 20% more bandwidth than its average bitrate

export function createPrefetcher({ dir, maxBytes, perUser = 1, maxActive = 4, log = () => undefined }) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const jobs = new Map(); // key -> job

  const usedBytes = () => [...jobs.values()].reduce((n, j) => n + j.size, 0);
  const active = () => [...jobs.values()].filter(j => j.state === 'downloading');

  function drop(job, reason) {
    job.ac?.abort();
    if (job.readers > 0) { job.dropAfterRead = true; return; }
    jobs.delete(job.key);
    rmSync(job.path, { force: true });
    log({ key: job.key, reason }, 'prefetch dropped');
  }

  function makeRoom(needed) {
    if (needed > maxBytes) return false;
    const victims = [...jobs.values()].filter(j => j.state !== 'downloading' && j.readers === 0).sort((a, b) => a.lastUsed - b.lastUsed);
    while (usedBytes() + needed > maxBytes && victims.length) drop(victims.shift(), 'evicted');
    return usedBytes() + needed <= maxBytes;
  }

  function readiness(job) {
    if (job.state === 'ready') return { ready: true, needBytes: job.size };
    const duration = Number(job.duration) || 0;
    if (!duration) return { ready: false, needBytes: job.size };       // unknown length: wait for the whole file
    const bitrate = (job.size / duration) * SAFETY;                    // bytes per second of playback
    const rate = job.rate;                                             // bytes per second from Telegram
    const minStart = Math.min(job.size, bitrate * MIN_START_SECONDS);
    // If downloading is faster than playback, only the short start buffer is needed.
    const deficit = Math.max(0, (bitrate - rate) * duration);
    const needBytes = Math.min(job.size, Math.max(minStart, deficit));
    const warm = Date.now() - job.startedAt > 2500;                    // let the speed estimate settle first
    return { ready: warm && job.received >= needBytes, needBytes };
  }

  function status(job) {
    if (!job) return { state: 'none' };
    const r = readiness(job);
    const left = job.size - job.received;
    return {
      state: job.state, error: job.error ?? null,
      received: job.received, size: job.size, percent: job.size ? Math.floor((job.received / job.size) * 1000) / 10 : 0,
      rate: Math.round(job.rate), etaSeconds: job.state === 'ready' ? 0 : job.rate > 0 ? Math.ceil(left / job.rate) : null,
      readyToPlay: r.ready, readyAtPercent: job.size ? Math.min(100, Math.ceil((r.needBytes / job.size) * 1000) / 10) : 100,
      readyInSeconds: r.ready ? 0 : job.rate > 0 ? Math.max(0, Math.ceil((r.needBytes - job.received) / job.rate)) : null,
      duration: job.duration ?? null,
    };
  }

  /**
   * @param key     unique per user + file + quality
   * @param meta    { owner, size, duration, mime, name, open: (signal) => AsyncIterable<Buffer> of the whole file }
   */
  function start(key, meta) {
    const existing = jobs.get(key);
    if (existing && existing.state !== 'error') { existing.lastUsed = Date.now(); return status(existing); }
    if (existing) drop(existing, 'retry');
    // One preparation per person at a time (the newest wins), and a cap for the whole server.
    const mine = active().filter(j => j.owner === meta.owner).sort((a, b) => a.startedAt - b.startedAt);
    while (mine.length >= perUser) drop(mine.shift(), 'replaced');
    if (active().length >= maxActive) return { state: 'error', error: 'The server is preparing several videos already. Try again in a minute, or play now.' };
    if (!makeRoom(meta.size)) return { state: 'error', error: `This video (${Math.round(meta.size / 1048576)} MB) is larger than the server's preparation space (${Math.round(maxBytes / 1048576)} MB, TDC_VIDEO_CACHE_MB). Play it directly instead.` };
    const job = {
      key, owner: meta.owner, size: meta.size, duration: meta.duration, mime: meta.mime, name: meta.name,
      path: join(dir, `${createHash('sha256').update(key).digest('hex').slice(0, 32)}.bin`),
      received: 0, rate: 0, state: 'downloading', error: null, startedAt: Date.now(), lastUsed: Date.now(), readers: 0, ac: new AbortController(),
    };
    jobs.set(key, job);
    void (async () => {
      let fh;
      try {
        fh = await openFile(job.path, 'w', 0o600);
        let windowStart = Date.now();
        let windowBytes = 0;
        for await (const chunk of meta.open(job.ac.signal)) {
          if (job.ac.signal.aborted) return;
          await fh.write(chunk, 0, chunk.length, job.received);
          job.received += chunk.length;
          windowBytes += chunk.length;
          const now = Date.now();
          if (now - windowStart >= 700) {
            const sample = (windowBytes * 1000) / (now - windowStart);
            job.rate = job.rate ? job.rate * 0.6 + sample * 0.4 : sample;  // smoothed download speed
            windowStart = now;
            windowBytes = 0;
          }
        }
        if (!job.rate) job.rate = (job.received * 1000) / Math.max(1, Date.now() - job.startedAt);
        if (job.received !== job.size) throw new Error(`Telegram sent ${job.received} of ${job.size} bytes`);
        job.state = 'ready';
      } catch (e) {
        if (job.ac.signal.aborted) return;
        job.state = 'error';
        job.error = 'Preparation stopped: ' + String(e?.message ?? e).slice(0, 160);
        log({ key, msg: job.error }, 'prefetch failed');
      } finally {
        await fh?.close().catch(() => undefined);
      }
    })();
    return status(job);
  }

  return {
    start,
    status: key => status(jobs.get(key)),
    cancel(key) { const j = jobs.get(key); if (j) drop(j, 'cancelled'); },
    /** If [start, end] begins inside the downloaded part, returns a disk stream for as much of it as is there. */
    read(key, start, end) {
      const job = jobs.get(key);
      if (!job || start >= job.received) return null;
      const stop = Math.min(end, job.received - 1);
      job.lastUsed = Date.now();
      job.readers += 1;
      const stream = createReadStream(job.path, { start, end: stop });
      stream.on('close', () => { job.readers -= 1; if (job.dropAfterRead && job.readers === 0) drop(job, 'deferred'); });
      return { stream, start, end: stop, size: job.size, mime: job.mime, name: job.name };
    },
    job: key => jobs.get(key) ?? null,
    stats: () => ({ files: jobs.size, bytes: usedBytes(), active: active().length, limit: maxBytes }),
    close() { for (const j of jobs.values()) j.ac?.abort(); },
  };
}

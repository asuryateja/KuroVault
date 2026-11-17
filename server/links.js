// Playing a public, directly-hosted media URL in the viewer.
//
// This is a generic "play a direct media link" proxy — the same thing a browser does with
// <video src>. It is deliberately NOT a site scraper: it does not defeat ad-gates, sign-in
// walls or app-walls, and it only serves responses that are themselves audio/video/image/pdf.
//
// Because the server fetches a user-supplied URL, it is guarded against SSRF: every hop
// (including redirects) must resolve to a public address, never loopback, private, link-local
// or carrier-NAT ranges, and never anything but http(s).
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { classifyIp } from './security/ip.js';

export class LinkError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const ALLOWED_SCHEMES = new Set(['http:', 'https:']);
const UA = 'Mozilla/5.0 (compatible; Kurovault/1.0; +https://kurovault.app)';

// Media types we are willing to serve inline. Anything else (html, svg, scripts, unknown) is refused.
const MEDIA_EXT = {
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', mkv: 'video/x-matroska',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', weba: 'audio/webm',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  pdf: 'application/pdf',
};
export const MEDIA_MIME = new Set([...Object.values(MEDIA_EXT), 'video/ogg', 'audio/webm', 'audio/x-m4a', 'audio/x-wav', 'audio/x-flac']);

/** The media type to serve: the host's content-type if it is media, otherwise a guess from the URL extension. */
export function resolveMediaType(contentType, url) {
  const declared = String(contentType ?? '').toLowerCase().split(';')[0].trim();
  if (MEDIA_MIME.has(declared)) return declared;
  let path = '';
  try { path = new URL(url).pathname; } catch { /* keep empty */ }
  const ext = path.toLowerCase().split('.').pop();
  return MEDIA_EXT[ext] ?? null;
}

export function parseLinkUrl(raw) {
  let url;
  try { url = new URL(String(raw).trim()); } catch { throw new LinkError('BAD_URL', 400, 'Enter a valid http:// or https:// link.'); }
  if (!ALLOWED_SCHEMES.has(url.protocol)) throw new LinkError('BAD_SCHEME', 400, 'Only http and https links are supported.');
  if (url.username || url.password) throw new LinkError('BAD_URL', 400, 'Links with a username or password in them are not allowed.');
  return url;
}

function bareHost(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

/** Throws unless every address the host resolves to is a public, routable IP. */
async function assertPublicHost(hostname, allowLocal) {
  if (allowLocal) return;
  const host = bareHost(hostname);
  let addresses;
  if (isIP(host)) addresses = [host];
  else {
    try { addresses = (await lookup(host, { all: true })).map(a => a.address); }
    catch { throw new LinkError('UNRESOLVABLE', 400, 'That address could not be looked up.'); }
  }
  if (!addresses.length) throw new LinkError('UNRESOLVABLE', 400, 'That address could not be looked up.');
  for (const address of addresses) {
    if (classifyIp(address).scope !== 'public') throw new LinkError('BLOCKED_HOST', 400, 'That link points to a private or local address, which is not allowed.');
  }
}

/**
 * Fetch a URL, following redirects by hand so every hop is re-checked against the SSRF guard
 * (an open redirect to localhost must not slip through). Returns the final response and URL.
 */
export async function fetchChecked(rawUrl, { method = 'GET', range, signal, allowLocal = false, maxRedirects = 4, connectTimeoutMs = 15000 } = {}) {
  let url = parseLinkUrl(rawUrl);
  // One controller spans the whole request so the caller's disconnect aborts the live stream too.
  // A per-hop timer guards only the time to get response headers — it is cleared before the body
  // is streamed, so a long download is never cut off by the connect timeout.
  const ac = new AbortController();
  if (signal) {
    if (signal.aborted) ac.abort();
    else signal.addEventListener('abort', () => ac.abort(), { once: true });
  }
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    await assertPublicHost(url.hostname, allowLocal);
    const headers = { 'User-Agent': UA, Accept: '*/*' };
    if (range) headers.Range = range;
    const timer = setTimeout(() => ac.abort(new LinkError('TIMEOUT', 504, 'The source took too long to respond.')), connectTimeoutMs);
    let res;
    try { res = await fetch(url, { method, headers, redirect: 'manual', signal: ac.signal }); }
    catch (error) {
      if (ac.signal.reason instanceof LinkError) throw ac.signal.reason;
      if (error?.name === 'AbortError') throw error;
      throw new LinkError('LINK_UNREACHABLE', 502, 'That link could not be reached.');
    } finally { clearTimeout(timer); }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      let next;
      try { next = new URL(res.headers.get('location'), url); } catch { throw new LinkError('BAD_REDIRECT', 502, 'The source sent an invalid redirect.'); }
      try { await res.body?.cancel?.(); } catch { /* already drained */ }
      url = parseLinkUrl(next.href);
      continue;
    }
    return { res, finalUrl: url };
  }
  throw new LinkError('TOO_MANY_REDIRECTS', 502, 'That link redirects too many times.');
}

/** Confirm a URL is a direct media file, and report its type and size. */
export async function probeLink(rawUrl, { allowLocal = false } = {}) {
  const { res, finalUrl } = await fetchChecked(rawUrl, { range: 'bytes=0-1', allowLocal });
  try { await res.body?.cancel?.(); } catch { /* already drained */ }
  if (res.status >= 400) throw new LinkError('LINK_UNREACHABLE', 502, `The source returned ${res.status}.`);
  const mime = resolveMediaType(res.headers.get('content-type'), finalUrl.href);
  if (!mime) throw new LinkError('NOT_MEDIA', 415, 'That link is not a direct audio, video, image or PDF file. Paste a link that ends in the file itself (for example an .mp4).');
  let size = 0;
  const range = res.headers.get('content-range');
  const m = range && /\/(\d+)\s*$/.exec(range);
  if (m) size = Number(m[1]);
  else { const len = res.headers.get('content-length'); if (len && /^\d+$/.test(len)) size = Number(len); }
  return { mime, size };
}

export const linkKind = mime => (mime.startsWith('video') ? 'video' : mime.startsWith('audio') ? 'audio' : mime.startsWith('image') ? 'image' : mime === 'application/pdf' ? 'pdf' : 'file');

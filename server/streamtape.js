// Streamtape integration — strictly the account owner's own files, through Streamtape's own API.
//
// This uses the documented API (https://streamtape.com/api) with the user's own API login + key.
// It lists and plays files that are in THAT account. It never accepts an arbitrary pasted
// streamtape.com/v/… link and never scrapes an embed page: the only playable files are the ones
// the connected account itself returns from listfolder. Credentials are sealed on the server.
import { fetchChecked } from './links.js';

export class StreamtapeError extends Error {
  constructor(code, status, message) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const DEFAULT_BASE = 'https://api.streamtape.com';

function creds(login, key) {
  const l = encodeURIComponent(String(login));
  const k = encodeURIComponent(String(key));
  return `login=${l}&key=${k}`;
}

async function call(base, path, { login, key }, extra = '', { signal } = {}) {
  let res;
  try {
    res = await fetch(`${base}${path}?${creds(login, key)}${extra}`, { headers: { Accept: 'application/json' }, signal });
  } catch { throw new StreamtapeError('STREAMTAPE_UNREACHABLE', 502, 'Could not reach Streamtape.'); }
  let json;
  try { json = await res.json(); } catch { throw new StreamtapeError('STREAMTAPE_BAD_RESPONSE', 502, 'Streamtape returned an unexpected response.'); }
  // Streamtape wraps everything as { status, msg, result }. 401/403 mean the login/key is wrong.
  if (json.status === 401 || json.status === 403 || res.status === 401 || res.status === 403) {
    throw new StreamtapeError('STREAMTAPE_AUTH', 401, 'Streamtape rejected that API login and key.');
  }
  if (json.status !== 200 || json.result === undefined) {
    throw new StreamtapeError('STREAMTAPE_ERROR', 502, `Streamtape error: ${String(json.msg || 'unknown').slice(0, 120)}`);
  }
  return json.result;
}

export function createStreamtape(config) {
  const base = (config.streamtapeBase || DEFAULT_BASE).replace(/\/$/, '');
  const allowLocal = Boolean(config.allowLocalLinks);
  return {
    /** Verify credentials and return the account summary. */
    async account(c, opts) {
      const r = await call(base, '/account/info', c, '', opts);
      return { email: r.email ?? null, plan: r.plan ?? null, signupAt: r.signup_at ?? null };
    },

    /** One folder of the account: its sub-folders and its files. */
    async listFolder(c, folder, opts) {
      const r = await call(base, '/file/listfolder', c, folder ? `&folder=${encodeURIComponent(folder)}` : '', opts);
      const folders = (r.folders ?? []).map(f => ({ id: String(f.id), name: String(f.name ?? 'Folder') }));
      const files = (r.files ?? []).map(f => ({
        linkid: String(f.linkid ?? f.id ?? ''),
        name: String(f.name ?? 'Untitled'),
        size: Number(f.size ?? 0) || 0,
        // convert === true (or 'converted') means it is ready to stream.
        converted: f.convert === true || f.convert === 'converted' || f.converted === true || f.convert === undefined,
      })).filter(f => f.linkid);
      return { folders, files };
    },

    /**
     * Resolve the time-limited direct URL for ONE file in the account, via the documented
     * dlticket → dl flow. The caller must already have confirmed the linkid belongs to the user.
     */
    async directUrl(c, linkid, opts) {
      const ticket = await call(base, '/file/dlticket', c, `&file=${encodeURIComponent(linkid)}`, opts);
      if (!ticket.ticket) throw new StreamtapeError('STREAMTAPE_ERROR', 502, 'Streamtape did not issue a download ticket.');
      const wait = Math.min(Math.max(0, Number(ticket.wait_time) || 0), 20);
      if (wait) await new Promise(r => setTimeout(r, wait * 1000));
      const dl = await call(base, '/file/dl', c, `&file=${encodeURIComponent(linkid)}&ticket=${encodeURIComponent(ticket.ticket)}`, opts);
      if (!dl.url) throw new StreamtapeError('STREAMTAPE_ERROR', 502, 'Streamtape did not return a playable URL.');
      return String(dl.url);
    },

    /** Fetch the resolved direct URL (SSRF-guarded, range-aware) so the server can stream it. */
    fetchStream(url, { range, signal }) {
      return fetchChecked(url, { range, signal, allowLocal });
    },
  };
}

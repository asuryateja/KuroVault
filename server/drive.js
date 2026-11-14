// Client for the Telegram Drive desktop app's local REST API.
// The API key never leaves the server: it is kept sealed in the database (or env)
// and attached here; browsers only ever talk to this console.
import { getSetting, setSetting } from './db.js';

const TIMEOUT_MS = 15_000;

export function createDrive({ config, db, vault }) {
  function baseUrl() {
    return (getSetting(db, 'drive_api_url') ?? config.driveApiUrl).replace(/\/+$/, '');
  }

  function apiKey() {
    const sealed = getSetting(db, 'drive_api_key');
    if (sealed) {
      try { return vault.open(sealed, 'drive_api_key'); } catch { return ''; }
    }
    return config.driveApiKey;
  }

  function configure({ url, key }) {
    if (url !== undefined) {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Only http(s) URLs are allowed');
      if (parsed.username || parsed.password) throw new Error('Credentials in the URL are not allowed');
      setSetting(db, 'drive_api_url', parsed.toString().replace(/\/+$/, ''));
    }
    if (key !== undefined) setSetting(db, 'drive_api_key', key ? vault.seal(key, 'drive_api_key') : null);
  }

  async function call(path, { method = 'GET', query, body, headers = {}, raw = false, timeout = TIMEOUT_MS } = {}) {
    const url = new URL(baseUrl() + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const key = apiKey();
    const init = {
      method,
      headers: { Accept: 'application/json', ...(key ? { 'X-API-Key': key } : {}), ...headers },
      body,
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    };
    if (body && !(body instanceof FormData) && typeof body !== 'string') {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, init);
    if (raw) return response;
    const text = await response.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { message: text.slice(0, 200) }; }
    if (!response.ok) {
      const error = new Error(data?.error?.message ?? data?.message ?? `Drive API returned ${response.status}`);
      error.status = response.status;
      error.code = data?.error?.code ?? data?.code;
      throw error;
    }
    return data;
  }

  /**
   * Opens a long-lived upstream stream (media, downloads, archives). Only the wait for
   * response headers is time-limited; the body can flow for as long as the viewer keeps
   * watching. `signal` lets the caller abort upstream when the browser disconnects.
   */
  async function stream(path, { method = 'GET', query, headers = {}, body, signal, headerTimeoutMs = 30_000 } = {}) {
    const url = new URL(baseUrl() + path);
    for (const [k, v] of Object.entries(query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    const key = apiKey();
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('Upstream did not respond in time', 'TimeoutError')), headerTimeoutMs);
    try {
      const init = { method, headers: { ...(key ? { 'X-API-Key': key } : {}), ...headers }, redirect: 'error', signal: controller.signal, body };
      if (body && typeof body.getReader === 'function') init.duplex = 'half';
      const response = await fetch(url, init);
      return { response, abort: () => controller.abort() };
    } finally {
      clearTimeout(timer);
    }
  }

  async function health() {
    const started = Date.now();
    try {
      const data = await call('/health', { timeout: 4000 });
      let authorized = false;
      const keyConfigured = Boolean(apiKey());
      if (keyConfigured) {
        try {
          await call('/folders', { timeout: 6000 });
          authorized = true;
        } catch (error) {
          authorized = false;
          if (error.status && error.status !== 401 && error.status !== 403) authorized = true;
        }
      }
      return { ok: true, version: data?.version, ms: Date.now() - started, authorized, keyConfigured };
    } catch (error) {
      return { ok: false, error: error.name === 'TimeoutError' ? 'timed out' : (error.cause?.code ?? error.message), ms: Date.now() - started, keyConfigured: Boolean(apiKey()) };
    }
  }

  return { baseUrl, apiKey, configure, call, stream, health, keyConfigured: () => Boolean(apiKey()) };
}

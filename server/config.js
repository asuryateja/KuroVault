// Runtime configuration. Everything security-relevant has a safe default:
// loopback bind, secure cookies whenever TLS is in front, no proxy trust.
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function int(name, fallback, min, max) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

export function loadConfig(overrides = {}) {
  const dataDir = resolve(overrides.dataDir ?? process.env.TDC_DATA_DIR ?? join(ROOT, 'data'));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  try { chmodSync(dataDir, 0o700); } catch { /* non-POSIX filesystems */ }

  const tlsCert = overrides.tlsCert ?? process.env.TDC_TLS_CERT ?? '';
  const tlsKey = overrides.tlsKey ?? process.env.TDC_TLS_KEY ?? '';
  const tls = Boolean(tlsCert && tlsKey);

  // Known hosts: every request reaches the app through their HTTPS edge proxy, which also tells us the
  // visitor's real address. Detected automatically so the IP is right even if no variable was set.
  const platform = process.env.RENDER === 'true' ? 'render'
    : process.env.FLY_APP_NAME ? 'fly'
      : (process.env.RAILWAY_PROJECT_ID || process.env.RAILWAY_ENVIRONMENT_NAME) ? 'railway' : null;
  const PLATFORM_IP_HEADER = { render: 'true-client-ip', fly: 'fly-client-ip', railway: null };

  const config = {
    root: ROOT,
    platform,
    dataDir,
    clientDir: join(ROOT, 'client', 'dist'),
    host: overrides.host ?? process.env.TDC_HOST ?? '127.0.0.1',
    // Railway, Render and Fly provide PORT; TDC_PORT wins when both are set.
    port: overrides.port ?? (process.env.TDC_PORT ? int('TDC_PORT', 8640, 0, 65535) : int('PORT', 8640, 0, 65535)),
    tls,
    tlsCert,
    tlsKey,
    // Number of proxy hops in front of this server (Railway/Render/Fly = 1). Only the
    // address added by your own proxy is trusted, so visitors cannot spoof X-Forwarded-For.
    trustProxy: overrides.trustProxy ?? proxyHops(process.env.TDC_TRUST_PROXY ?? (platform ? '1' : undefined)),
    // A header set by the platform's edge proxy that holds the visitor's address (fly-client-ip on Fly.io,
    // cf-connecting-ip behind Cloudflare). Only set this when every request reaches the app through that proxy.
    clientIpHeader: overrides.clientIpHeader ?? (/^[a-z0-9-]{1,40}$/i.test(process.env.TDC_CLIENT_IP_HEADER ?? '') ? process.env.TDC_CLIENT_IP_HEADER.toLowerCase() : (platform ? PLATFORM_IP_HEADER[platform] : null)),
    cookieSecure: overrides.cookieSecure ?? (tls || bool('TDC_COOKIE_SECURE', Boolean(platform))),
    // Sign-ins last while used; a browser unused for this many days must sign in again.
    sessionDays: int('TDC_SESSION_DAYS', 30, 1, 365),
    // The administrator signs in as "admin". This password creates that account on first start.
    adminPassword: overrides.adminPassword ?? process.env.TDC_ADMIN_PASSWORD ?? '',
    allowRegistration: overrides.allowRegistration ?? bool('TDC_ALLOW_REGISTRATION', true),
    // Optional: new accounts need this code (share it only with people you invite).
    inviteCode: overrides.inviteCode ?? (process.env.TDC_INVITE_CODE ?? '').trim(),
    // Ceilings that stop strangers from mass-creating accounts.
    maxUsers: int('TDC_MAX_USERS', 200, 1, 100000),
    signupsPerIpPerDay: int('TDC_SIGNUPS_PER_IP_PER_DAY', 3, 1, 1000),
    // External media links: paste a direct audio/video URL to play it in the viewer.
    maxLinks: int('TDC_MAX_LINKS', 200, 1, 100000),
    // Test-only: allow links that point at localhost/private addresses (used by the test fixtures).
    allowLocalLinks: process.env.TDC_ALLOW_LOCAL_LINKS === '1',
    // Streamtape API base; overridable so tests can point at a fake server.
    streamtapeBase: process.env.TDC_STREAMTAPE_BASE || 'https://api.streamtape.com',
    // Optional: one Telegram API ID/hash for everybody, so users sign in with just their phone number.
    telegramApiId: /^\d{3,12}$/.test(process.env.TDC_TELEGRAM_API_ID ?? '') ? process.env.TDC_TELEGRAM_API_ID : '',
    telegramApiHash: /^[0-9a-f]{32}$/i.test(process.env.TDC_TELEGRAM_API_HASH ?? '') ? process.env.TDC_TELEGRAM_API_HASH.toLowerCase() : '',
    // Telegram's per-file limit through the desktop API is 2,000,000,000 bytes.
    maxUploadBytes: Math.min(int('TDC_MAX_UPLOAD_MB', 1907, 1, 1907) * 1024 * 1024, 2_000_000_000),
    uploadChunkBytes: int('TDC_UPLOAD_CHUNK_MB', 16, 1, 90) * 1024 * 1024,
    retentionDays: int('TDC_RETENTION_DAYS', 30, 1, 3650),
    // Upload staging area. On cloud hosts point this at fast ephemeral disk (e.g. /tmp/kurovault-uploads).
    uploadDir: process.env.TDC_UPLOAD_DIR ? resolve(process.env.TDC_UPLOAD_DIR) : join(dataDir, 'uploads'),
    // Archives: ZIPs are read in place; RARs are fetched once into this cache and extracted on demand.
    archiveCacheDir: process.env.TDC_ARCHIVE_CACHE_DIR ? resolve(process.env.TDC_ARCHIVE_CACHE_DIR) : join(tmpdir(), 'kurovault-archives'),
    archiveCacheBytes: int('TDC_ARCHIVE_CACHE_MB', 6144, 64, 1_000_000) * 1024 * 1024,
    // Smooth playback: videos prepared on the server before playing (cleared on restart).
    videoCacheDir: process.env.TDC_VIDEO_CACHE_DIR ? resolve(process.env.TDC_VIDEO_CACHE_DIR) : join(tmpdir(), 'kurovault-media'),
    videoCacheBytes: int('TDC_VIDEO_CACHE_MB', 4096, 64, 1_000_000) * 1024 * 1024,
    archiveMaxBytes: int('TDC_ARCHIVE_MAX_MB', 4096, 1, 1_000_000) * 1024 * 1024,
    // Telegram direct mode. "fake" is a test double and is refused unless explicitly allowed.
    telegramAdapter: process.env.TDC_TELEGRAM_ADAPTER === 'fake' && process.env.TDC_ALLOW_FAKE_TELEGRAM === '1' ? 'fake' : 'gramjs',
    driveApiUrl: overrides.driveApiUrl ?? process.env.TDC_DRIVE_API_URL ?? 'http://127.0.0.1:8550/api/v1',
    driveApiKey: overrides.driveApiKey ?? process.env.TDC_DRIVE_API_KEY ?? '',
    limits: {
      globalPerMinute: int('TDC_RATE_GLOBAL_PER_MINUTE', 3000, 30, 100000),
      authPerMinute: int('TDC_RATE_AUTH_PER_MINUTE', 10, 2, 1000),
      accountFailuresBeforeLock: int('TDC_LOCK_AFTER_FAILURES', 5, 2, 50),
      ipFailuresBeforeBlock: int('TDC_BLOCK_AFTER_FAILURES', 20, 3, 1000),
    },
    ...overrides.extra,
  };
  config.secrets = loadSecrets(dataDir);
  return config;
}

/**
 * Which X-Forwarded-For entries to believe. A hop count (1 = one platform proxy, as on Railway, Render and Fly)
 * trusts exactly that many hops and no more, so a visitor cannot spoof their address by sending extra entries.
 * An address list (e.g. "loopback, 10.0.0.0/8") trusts only proxies at those addresses.
 */
function proxyHops(raw) {
  if (raw === undefined || raw === '' || /^(0|false|no|off)$/i.test(raw)) return false;
  let hops = 1;
  if (!/^(true|yes|on)$/i.test(raw)) {
    if (/[.:/]|[a-z]/i.test(raw)) return raw;
    hops = Number.parseInt(raw, 10);
    if (!Number.isInteger(hops) || hops < 1 || hops > 5) throw new Error('TDC_TRUST_PROXY must be the number of proxy hops (1-5), a list of proxy addresses, or false');
  }
  // Fastify treats a bare number as "trust nothing", so express the hop count as a function.
  const trust = (_addr, i) => i < hops;
  trust.hops = hops;
  return trust;
}

/**
 * Server-side keys, generated once and kept in a 0600 file inside the 0700 data directory.
 * With TDC_MASTER_KEY set (recommended on cloud hosts, stored as a platform secret), the file
 * is itself encrypted, so a copied disk or volume snapshot alone does not reveal the keys.
 */
function wrapKey(master, salt) {
  return scryptSync(master, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
}
function sealSecrets(json, master) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', wrapKey(master, salt), iv);
  const body = Buffer.concat([cipher.update(json, 'utf8'), cipher.final()]);
  return JSON.stringify({ sealed: 'v1', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), body: body.toString('base64') });
}
function openSecrets(text, master) {
  const parsed = JSON.parse(text);
  if (!parsed.sealed) return { json: parsed, wasSealed: false };
  if (!master) throw new Error('secrets.json is sealed: set TDC_MASTER_KEY to the value used when it was created.');
  try {
    const decipher = createDecipheriv('aes-256-gcm', wrapKey(master, Buffer.from(parsed.salt, 'base64')), Buffer.from(parsed.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    const json = Buffer.concat([decipher.update(Buffer.from(parsed.body, 'base64')), decipher.final()]).toString('utf8');
    return { json: JSON.parse(json), wasSealed: true };
  } catch {
    throw new Error('TDC_MASTER_KEY does not unlock secrets.json.');
  }
}

function loadSecrets(dataDir) {
  const file = join(dataDir, 'secrets.json');
  const master = process.env.TDC_MASTER_KEY || '';
  if (master && master.length < 24) throw new Error('TDC_MASTER_KEY must be at least 24 characters (use a long random value).');
  if (!existsSync(file)) {
    const secrets = JSON.stringify({ auditKey: randomBytes(32).toString('base64'), vaultKey: randomBytes(32).toString('base64'), createdAt: new Date().toISOString() });
    writeFileSync(file, master ? sealSecrets(secrets, master) : secrets, { mode: 0o600, flag: 'wx' });
  }
  try { chmodSync(file, 0o600); } catch { /* non-POSIX filesystems */ }
  const { json, wasSealed } = openSecrets(readFileSync(file, 'utf8'), master);
  // Adding TDC_MASTER_KEY later seals the existing plaintext file in place.
  if (master && !wasSealed) writeFileSync(file, sealSecrets(JSON.stringify(json), master), { mode: 0o600 });
  return {
    file,
    sealed: Boolean(master),
    auditKey: Buffer.from(json.auditKey, 'base64'),
    vaultKey: Buffer.from(json.vaultKey, 'base64'),
  };
}

export function fileMode(path) {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return null;
  }
}

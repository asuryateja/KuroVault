// Kurovault — HTTP application.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { Readable } from 'node:stream';
import { isIP } from 'node:net';
import { extname, join, relative, sep } from 'node:path';
import Fastify from 'fastify';
import QRCode from 'qrcode';

import { createChecks } from './checks.js';
import { getSetting, openDatabase, prune, setSetting } from './db.js';
import { createDrive } from './drive.js';
import { createAudit } from './security/audit.js';
import { applySecurityHeaders } from './security/headers.js';
import { classifyIp, describeAgent, normalizeIp } from './security/ip.js';
import { dummyVerify, hashPassword, passwordProblems, verifyPassword } from './security/passwords.js';
import { createBlocklist, lockMinutesForLevel, SlidingWindow } from './security/ratelimit.js';
import { cookieName, createSessionStore, parseCookies, serializeCookie } from './security/sessions.js';
import { createGeo } from './security/geo.js';
import { createVault, sha256 } from './security/vault.js';
import { createTelegramService, ensureTelegramTables, TgError } from './telegram/service.js';
import { ArchiveError, createArchiveService, parseRange } from './archive.js';
import { createPrefetcher } from './telegram/prefetch.js';

const VERSION = '1.0.0';
const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.woff': 'font/woff', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
  '.json': 'application/json', '.txt': 'text/plain; charset=utf-8', '.webmanifest': 'application/manifest+json',
};

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

/** Builds an immutable map of the built UI so only known files are ever served. */
function loadStaticFiles(dir) {
  const files = new Map();
  if (!existsSync(dir)) return files;
  const walk = current => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.set('/' + relative(dir, full).split(sep).join('/'), { body: readFileSync(full), type: MIME[extname(name)] ?? 'application/octet-stream' });
    }
  };
  walk(dir);
  return files;
}

export async function buildApp(config, { logger = false } = {}) {
  const startedAt = Date.now();
  const db = openDatabase(config.dataDir);
  const vault = createVault(config.secrets.vaultKey);
  const audit = createAudit(db, config.secrets.auditKey);
  const blocklist = createBlocklist(db);
  const sessions = createSessionStore(db, config);
  const drive = createDrive({ config, db, vault });
  // Telegram: one connection per Kurovault user, created on first use and reconnected automatically.
  ensureTelegramTables(db);
  const tgServices = new Map();
  const tgFor = uid => {
    let svc = tgServices.get(Number(uid));
    if (!svc) { svc = createTelegramService({ config, db, vault, audit, userId: Number(uid) }); tgServices.set(Number(uid), svc); }
    return svc;
  };
  // Earlier versions kept one Telegram login for the whole server: hand it to the admin (or the first account).
  {
    const legacy = getSetting(db, 'tg_session');
    const owner = db.prepare("SELECT id FROM users ORDER BY (lower(username) = 'admin') DESC, id LIMIT 1").get();
    if (legacy && owner) {
      const move = name => {
        const v = getSetting(db, name);
        if (v) { try { setSetting(db, `${name}:${owner.id}`, vault.seal(vault.open(v, name), `${name}:${owner.id}`)); } catch { /* unreadable: drop */ } }
        setSetting(db, name, null);
      };
      move('tg_session');
      move('tg_api');
      setSetting(db, `source_mode:${owner.id}`, getSetting(db, 'source_mode') === 'telegram' ? 'telegram' : null);
      setSetting(db, 'source_mode', null);
      try {
        db.prepare('INSERT OR IGNORE INTO tg_user_folders SELECT ?, peer, title, type, added_at FROM tg_folders').run(owner.id);
        db.prepare('INSERT OR IGNORE INTO tg_user_names SELECT ?, peer, msg_id, name FROM tg_names').run(owner.id);
      } catch { /* old tables absent */ }
      audit.record('telegram.migrated', { severity: 'medium', detail: { toUserId: owner.id } });
    }
  }
  const linkedTelegramAccounts = () => db.prepare("SELECT COUNT(*) AS n FROM settings WHERE key LIKE 'tg_session:%'").get().n;
  const staticFiles = loadStaticFiles(config.clientDir);

  const globalLimiter = new SlidingWindow(config.limits.globalPerMinute, 60_000);
  const authLimiter = new SlidingWindow(config.limits.authPerMinute, 60_000);
  const cookie = cookieName(config.cookieSecure);

  const userCount = () => db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  const adminExists = () => Boolean(db.prepare("SELECT 1 FROM users WHERE lower(username) = 'admin'").get());
  // The administrator always signs in as "admin". Its password is set when the server is deployed
  // (TDC_ADMIN_PASSWORD), so nobody visiting the site can claim the admin account.
  if (!adminExists() && config.adminPassword) {
    const problems = passwordProblems(config.adminPassword, 'admin');
    if (problems.length) throw new Error(`TDC_ADMIN_PASSWORD is too weak: ${problems.join(' ')}`);
    const now = Date.now();
    db.prepare("INSERT INTO users(username, display_name, role, pw_hash, created_at, password_changed_at) VALUES('admin', 'Administrator', 'admin', ?, ?, ?)")
      .run(await hashPassword(config.adminPassword), now, now);
    audit.record('setup.admin_created', { severity: 'high', actor: 'admin', detail: { source: 'TDC_ADMIN_PASSWORD' } });
  }
  const geo = createGeo();
  void geo.preload();

  const checks = createChecks({ config, db, audit, drive, linkedTelegramAccounts, blocklist, sessions, startedAt });

  const app = Fastify({
    logger,
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
    requestIdHeader: false,
    genReqId: () => randomBytes(8).toString('hex'),
    return503OnClosing: true,
    // A single request (one upload chunk) may take up to 5 minutes on a slow link; response
    // streams (video, downloads) are not limited. Slow-header attacks are still cut at 60 s.
    requestTimeout: 300_000,
    ...(config.tls ? { https: { cert: readFileSync(config.tlsCert), key: readFileSync(config.tlsKey), minVersion: 'TLSv1.2' } } : {}),
  });

  app.decorate('ctx', { db, audit, sessions, blocklist, drive, config });
  // Upload chunks arrive as raw streams and are written straight to disk (never buffered whole).
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload));
  const uploadDir = config.uploadDir;
  mkdirSync(uploadDir, { recursive: true, mode: 0o700 });

  const housekeeping = setInterval(() => {
    globalLimiter.sweep();
    authLimiter.sweep();
    const now = Date.now();
    try { prune(db, config.retentionDays); } catch { /* best effort */ }
    try {
      for (const row of db.prepare('SELECT id FROM uploads WHERE updated_at < ?').all(now - 6 * 3_600_000)) {
        rmSync(join(uploadDir, `${row.id}.part`), { force: true });
        db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
      }
    } catch { /* best effort */ }
  }, 60_000);
  housekeeping.unref();
  app.addHook('onClose', async () => {
    clearInterval(housekeeping);
    for (const svc of tgServices.values()) await svc.close();
    db.close();
  });

  // ─── Request pipeline ───────────────────────────────────────────────
  app.addHook('onRequest', async (request, reply) => {
    const edgeIp = config.clientIpHeader ? String(request.headers[config.clientIpHeader] ?? '').split(',')[0].trim() : '';
    request.clientIp = normalizeIp(edgeIp && isIP(normalizeIp(edgeIp)) ? edgeIp : request.ip);
    request.ua = String(request.headers['user-agent'] ?? '').slice(0, 300);
    applySecurityHeaders(reply, { secure: config.cookieSecure });
    reply.header('X-Request-Id', request.id);
    // A private vault has no business in search results.
    reply.header('X-Robots-Tag', 'noindex, nofollow, noarchive');
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');

    const blocked = blocklist.check(request.clientIp);
    if (blocked) throw new HttpError(403, 'IP_BLOCKED', 'Access from this address is blocked.', { until: blocked.until });

    const limit = globalLimiter.hit(request.clientIp);
    if (!limit.allowed) {
      reply.header('Retry-After', Math.ceil(limit.retryAfterMs / 1000));
      throw new HttpError(429, 'RATE_LIMITED', 'Too many requests. Slow down.');
    }

    // Cross-site request defenses for anything that changes state.
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const site = request.headers['sec-fetch-site'];
      if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'CROSS_SITE', 'Cross-site request refused.');
      const origin = request.headers.origin;
      if (origin) {
        let host = '';
        try { host = new URL(origin).host; } catch { /* invalid */ }
        if (host !== request.headers.host) throw new HttpError(403, 'BAD_ORIGIN', 'Request origin does not match this console.');
      }
    }

    const token = parseCookies(request.headers.cookie)[cookie];
    const { session, problem } = sessions.resolve(token, request.clientIp, request.ua);
    request.session = session;
    if (problem && problem !== 'unknown' && problem !== 'malformed') {
      reply.header('Set-Cookie', serializeCookie(cookie, '', { secure: config.cookieSecure, maxAgeSeconds: 0 }));
      if (problem === 'fingerprint') audit.record('session.anomaly', { severity: 'high', ip: request.clientIp, detail: { reason: 'user-agent changed mid-session; session revoked' } });
    }
    if (session?.slid) reply.header('Set-Cookie', serializeCookie(cookie, token, { secure: config.cookieSecure, maxAgeSeconds: sessions.lifetimeSeconds }));
    if (session?.ipChanged) {
      audit.record('session.ip_change', { severity: 'medium', actor: session.username, ip: request.clientIp, detail: { from: session.previousIp, to: request.clientIp } });
    }
  });

  app.addHook('onResponse', async (request, reply) => {
    if (request.url.startsWith('/assets/') || request.url.startsWith('/fonts/')) return;
    try {
      db.prepare('INSERT INTO visits(ts, ip, method, path, status, ms, ua, user_id) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(
        Date.now(), request.clientIp ?? normalizeIp(request.ip), request.method, request.url.split('?')[0].slice(0, 200),
        reply.statusCode, Math.round(reply.elapsedTime), request.ua ?? '', request.session?.user_id ?? null,
      );
    } catch { /* never fail a response because of logging */ }
  });

  app.setErrorHandler((error, request, reply) => {
    // A failure after a stream has started can only end that response; trying to send an error
    // body then would throw "headers already sent" and take the whole server down.
    if (reply.raw.headersSent) {
      request.log.warn({ code: error?.code, msg: String(error?.message ?? error).slice(0, 300), url: request.url.split('?')[0] }, 'response aborted after it started');
      reply.raw.destroy();
      return;
    }
    if (error instanceof HttpError) {
      if (error.status >= 500) request.log.warn({ code: error.code, msg: error.message, url: request.url.split('?')[0] }, 'request failed');
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, ...error.extra } });
    }
    if (error.validation) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Request failed validation.' } });
    if (error.statusCode === 413) return reply.code(413).send({ error: { code: 'TOO_LARGE', message: 'Request body too large.' } });
    if (error.statusCode && error.statusCode < 500) return reply.code(error.statusCode).send({ error: { code: 'BAD_REQUEST', message: 'Bad request.' } });
    request.log?.error?.(error);
    return reply.code(500).send({ error: { code: 'INTERNAL', message: 'Internal error. The event was recorded.' } });
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Not found.' } });
    return sendStatic(request, reply);
  });

  // ─── Guards ─────────────────────────────────────────────────────────
  const requireSession = () => async request => {
    const s = request.session;
    if (!s) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required.');
    if (!['GET', 'HEAD'].includes(request.method)) {
      const sent = String(request.headers['x-csrf-token'] ?? '');
      const a = Buffer.from(sent);
      const b = Buffer.from(s.csrf);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        audit.record('csrf.rejected', { severity: 'high', actor: s.username, ip: request.clientIp, detail: { path: request.url.split('?')[0] } });
        throw new HttpError(403, 'CSRF', 'Missing or invalid CSRF token.');
      }
    }
  };
  const requireAdmin = async request => {
    if (request.session?.role !== 'admin') throw new HttpError(403, 'ADMIN_ONLY', 'Only the administrator can see this.');
  };
  const isAdmin = request => request.session?.role === 'admin';
  const authed = { preHandler: [requireSession(), tgDispatch] };
  const authedSudo = authed; // no separate re-authentication step any more
  const adminOnly = { preHandler: [requireSession(), requireAdmin] };

  function authRateLimit(request, reply, username) {
    const ipHit = authLimiter.hit(`ip:${request.clientIp}`);
    if (!ipHit.allowed) {
      recordAttempt(request, username, 'rate_limited', 'password');
      reply.header('Retry-After', Math.ceil(ipHit.retryAfterMs / 1000));
      throw new HttpError(429, 'RATE_LIMITED', 'Too many sign-in attempts. Wait a minute.');
    }
  }

  function recordAttempt(request, username, result, stage) {
    db.prepare('INSERT INTO login_attempts(ts, ip, username, ua, result, stage) VALUES(?, ?, ?, ?, ?, ?)')
      .run(Date.now(), request.clientIp, username ? String(username).slice(0, 64) : null, request.ua, result, stage);
    if (result !== 'success') {
      const hourFailures = db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND ts > ? AND result IN ('bad_password','unknown_user','bad_invite')")
        .get(request.clientIp, Date.now() - 3_600_000).n;
      if (hourFailures >= config.limits.ipFailuresBeforeBlock && !blocklist.check(request.clientIp)) {
        blocklist.block(request.clientIp, 60, `${hourFailures} failed sign-ins within an hour`);
        audit.record('ip.auto_blocked', { severity: 'critical', ip: request.clientIp, detail: { failures: hourFailures, minutes: 60 } });
      }
    }
  }

  function startSession(request, reply, user) {
    const { token, csrf } = sessions.create(user.id, request.clientIp, request.ua);
    reply.header('Set-Cookie', serializeCookie(cookie, token, { secure: config.cookieSecure, maxAgeSeconds: sessions.lifetimeSeconds }));
    db.prepare('UPDATE users SET failed_count = 0, lock_level = 0, locked_until = 0, last_login_at = ?, last_login_ip = ? WHERE id = ?').run(Date.now(), request.clientIp, user.id);
    return csrf;
  }

  function registerFailure(user) {
    const failed = user.failed_count + 1;
    if (failed >= config.limits.accountFailuresBeforeLock) {
      const minutes = lockMinutesForLevel(user.lock_level);
      db.prepare('UPDATE users SET failed_count = 0, lock_level = lock_level + 1, locked_until = ? WHERE id = ?').run(Date.now() + minutes * 60_000, user.id);
      audit.record('account.locked', { severity: 'critical', actor: user.username, detail: { minutes, level: user.lock_level + 1 } });
      return minutes;
    }
    db.prepare('UPDATE users SET failed_count = ? WHERE id = ?').run(failed, user.id);
    return 0;
  }

  const body = (request, field, { max = 256, required = true } = {}) => {
    const value = request.body?.[field];
    if (value === undefined || value === null || value === '') {
      if (required) throw new HttpError(400, 'INVALID_REQUEST', `${field} is required.`);
      return '';
    }
    if (typeof value !== 'string' || value.length > max) throw new HttpError(400, 'INVALID_REQUEST', `${field} is invalid.`);
    return value;
  };

  // ─── Public (pre-login) ─────────────────────────────────────────────
  app.get('/api/public/status', async () => ({
    product: 'Kurovault',
    version: VERSION,
    registration: config.allowRegistration,
    inviteRequired: Boolean(config.inviteCode),
    adminReady: adminExists(),
    serverTime: Date.now(),
    signedIn: false,
  }));

  app.get('/api/public/connection', async request => {
    const info = classifyIp(request.clientIp);
    const agent = describeAgent(request.ua);
    const socket = request.raw.socket;
    return {
      ip: info.ip,
      ipVersion: info.version,
      scope: info.scope,
      protocol: request.protocol,
      tls: typeof socket.getProtocol === 'function' ? socket.getProtocol() : null,
      httpVersion: request.raw.httpVersion,
      browser: agent.browser,
      os: agent.os,
      automated: agent.automated,
      requestId: request.id,
      serverTime: Date.now(),
      monitored: true,
      location: await geo.locate(info.ip),
    };
  });

  app.get('/api/public/checks', async request => ({ checks: isAdmin(request) ? checks.list : checks.appList }));

  app.get('/api/public/checks/:id', async (request, reply) => {
    const id = String(request.params.id).slice(0, 40);
    if (!isAdmin(request) && !checks.isAppCheck(id)) throw new HttpError(404, 'NOT_FOUND', 'Unknown check.');
    const result = await checks.run(id, request, reply);
    if (!result) throw new HttpError(404, 'NOT_FOUND', 'Unknown check.');
    const full = isAdmin(request);
    return { id: result.id, label: result.label, status: result.status, ms: result.ms, detail: full ? result.detail : result.publicDetail };
  });

  // ─── Accounts ───────────────────────────────────────────────────────
  const RESERVED = new Set(['admin', 'administrator', 'root', 'system', 'support', 'security', 'moderator', 'owner', 'staff', 'kurovault', 'filora', 'stashrook', 'ravenhold']);
  const userJson = u => ({ id: u.id, username: u.username, name: u.display_name || u.username, role: u.role });

  app.post('/api/auth/register', async (request, reply) => {
    const username = body(request, 'username', { max: 32 }).trim();
    authRateLimit(request, reply, username);
    if (!config.allowRegistration) throw new HttpError(403, 'REGISTRATION_CLOSED', 'New accounts are switched off on this server.');
    const name = body(request, 'name', { max: 80 }).trim().replace(/[\u0000-\u001f\u007f]/g, '');
    const password = body(request, 'password');
    const confirm = body(request, 'confirm');
    if (!name) throw new HttpError(400, 'INVALID_NAME', 'Enter your name.');
    if (!USERNAME_RE.test(username)) throw new HttpError(400, 'INVALID_USERNAME', 'Usernames are 3–32 letters, digits, dots, dashes or underscores.');
    if (RESERVED.has(username.toLowerCase())) throw new HttpError(409, 'USERNAME_TAKEN', 'That username is reserved. Choose another.');
    if (password !== confirm) throw new HttpError(400, 'PASSWORD_MISMATCH', 'The two passwords do not match.');
    const problems = passwordProblems(password, username, { min: 8 });
    if (problems.length) throw new HttpError(400, 'WEAK_PASSWORD', problems[0], { problems });
    // Invitation code, when the owner has set one. Compared in constant time; a wrong code counts as a failed attempt.
    if (config.inviteCode) {
      const given = Buffer.from(body(request, 'invite', { max: 128, required: false }).trim());
      const want = Buffer.from(config.inviteCode);
      if (given.length !== want.length || !timingSafeEqual(given, want)) {
        recordAttempt(request, username, 'bad_invite', 'register');
        throw new HttpError(403, 'BAD_INVITE', 'That invitation code is not right.');
      }
    }
    const day = Date.now() - 86_400_000;
    if (db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND stage = 'register' AND result = 'success' AND ts > ?").get(request.clientIp, day).n >= config.signupsPerIpPerDay) {
      recordAttempt(request, username, 'signup_limit', 'register');
      throw new HttpError(429, 'SIGNUP_LIMIT', 'Too many new accounts from this address today. Try again tomorrow.');
    }
    if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n >= config.maxUsers) throw new HttpError(403, 'REGISTRATION_CLOSED', 'This server is not taking new accounts right now.');
    if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) {
      recordAttempt(request, username, 'username_taken', 'register');
      throw new HttpError(409, 'USERNAME_TAKEN', 'That username is already taken.');
    }
    const now = Date.now();
    const info = db.prepare("INSERT INTO users(username, display_name, role, pw_hash, created_at, password_changed_at) VALUES(?, ?, 'user', ?, ?, ?)")
      .run(username, name, await hashPassword(password), now, now);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    recordAttempt(request, username, 'success', 'register');
    audit.record('account.created', { severity: 'medium', actor: username, ip: request.clientIp, detail: { name, location: geo.label(request.clientIp) } });
    return { csrf: startSession(request, reply, user), user: userJson(user) };
  });

  app.post('/api/auth/login', async (request, reply) => {
    const username = body(request, 'username', { max: 64 }).trim();
    authRateLimit(request, reply, username);
    const password = body(request, 'password');
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    const generic = new HttpError(401, 'INVALID_CREDENTIALS', 'Username or password is incorrect.');
    if (!user) {
      await dummyVerify(password);
      recordAttempt(request, username, 'unknown_user', 'password');
      throw generic;
    }
    // A lock stops guessing from strangers, but not the owner: an address this account signed in
    // from in the last 30 days may still try, so nobody can lock you out by failing on purpose.
    const knownAddress = () => Boolean(db.prepare("SELECT 1 FROM login_attempts WHERE username = ? AND ip = ? AND result = 'success' AND ts > ? LIMIT 1")
      .get(user.username, request.clientIp, Date.now() - 30 * 86_400_000));
    if (user.locked_until > Date.now() && !knownAddress()) {
      await dummyVerify(password);
      recordAttempt(request, username, 'locked', 'password');
      throw new HttpError(423, 'ACCOUNT_LOCKED', 'This account is temporarily locked after repeated failures.', { until: user.locked_until });
    }
    if (!(await verifyPassword(password, user.pw_hash))) {
      const lockedFor = registerFailure(user);
      recordAttempt(request, username, 'bad_password', 'password');
      if (lockedFor) throw new HttpError(423, 'ACCOUNT_LOCKED', `Too many failures. Locked for ${lockedFor} minutes.`, { until: Date.now() + lockedFor * 60_000 });
      throw generic;
    }
    if (user.disabled_at) {
      recordAttempt(request, username, 'disabled', 'password');
      throw new HttpError(403, 'ACCOUNT_DISABLED', 'This account has been switched off by the administrator.');
    }
    recordAttempt(request, user.username, 'success', 'password');
    audit.record('auth.login', { severity: user.role === 'admin' ? 'medium' : 'info', actor: user.username, ip: request.clientIp, detail: { agent: describeAgent(request.ua), location: geo.label(request.clientIp) } });
    return { csrf: startSession(request, reply, user), user: userJson(user) };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    if (request.session) {
      sessions.revoke(request.session.id_hash, 'signed out');
      audit.record('auth.logout', { actor: request.session.username, ip: request.clientIp });
    }
    reply.header('Set-Cookie', serializeCookie(cookie, '', { secure: config.cookieSecure, maxAgeSeconds: 0 }));
    return { ok: true };
  });

  app.get('/api/auth/me', async request => {
    const s = request.session;
    if (!s) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in required.');
    const user = db.prepare('SELECT id, username, display_name, role, created_at, password_changed_at, last_login_at, last_login_ip FROM users WHERE id = ?').get(s.user_id);
    const previous = db.prepare("SELECT ts, ip, ua FROM login_attempts WHERE username = ? AND result = 'success' ORDER BY id DESC LIMIT 1 OFFSET 1").get(s.username);
    const failedSince = previous
      ? db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE username = ? AND result IN ('bad_password','locked') AND ts > ?").get(s.username, previous.ts).n
      : 0;
    return {
      user: { ...userJson(user), created_at: user.created_at, password_changed_at: user.password_changed_at },
      csrf: s.csrf,
      session: { createdAt: s.created_at, expiresAt: s.expires_at, ip: s.ip, location: geo.label(request.clientIp) },
      previousLogin: previous ? { ...previous, location: geo.label(previous.ip) } : null,
      failedSincePrevious: failedSince,
      sessionDays: config.sessionDays,
    };
  });

  app.post('/api/auth/password', authed, async request => {
    const s = request.session;
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id);
    const current = body(request, 'current');
    const next = body(request, 'next');
    if (!(await verifyPassword(current, user.pw_hash))) {
      registerFailure(user);
      recordAttempt(request, user.username, 'bad_password', 'password_change');
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect.');
    }
    const problems = passwordProblems(next, user.username, { min: user.role === 'admin' ? 12 : 8 });
    if (problems.length) throw new HttpError(400, 'WEAK_PASSWORD', problems[0], { problems });
    db.prepare('UPDATE users SET pw_hash = ?, password_changed_at = ? WHERE id = ?').run(await hashPassword(next), Date.now(), user.id);
    const revoked = sessions.revokeAllForUser(user.id, 'password changed', s.id_hash);
    audit.record('auth.password_changed', { severity: 'high', actor: user.username, ip: request.clientIp, detail: { otherSessionsRevoked: revoked } });
    return { ok: true, revoked };
  });

  // Your own devices: every signed-in browser on this account, and a way to sign the others out.
  app.get('/api/auth/sessions', authed, async request => ({
    sessions: sessions.forUser(request.session.user_id).map(s => ({
      id: s.id_hash.slice(0, 16), createdAt: s.created_at, lastSeen: s.last_seen, ip: s.last_ip, location: geo.label(s.last_ip),
      agent: describeAgent(s.ua), current: s.id_hash === request.session.id_hash,
    })),
  }));
  app.post('/api/auth/sessions/revoke', authed, async request => {
    const prefix = body(request, 'id', { max: 16 });
    const target = sessions.forUser(request.session.user_id).find(s => s.id_hash.startsWith(prefix));
    if (!target) throw new HttpError(404, 'NOT_FOUND', 'Session not found.');
    sessions.revoke(target.id_hash, 'signed out from another device');
    audit.record('session.revoked', { severity: 'medium', actor: request.session.username, ip: request.clientIp, detail: { session: prefix, sessionIp: target.last_ip } });
    return { ok: true };
  });
  app.post('/api/auth/sessions/revoke-others', authed, async request => {
    const count = sessions.revokeAllForUser(request.session.user_id, 'signed out everywhere else', request.session.id_hash);
    audit.record('session.revoked_others', { severity: 'medium', actor: request.session.username, ip: request.clientIp, detail: { count } });
    return { ok: true, count };
  });

  // ─── Intelligence console ───────────────────────────────────────────
  const BAD = "('bad_password','unknown_user','bad_invite','disabled','signup_limit','locked','rate_limited')";

  app.get('/api/console/overview', adminOnly, async () => {
    const now = Date.now();
    const day = now - 86_400_000;
    const kpi = {
      loginsOk: db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ts > ? AND result = 'success'").get(day).n,
      loginsFailed: db.prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE ts > ? AND result IN ${BAD}`).get(day).n,
      uniqueIps: db.prepare('SELECT COUNT(DISTINCT ip) AS n FROM visits WHERE ts > ?').get(day).n,
      requests: db.prepare('SELECT COUNT(*) AS n FROM visits WHERE ts > ?').get(day).n,
      blockedIps: blocklist.list().length,
      activeSessions: sessions.active().length,
      auditEntries: db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,
      highSeverity: db.prepare("SELECT COUNT(*) AS n FROM audit WHERE ts > ? AND severity IN ('high','critical')").get(day).n,
    };
    const hourStart = now - (now % 3_600_000) - 23 * 3_600_000;
    const series = Array.from({ length: 24 }, (_, i) => ({ t: hourStart + i * 3_600_000, requests: 0, failures: 0, logins: 0 }));
    for (const row of db.prepare('SELECT CAST((ts - ?) / 3600000 AS INTEGER) AS b, COUNT(*) AS n FROM visits WHERE ts >= ? GROUP BY b').iterate(hourStart, hourStart)) {
      if (series[row.b]) series[row.b].requests = row.n;
    }
    for (const row of db.prepare(`SELECT CAST((ts - ?) / 3600000 AS INTEGER) AS b, SUM(result IN ${BAD}) AS f, SUM(result = 'success') AS s FROM login_attempts WHERE ts >= ? GROUP BY b`).iterate(hourStart, hourStart)) {
      if (series[row.b]) { series[row.b].failures = row.f; series[row.b].logins = row.s; }
    }
    const topThreats = db.prepare(`SELECT ip, COUNT(*) AS failures, MAX(ts) AS last, GROUP_CONCAT(DISTINCT username) AS usernames
      FROM login_attempts WHERE ts > ? AND result IN ${BAD} GROUP BY ip ORDER BY failures DESC LIMIT 6`).all(day)
      .map(row => ({ ...row, ...classifyIp(row.ip), location: geo.label(row.ip), blocked: Boolean(blocklist.list().find(b => b.ip === row.ip)) }));
    const events = db.prepare('SELECT id, ts, severity, actor, ip, action, detail FROM audit ORDER BY id DESC LIMIT 14').all();
    const chain = audit.verify();
    return { kpi, series, topThreats, events, chain: { ok: chain.ok, count: chain.count, brokenAt: chain.brokenAt ?? null } };
  });

  app.get('/api/console/attempts', adminOnly, async request => {
    const q = request.query ?? {};
    const limit = Math.min(500, Math.max(1, Number(q.limit) || 200));
    const where = [];
    const args = [];
    if (q.result === 'failed') where.push(`result IN ${BAD}`);
    else if (q.result === 'success') where.push("result = 'success'");
    if (q.ip && typeof q.ip === 'string') { where.push('ip = ?'); args.push(q.ip.slice(0, 64)); }
    const rows = db.prepare(`SELECT * FROM login_attempts ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit);
    return { attempts: rows.map(r => ({ ...r, scope: classifyIp(r.ip).scope, location: geo.label(r.ip), agent: describeAgent(r.ua) })) };
  });

  app.get('/api/console/visitors', adminOnly, async () => {
    const since = Date.now() - config.retentionDays * 86_400_000;
    const blocks = new Map(blocklist.list().map(b => [b.ip, b]));
    const rows = db.prepare(`SELECT v.ip, COUNT(*) AS requests, MIN(v.ts) AS first_seen, MAX(v.ts) AS last_seen,
        SUM(v.status >= 400) AS errors, COUNT(DISTINCT v.path) AS paths,
        (SELECT ua FROM visits WHERE ip = v.ip ORDER BY id DESC LIMIT 1) AS ua,
        (SELECT GROUP_CONCAT(DISTINCT u.username) FROM visits x JOIN users u ON u.id = x.user_id WHERE x.ip = v.ip) AS operators
      FROM visits v WHERE v.ts > ? GROUP BY v.ip ORDER BY last_seen DESC LIMIT 500`).all(since);
    const attempts = new Map(db.prepare(`SELECT ip, SUM(result = 'success') AS ok, SUM(result IN ${BAD}) AS bad, GROUP_CONCAT(DISTINCT username) AS usernames FROM login_attempts WHERE ts > ? GROUP BY ip`).all(since).map(r => [r.ip, r]));
    return {
      visitors: rows.map(r => {
        const a = attempts.get(r.ip);
        return {
          ...r, ...classifyIp(r.ip), location: geo.lookup(r.ip), agent: describeAgent(r.ua),
          loginsOk: a?.ok ?? 0, loginsFailed: a?.bad ?? 0, triedUsernames: a?.usernames ?? null,
          blocked: blocks.get(r.ip) ?? null,
          risk: (a?.bad ?? 0) >= 10 ? 'high' : (a?.bad ?? 0) > 0 || r.errors > 20 ? 'elevated' : 'low',
        };
      }),
    };
  });

  app.get('/api/console/visits', adminOnly, async request => {
    const ip = typeof request.query?.ip === 'string' ? request.query.ip.slice(0, 64) : null;
    const rows = ip
      ? db.prepare('SELECT * FROM visits WHERE ip = ? ORDER BY id DESC LIMIT 200').all(ip)
      : db.prepare('SELECT * FROM visits ORDER BY id DESC LIMIT 200').all();
    return { visits: rows.map(r => ({ ...r, location: geo.label(r.ip) })) };
  });

  app.get('/api/console/sessions', adminOnly, async request => ({
    sessions: sessions.active().map(s => ({
      id: s.id_hash.slice(0, 16), username: s.username, name: s.display_name || s.username, role: s.role, location: geo.label(s.last_ip), createdAt: s.created_at, lastSeen: s.last_seen, expiresAt: s.expires_at,
      ip: s.ip, lastIp: s.last_ip, scope: classifyIp(s.last_ip).scope, agent: describeAgent(s.ua), current: s.id_hash === request.session.id_hash,
    })),
  }));

  app.get('/api/console/users', adminOnly, async () => ({
    users: db.prepare(`SELECT u.id, u.username, u.display_name, u.role, u.created_at, u.last_login_at, u.last_login_ip, u.locked_until, u.disabled_at,
        (SELECT COUNT(*) FROM sessions s WHERE s.user_id = u.id AND s.revoked_at IS NULL AND s.expires_at > ?) AS sessions
      FROM users u ORDER BY u.created_at DESC`).all(Date.now())
      .map(u => ({ ...u, name: u.display_name || u.username, location: geo.label(u.last_login_ip), telegram: tgFor(u.id).status().keyConfigured })),
  }));

  // Account controls. The admin account itself can never be switched off or removed here.
  const memberById = request => {
    const id = Number(request.params.id);
    const user = Number.isInteger(id) ? db.prepare('SELECT * FROM users WHERE id = ?').get(id) : null;
    if (!user) throw new HttpError(404, 'NOT_FOUND', 'Account not found.');
    if (user.role === 'admin') throw new HttpError(400, 'PROTECTED_ACCOUNT', 'The administrator account cannot be changed here.');
    return user;
  };
  app.post('/api/console/users/:id/disable', adminOnly, async request => {
    const user = memberById(request);
    db.prepare('UPDATE users SET disabled_at = ? WHERE id = ?').run(Date.now(), user.id);
    const count = sessions.revokeAllForUser(user.id, 'account switched off');
    audit.record('account.disabled', { severity: 'high', actor: request.session.username, ip: request.clientIp, detail: { user: user.username, sessionsEnded: count } });
    return { ok: true };
  });
  app.post('/api/console/users/:id/enable', adminOnly, async request => {
    const user = memberById(request);
    db.prepare('UPDATE users SET disabled_at = 0, locked_until = 0, failed_count = 0, lock_level = 0 WHERE id = ?').run(user.id);
    audit.record('account.enabled', { severity: 'medium', actor: request.session.username, ip: request.clientIp, detail: { user: user.username } });
    return { ok: true };
  });
  app.post('/api/console/users/:id/sign-out', adminOnly, async request => {
    const user = memberById(request);
    const count = sessions.revokeAllForUser(user.id, `signed out by ${request.session.username}`);
    audit.record('session.revoked_others', { severity: 'medium', actor: request.session.username, ip: request.clientIp, detail: { user: user.username, count } });
    return { ok: true, count };
  });
  app.delete('/api/console/users/:id', adminOnly, async request => {
    const user = memberById(request);
    // End their Telegram login on Telegram's side too, then erase everything the server kept for them.
    try { await tgFor(user.id).logout(request.session.username, request.clientIp); } catch { /* already gone */ }
    try { await tgFor(user.id).close(); } catch { /* not open */ }
    tgServices.delete(user.id);
    for (const k of ['tg_session', 'tg_api', 'source_mode']) setSetting(db, `${k}:${user.id}`, null);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    audit.record('account.deleted', { severity: 'high', actor: request.session.username, ip: request.clientIp, detail: { user: user.username } });
    return { ok: true };
  });

  app.post('/api/console/sessions/revoke', adminOnly, async request => {
    const prefix = body(request, 'id', { max: 16 });
    const target = sessions.active().find(s => s.id_hash.startsWith(prefix));
    if (!target) throw new HttpError(404, 'NOT_FOUND', 'Session not found.');
    sessions.revoke(target.id_hash, `revoked by ${request.session.username}`);
    audit.record('session.revoked', { severity: 'medium', actor: request.session.username, ip: request.clientIp, detail: { session: prefix, sessionIp: target.last_ip } });
    return { ok: true };
  });

  app.post('/api/console/sessions/revoke-others', adminOnly, async request => {
    const count = sessions.revokeAllForUser(request.session.user_id, 'signed out everywhere else', request.session.id_hash);
    audit.record('session.revoked_others', { severity: 'medium', actor: request.session.username, ip: request.clientIp, detail: { count } });
    return { ok: true, count };
  });

  app.get('/api/console/audit', adminOnly, async request => {
    const before = Number(request.query?.before) || Number.MAX_SAFE_INTEGER;
    const rows = db.prepare('SELECT * FROM audit WHERE id < ? ORDER BY id DESC LIMIT 200').all(before);
    return { entries: rows, chain: audit.verify() };
  });

  app.get('/api/console/feed', adminOnly, async request => {
    const after = Number(request.query?.after) || 0;
    return {
      events: db.prepare('SELECT id, ts, severity, actor, ip, action, detail FROM audit WHERE id > ? ORDER BY id DESC LIMIT 50').all(after),
      attempts: db.prepare('SELECT id, ts, ip, username, result, stage FROM login_attempts ORDER BY id DESC LIMIT 8').all(),
    };
  });

  app.get('/api/console/blocks', adminOnly, async () => ({ blocks: blocklist.list() }));

  app.post('/api/console/blocks', adminOnly, async request => {
    const ip = normalizeIp(body(request, 'ip', { max: 64 }));
    if (classifyIp(ip).version === 0) throw new HttpError(400, 'INVALID_IP', 'Enter a valid IPv4 or IPv6 address.');
    if (ip === request.clientIp) throw new HttpError(400, 'SELF_BLOCK', 'You cannot block the address you are connected from.');
    const minutes = Math.min(525_600, Math.max(5, Number(request.body?.minutes) || 1440));
    const reason = body(request, 'reason', { max: 200, required: false }) || 'Blocked by operator';
    blocklist.block(ip, minutes, reason, request.session.username);
    audit.record('ip.blocked', { severity: 'high', actor: request.session.username, ip: request.clientIp, detail: { target: ip, minutes, reason } });
    return { ok: true };
  });

  app.delete('/api/console/blocks/:ip', adminOnly, async request => {
    const ip = normalizeIp(String(request.params.ip).slice(0, 64));
    const removed = blocklist.unblock(ip);
    if (removed) audit.record('ip.unblocked', { severity: 'medium', actor: request.session.username, ip: request.clientIp, detail: { target: ip } });
    return { ok: removed };
  });

  // ─── Telegram Drive (proxied; key stays server-side) ────────────────
  const driveError = error => {
    if (error instanceof HttpError) return error;
    if (error.status === 401 || error.status === 403) return new HttpError(502, 'DRIVE_KEY_REJECTED', 'The Telegram Drive API rejected the configured key.');
    if (error.status) return new HttpError(error.status >= 500 ? 502 : error.status, error.code ?? 'DRIVE_ERROR', error.message);
    return new HttpError(503, 'DRIVE_UNREACHABLE', 'The Telegram Drive desktop app API is not reachable. Make sure it is running with the REST API enabled.');
  };
  const folderId = value => {
    if (value === undefined || value === '' || value === 'home') return undefined;
    if (!/^-?\d{1,20}$/.test(String(value))) throw new HttpError(400, 'INVALID_FOLDER_ID', 'Invalid folder id.');
    return String(value);
  };
  const fileId = value => {
    if (!/^\d{1,10}$/.test(String(value))) throw new HttpError(400, 'INVALID_FILE_ID', 'Invalid file id.');
    return String(value);
  };

  app.get('/api/drive/status', authed, async () => {
    const health = await drive.health();
    return { url: drive.baseUrl(), keyConfigured: drive.keyConfigured(), ...health };
  });

  app.put('/api/drive/config', adminOnly, async request => {
    const url = request.body?.url;
    const key = request.body?.key;
    if (url !== undefined && (typeof url !== 'string' || url.length > 300)) throw new HttpError(400, 'INVALID_URL', 'Invalid URL.');
    if (key !== undefined && (typeof key !== 'string' || key.length > 512)) throw new HttpError(400, 'INVALID_KEY', 'Invalid key.');
    try { drive.configure({ url, key }); } catch (error) { throw new HttpError(400, 'INVALID_URL', error.message); }
    audit.record('drive.configured', { severity: 'high', actor: request.session.username, ip: request.clientIp, detail: { urlChanged: url !== undefined, keyChanged: key !== undefined } });
    return { ok: true };
  });

  app.get('/api/drive/folders', authed, async () => {
    try { return { folders: await drive.call('/folders') }; } catch (error) { throw driveError(error); }
  });

  app.get('/api/drive/files', authed, async request => {
    const q = request.query ?? {};
    const sort = ['name', 'size', 'created_at'].includes(q.sort) ? q.sort : 'created_at';
    const order = q.order === 'asc' ? 'asc' : 'desc';
    try {
      return await drive.call('/files', {
        query: {
          // "home" must be passed through: the Drive API reads Saved Messages for it, but all folders when omitted.
          folder_id: q.folder_id === 'home' ? 'home' : folderId(q.folder_id), page: Math.max(1, Number(q.page) || 1), limit: Math.min(100, Math.max(1, Number(q.limit) || 50)),
          search: typeof q.search === 'string' ? q.search.slice(0, 120) : undefined, sort, order,
          mime_type: ['video', 'audio', 'image', 'application/pdf'].includes(q.mime_type) ? q.mime_type : undefined,
        },
      });
    } catch (error) { throw driveError(error); }
  });

  app.get('/api/drive/storage', authed, async () => {
    try { return await drive.call('/storage/stats'); } catch (error) { throw driveError(error); }
  });

  /** Aborts the upstream request as soon as the browser goes away (closed tab, seek, skip). */
  function disconnectSignal(reply) {
    const ac = new AbortController();
    reply.raw.on('close', () => { if (!reply.raw.writableFinished) ac.abort(); });
    return ac.signal;
  }
  function pipeUpstream(reply, upstream) {
    const body = Readable.fromWeb(upstream.body);
    body.on('error', () => undefined);
    return reply.send(body);
  }

  app.get('/api/drive/files/:id/download', authed, async (request, reply) => {
    const id = fileId(request.params.id);
    const folder = folderId(request.query?.folder_id);
    let upstream;
    try { ({ response: upstream } = await drive.stream(`/files/${id}/download`, { query: { folder_id: folder }, signal: disconnectSignal(reply) })); } catch (error) { throw driveError(error); }
    if (!upstream.ok) throw driveError(Object.assign(new Error(`Drive API returned ${upstream.status}`), { status: upstream.status }));
    audit.record('drive.download', { actor: request.session.username, ip: request.clientIp, detail: { file: id, folder: folder ?? 'saved' } });
    void fileMeta(id, folder).then(meta => remember(request.session.user_id, 'recent', folder, meta)).catch(() => undefined);
    const disposition = upstream.headers.get('content-disposition');
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', disposition && /^attachment;/i.test(disposition) ? disposition : `attachment; filename="file-${id}"`);
    const length = upstream.headers.get('content-length');
    if (length) reply.header('Content-Length', length);
    return pipeUpstream(reply, upstream);
  });

  // ─── Media streaming (Range-aware, inline only for safe media types) ──
  const INLINE_TYPES = new Set([
    'video/mp4', 'video/webm', 'video/ogg', 'video/quicktime', 'video/x-matroska',
    'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/opus', 'audio/wav', 'audio/x-wav', 'audio/webm', 'audio/flac', 'audio/x-flac', 'audio/x-m4a',
    'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'image/avif', 'image/bmp',
    'application/pdf',
  ]);
  const EXT_TYPES = {
    mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime', mkv: 'video/x-matroska',
    mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac', weba: 'audio/webm',
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
    pdf: 'application/pdf',
  };
  /** Never serve user content inline unless it is a passive media type (no HTML, SVG or scripts). */
  function inlineType(meta) {
    const declared = String(meta.mime_type ?? '').toLowerCase().split(';')[0].trim();
    if (INLINE_TYPES.has(declared)) return declared;
    const ext = String(meta.name ?? '').toLowerCase().split('.').pop();
    const guessed = EXT_TYPES[ext];
    if (guessed && (declared === '' || declared === 'application/octet-stream' || declared.startsWith(guessed.split('/')[0] + '/'))) return guessed;
    return null;
  }
  const metaCache = new Map();
  async function fileMeta(id, folder, request) {
    if (request && useTg(request)) return request.tg.meta(id, folder);
    const key = `${folder ?? 'saved'}:${id}`;
    const hit = metaCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.meta;
    const meta = await drive.call(`/files/${id}`, { query: { folder_id: folder } });
    metaCache.set(key, { meta, expires: Date.now() + 10 * 60_000 });
    if (metaCache.size > 2000) metaCache.delete(metaCache.keys().next().value);
    return meta;
  }
  const streamAudits = new Map();

  app.get('/api/drive/files/:id/stream', authed, async (request, reply) => {
    const id = fileId(request.params.id);
    const folder = folderId(request.query?.folder_id);
    let meta;
    try { meta = await fileMeta(id, folder); } catch (error) { throw driveError(error); }
    if (meta.encrypted) throw new HttpError(409, 'ENCRYPTED', 'This file is end-to-end encrypted. Open it in the desktop app, which holds the key.');
    const type = inlineType(meta);
    const range = String(request.headers.range ?? '');
    const headers = /^bytes=\d*-\d*$/.test(range) ? { Range: range } : {};
    let upstream;
    try { ({ response: upstream } = await drive.stream(`/files/${id}/download`, { query: { folder_id: folder }, headers, signal: disconnectSignal(reply) })); } catch (error) { throw driveError(error); }
    if (!upstream.ok) {
      if (upstream.status === 416) { reply.code(416); reply.header('Content-Range', upstream.headers.get('content-range') ?? ''); return reply.send(); }
      throw driveError(Object.assign(new Error(`Drive API returned ${upstream.status}`), { status: upstream.status }));
    }
    const auditKey = `${request.session.id_hash}:${folder}:${id}`;
    if ((streamAudits.get(auditKey) ?? 0) < Date.now() - 10 * 60_000) {
      streamAudits.set(auditKey, Date.now());
      if (streamAudits.size > 5000) streamAudits.delete(streamAudits.keys().next().value);
      audit.record('drive.open', { actor: request.session.username, ip: request.clientIp, detail: { file: id, folder: folder ?? 'saved', name: String(meta.name).slice(0, 120), type: type ?? 'download' } });
      remember(request.session.user_id, 'recent', folder, meta);
    }
    reply.code(upstream.status);
    reply.header('Content-Type', type ?? 'application/octet-stream');
    const encoded = encodeURIComponent(String(meta.name ?? `file-${id}`)).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16));
    reply.header('Content-Disposition', `${type ? 'inline' : 'attachment'}; filename*=UTF-8''${encoded}`);
    reply.header('Accept-Ranges', 'bytes');
    for (const name of ['content-length', 'content-range']) {
      const value = upstream.headers.get(name);
      if (value) reply.header(name, value);
    }
    // Opened directly in a tab, the file is still sandboxed: no scripts, no plugins, no same-origin access.
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    reply.header('Cache-Control', 'private, no-store');
    return pipeUpstream(reply, upstream);
  });

  app.get('/api/drive/files/:id/thumbnail', authed, async (request, reply) => {
    const id = fileId(request.params.id);
    const folder = folderId(request.query?.folder_id);
    let upstream;
    try { upstream = await drive.call(`/files/${id}/thumbnail`, { query: { folder_id: folder }, raw: true, headers: { Accept: 'image/jpeg' } }); } catch (error) { throw driveError(error); }
    if (!upstream.ok) return reply.code(upstream.status === 404 ? 404 : 502).send({ error: { code: 'NO_THUMBNAIL', message: 'No thumbnail.' } });
    const body = Buffer.from(await upstream.arrayBuffer());
    if (body.length > 5 * 1024 * 1024 || !(body[0] === 0xff && body[1] === 0xd8)) return reply.code(502).send({ error: { code: 'BAD_THUMBNAIL', message: 'Thumbnail rejected.' } });
    reply.header('Cache-Control', 'private, max-age=600');
    return reply.type('image/jpeg').send(body);
  });

  app.get('/api/drive/files/:id/media-info', authed, async request => {
    const id = fileId(request.params.id);
    const folder = folderId(request.query?.folder_id);
    try { return await drive.call(`/files/${id}/media-info`, { query: { folder_id: folder } }); } catch (error) { throw driveError(error); }
  });

  // ─── Resumable chunked uploads (up to Telegram's 2 GB limit) ───────
  // Chunks stay small (16 MB default) so tunnels and proxies with request-size caps still work.
  const cleanName = raw => String(raw ?? '').slice(0, 200).replace(/[\\/\0<>:"|?*\u0000-\u001f]/g, '_').replace(/^\.+/, '_').trim() || 'upload.bin';
  const uploadRow = (request, id) => {
    if (!/^[A-Za-z0-9_-]{20,40}$/.test(String(id))) throw new HttpError(400, 'INVALID_UPLOAD', 'Invalid upload id.');
    const row = db.prepare('SELECT * FROM uploads WHERE id = ? AND user_id = ?').get(id, request.session.user_id);
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Upload not found or expired.');
    return row;
  };

  app.post('/api/drive/uploads', authed, async request => {
    const name = cleanName(request.body?.name);
    const size = Number(request.body?.size);
    if (!Number.isSafeInteger(size) || size < 1) throw new HttpError(400, 'INVALID_SIZE', 'Invalid file size.');
    if (size > config.maxUploadBytes) throw new HttpError(413, 'TOO_LARGE', `Files can be at most ${Math.floor(config.maxUploadBytes / 1_000_000)} MB (Telegram's limit).`);
    const folder = folderId(request.body?.folder_id === null ? undefined : request.body?.folder_id);
    const id = randomBytes(18).toString('base64url');
    closeSync(openSync(join(uploadDir, `${id}.part`), 'wx', 0o600));
    db.prepare('INSERT INTO uploads(id, user_id, name, folder_key, size, chunk_size, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, request.session.user_id, name, folder ?? '', size, config.uploadChunkBytes, Date.now(), Date.now());
    return { id, chunkSize: config.uploadChunkBytes, chunks: Math.ceil(size / config.uploadChunkBytes) };
  });

  app.get('/api/drive/uploads/:id', authed, async request => {
    const row = uploadRow(request, request.params.id);
    return { id: row.id, nextIndex: row.next_index, received: row.received, size: row.size, chunkSize: row.chunk_size };
  });

  app.put('/api/drive/uploads/:id/chunks/:index', authed, async request => {
    const row = uploadRow(request, request.params.id);
    const index = Number(request.params.index);
    const chunks = Math.ceil(row.size / row.chunk_size);
    if (!Number.isInteger(index) || index < 0 || index >= chunks) throw new HttpError(400, 'INVALID_CHUNK', 'Invalid chunk index.');
    const expected = index === chunks - 1 ? row.size - index * row.chunk_size : row.chunk_size;
    if (index < row.next_index) { request.body?.resume?.(); return { nextIndex: row.next_index, received: row.received, duplicate: true }; }
    if (index > row.next_index) throw new HttpError(409, 'OUT_OF_ORDER', `Send chunk ${row.next_index} next.`, { nextIndex: row.next_index });
    const stream = request.body;
    if (!stream || typeof stream.on !== 'function') throw new HttpError(400, 'EMPTY_UPLOAD', 'Send the chunk as application/octet-stream.');
    const fd = openSync(join(uploadDir, `${row.id}.part`), 'r+');
    let written = 0;
    try {
      for await (const chunk of stream) {
        if (written + chunk.length > expected) throw new HttpError(413, 'CHUNK_TOO_LARGE', 'Chunk is larger than announced.');
        writeSync(fd, chunk, 0, chunk.length, index * row.chunk_size + written);
        written += chunk.length;
      }
    } finally {
      closeSync(fd);
    }
    if (written !== expected) throw new HttpError(400, 'SHORT_CHUNK', `Chunk ${index} was incomplete (${written} of ${expected} bytes). Send it again.`);
    db.prepare('UPDATE uploads SET next_index = ?, received = ?, updated_at = ? WHERE id = ?').run(index + 1, row.received + written, Date.now(), row.id);
    return { nextIndex: index + 1, received: row.received + written };
  });

  app.post('/api/drive/uploads/:id/complete', authed, async request => {
    const row = uploadRow(request, request.params.id);
    if (row.received !== row.size) throw new HttpError(409, 'INCOMPLETE', `Only ${row.received} of ${row.size} bytes arrived.`);
    const file = join(uploadDir, `${row.id}.part`);
    const boundary = `----kurovault${randomBytes(12).toString('hex')}`;
    const folder = row.folder_key || undefined;
    const head = Buffer.from(
      (folder ? `--${boundary}\r\nContent-Disposition: form-data; name="folder_id"\r\n\r\n${folder}\r\n` : '')
      + `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${row.name.replace(/"/g, "'")}"\r\nContent-Type: application/octet-stream\r\n\r\n`, 'utf8');
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    async function* parts() { yield head; for await (const c of createReadStream(file)) yield c; yield tail; }
    let upstream;
    try {
      ({ response: upstream } = await drive.stream('/files', {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}`, 'Content-Length': String(head.length + row.size + tail.length), Accept: 'application/json' },
        body: Readable.toWeb(Readable.from(parts())),
        headerTimeoutMs: 6 * 3_600_000,
      }));
    } catch (error) { throw driveError(error); }
    const text = await upstream.text();
    let data = null;
    try { data = JSON.parse(text); } catch { /* non-JSON */ }
    if (!upstream.ok) throw driveError(Object.assign(new Error(data?.error?.message ?? `Drive API returned ${upstream.status}`), { status: upstream.status }));
    rmSync(file, { force: true });
    db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
    audit.record('drive.upload', { actor: request.session.username, ip: request.clientIp, detail: { name: row.name, bytes: row.size, folder: folder ?? 'saved' } });
    return data ?? { success: true };
  });

  app.delete('/api/drive/uploads/:id', authed, async request => {
    const row = uploadRow(request, request.params.id);
    rmSync(join(uploadDir, `${row.id}.part`), { force: true });
    db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
    return { ok: true };
  });

  app.delete('/api/drive/files/:id', authedSudo, async request => {
    const id = fileId(request.params.id);
    const folder = folderId(request.query?.folder_id);
    try {
      const result = await drive.call(`/files/${id}`, { method: 'DELETE', query: { folder_id: folder } });
      forgetFile(folder, id);
      audit.record('drive.delete', { severity: 'high', actor: request.session.username, ip: request.clientIp, detail: { file: id, folder: folder ?? 'saved' } });
      return result ?? { ok: true };
    } catch (error) { throw driveError(error); }
  });

  // ─── Folder & file management ──────────────────────────────────────
  const optionalFolder = value => (value === null || value === undefined || value === '' || value === 'home' ? null : Number(folderId(value)));
  const nameField = (request, field = 'name') => {
    const value = body(request, field, { max: 200 }).trim();
    if (!value || /[\u0000-\u001f]/.test(value) || /[\\/]/.test(value)) throw new HttpError(400, 'INVALID_NAME', 'Names cannot be empty or contain slashes or control characters.');
    return value;
  };
  const fkey = folder => (folder === null || folder === undefined ? '' : String(folder));
  function forgetFile(folder, id) {
    db.prepare('DELETE FROM marks WHERE folder_key = ? AND file_id = ?').run(fkey(folder), Number(id));
    metaCache.delete(`${folder ?? 'saved'}:${id}`);
  }
  function moveMarks(fromFolder, id, toFolder, name) {
    db.prepare(`UPDATE OR REPLACE marks SET folder_key = ?, name = COALESCE(?, name) WHERE folder_key = ? AND file_id = ?`).run(fkey(toFolder), name ?? null, fkey(fromFolder), Number(id));
    metaCache.delete(`${fromFolder ?? 'saved'}:${id}`);
  }

  app.post('/api/drive/folders', authed, async request => {
    const name = nameField(request);
    try {
      const folder = await drive.call('/folders', { method: 'POST', body: { name } });
      audit.record('folder.created', { actor: request.session.username, ip: request.clientIp, detail: { name, id: folder?.id } });
      return folder;
    } catch (error) { throw driveError(error); }
  });

  app.patch('/api/drive/folders/:id', authed, async request => {
    const id = folderId(request.params.id);
    if (!id) throw new HttpError(400, 'INVALID_FOLDER_ID', 'Saved Messages cannot be renamed.');
    const name = nameField(request);
    try {
      await drive.call(`/folders/${id}`, { method: 'PATCH', body: { name } });
      audit.record('folder.renamed', { actor: request.session.username, ip: request.clientIp, detail: { id, name } });
      return { ok: true };
    } catch (error) { throw driveError(error); }
  });

  app.delete('/api/drive/folders/:id', authedSudo, async request => {
    const id = folderId(request.params.id);
    if (!id) throw new HttpError(400, 'INVALID_FOLDER_ID', 'Saved Messages cannot be deleted.');
    try {
      await drive.call(`/folders/${id}`, { method: 'DELETE' });
      db.prepare('DELETE FROM marks WHERE folder_key = ?').run(String(id));
      audit.record('folder.deleted', { severity: 'high', actor: request.session.username, ip: request.clientIp, detail: { id } });
      return { ok: true };
    } catch (error) { throw driveError(error); }
  });

  app.patch('/api/drive/files/:id', authed, async request => {
    const id = fileId(request.params.id);
    const source = optionalFolder(request.body?.source_folder_id);
    const patch = {};
    if (request.body?.name !== undefined) patch.name = nameField(request);
    const moving = request.body?.folder_id !== undefined;
    if (moving) patch.folder_id = optionalFolder(request.body.folder_id);
    if (!Object.keys(patch).length) throw new HttpError(400, 'INVALID_REQUEST', 'Nothing to change.');
    patch.source_folder_id = source;
    try {
      await drive.call(`/files/${id}`, { method: 'PATCH', body: patch, query: { folder_id: source ?? undefined } });
      moveMarks(source, id, moving ? patch.folder_id : source, patch.name);
      audit.record(moving ? 'file.moved' : 'file.renamed', { actor: request.session.username, ip: request.clientIp, detail: { file: id, from: source ?? 'saved', ...(moving ? { to: patch.folder_id ?? 'saved' } : {}), ...(patch.name ? { name: patch.name } : {}) } });
      return { ok: true };
    } catch (error) { throw driveError(error); }
  });

  app.post('/api/drive/files/:id/copy', authed, async request => {
    const id = fileId(request.params.id);
    const source = optionalFolder(request.body?.source_folder_id);
    const target = optionalFolder(request.body?.folder_id);
    try {
      await drive.call(`/files/${id}/copy`, { method: 'POST', body: { folder_id: target, source_folder_id: source }, query: { folder_id: source ?? undefined } });
      audit.record('file.copied', { actor: request.session.username, ip: request.clientIp, detail: { file: id, from: source ?? 'saved', to: target ?? 'saved' } });
      return { ok: true };
    } catch (error) { throw driveError(error); }
  });

  const bulkIds = request => {
    const ids = request.body?.file_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500) throw new HttpError(400, 'INVALID_REQUEST', 'Select between 1 and 500 files.');
    return ids.map(fileId).map(Number);
  };

  app.post('/api/drive/bulk/move', authed, async request => {
    const ids = bulkIds(request);
    const source = optionalFolder(request.body?.folder_id);
    const target = optionalFolder(request.body?.target_folder_id);
    try {
      const result = await drive.call('/files/bulk', { method: 'POST', body: { action: 'move', file_ids: ids, folder_id: source, payload: { folder_id: target } } });
      ids.forEach(id => moveMarks(source, id, target));
      audit.record('file.bulk_moved', { actor: request.session.username, ip: request.clientIp, detail: { count: ids.length, from: source ?? 'saved', to: target ?? 'saved' } });
      return result;
    } catch (error) { throw driveError(error); }
  });

  app.post('/api/drive/bulk/delete', authedSudo, async request => {
    const ids = bulkIds(request);
    const source = optionalFolder(request.body?.folder_id);
    try {
      const result = await drive.call('/files/bulk', { method: 'POST', body: { action: 'delete', file_ids: ids, folder_id: source } });
      ids.forEach(id => forgetFile(source, id));
      audit.record('file.bulk_deleted', { severity: 'high', actor: request.session.username, ip: request.clientIp, detail: { count: ids.length, folder: source ?? 'saved' } });
      return result;
    } catch (error) { throw driveError(error); }
  });

  app.post('/api/drive/bulk/archive', authed, async (request, reply) => {
    const ids = bulkIds(request);
    const source = optionalFolder(request.body?.folder_id);
    let upstream;
    try {
      ({ response: upstream } = await drive.stream('/files/bulk', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/zip' }, body: JSON.stringify({ action: 'archive', file_ids: ids, folder_id: source }), signal: disconnectSignal(reply), headerTimeoutMs: 600_000 }));
    } catch (error) { throw driveError(error); }
    if (!upstream.ok) throw driveError(Object.assign(new Error(`Drive API returned ${upstream.status}`), { status: upstream.status }));
    audit.record('file.archived', { actor: request.session.username, ip: request.clientIp, detail: { count: ids.length, folder: source ?? 'saved' } });
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="kurovault-${new Date().toISOString().slice(0, 10)}.zip"`);
    return pipeUpstream(reply, upstream);
  });

  app.get('/api/drive/insights/duplicates', authed, async () => {
    try { return { groups: await drive.call('/storage/duplicates', { timeout: 120_000 }) }; } catch (error) { throw driveError(error); }
  });
  app.get('/api/drive/insights/empty-folders', authed, async () => {
    try { return { folders: await drive.call('/folders/empty', { timeout: 120_000 }) }; } catch (error) { throw driveError(error); }
  });

  // ─── Direct Telegram source ─────────────────────────────────────────
  // When an account is connected, the same /api/drive/* routes are answered straight from Telegram.
  const tgHandlers = new Map();
  const prefetch = createPrefetcher({ dir: config.videoCacheDir, maxBytes: config.videoCacheBytes, log: (o, m) => app.log.info(o, m) });
  app.addHook('onClose', async () => prefetch.close());
  const tgHttp = error => (error instanceof HttpError ? error : error instanceof TgError ? new HttpError(error.status, error.code, error.message) : error);
  // Regular users only ever use their own Telegram; the admin may also use the desktop app.
  function useTg(request) { return request.tg.active() || !isAdmin(request); }
  async function tgDispatch(request, reply) {
    request.tg = tgFor(request.session.user_id);
    if (!request.url.startsWith('/api/drive/') || !useTg(request)) return undefined;
    await request.tg.ready();
    const method = request.method === 'HEAD' ? 'GET' : request.method;
    const handler = tgHandlers.get(`${method} ${request.routeOptions.url}`);
    if (!handler) return undefined;
    // Handlers that write the response themselves return SENT. They must never return `reply`:
    // Fastify's reply is "thenable", so awaiting it would wait for a stream to end (or be aborted
    // by a seek) and the result would then be sent a second time.
    let result;
    try { result = await handler(request, reply); } catch (error) {
      if (reply.raw.headersSent) { reply.raw.destroy(); return reply; }
      throw tgHttp(error);
    }
    if (result !== SENT && !reply.sent && !reply.raw.headersSent) reply.send(result);
    return reply;
  }
  const SENT = Symbol('sent');
  const on = (method, url, handler) => tgHandlers.set(`${method} ${url}`, handler);
  const actor = request => ({ actor: request.session.username, ip: request.clientIp });
  const where = folder => folder ?? 'saved';
  const sendBody = (reply, iterable) => {
    const stream = Readable.from(iterable, { objectMode: false });
    // A failure after the headers went out can only cut the response short: record why, for the server logs.
    stream.on('error', error => {
      if (reply.raw.destroyed && /abort|premature|ECONNRESET/i.test(String(error?.message))) return;
      reply.log.warn({ code: error?.code, msg: String(error?.message ?? error).slice(0, 300), url: reply.request.url.split('?')[0] }, 'stream interrupted');
    });
    return reply.send(stream);
  };
  const attachmentName = name => `attachment; filename*=UTF-8''${encodeURIComponent(String(name)).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16))}`;

  on('GET', '/api/drive/status', async request => ({ url: 'Telegram (direct)', ...request.tg.status(), mode: 'telegram', canUseDesktop: isAdmin(request) }));
  on('GET', '/api/drive/folders', async request => ({ folders: await request.tg.folders() }));
  on('GET', '/api/drive/files', async request => {
    const q = request.query ?? {};
    return request.tg.listFiles({
      folder_id: q.folder_id === 'home' ? 'home' : folderId(q.folder_id), page: q.page, limit: q.limit, refresh: q.refresh,
      search: typeof q.search === 'string' ? q.search.slice(0, 120) : undefined,
      sort: ['name', 'size', 'created_at'].includes(q.sort) ? q.sort : 'created_at', order: q.order === 'asc' ? 'asc' : 'desc',
      mime_type: ['video', 'audio', 'image', 'application/pdf'].includes(q.mime_type) ? q.mime_type : undefined,
    });
  });
  on('GET', '/api/drive/storage', async request => request.tg.storage());
  on('GET', '/api/drive/files/:id/download', async (request, reply) => {
    const id = fileId(request.params.id);
    const folder = folderId(request.query?.folder_id);
    const r = await request.tg.open(id, folder, { range: request.headers.range, signal: disconnectSignal(reply), purpose: 'download' });
    if (r.status === 416) { reply.code(416).header('Content-Range', r.headers['content-range']).send(); return SENT; }
    audit.record('drive.download', { ...actor(request), detail: { file: id, folder: where(folder), source: 'telegram' } });
    remember(request.session.user_id, 'recent', folder, r.file);
    reply.code(r.status);
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Disposition', attachmentName(r.file.name));
    reply.header('Accept-Ranges', 'bytes');
    for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    sendBody(reply, r.body);
    return SENT;
  });
  on('GET', '/api/drive/files/:id/stream', async (request, reply) => {
    const id = fileId(request.params.id);
    const folder = folderId(request.query?.folder_id);
    const range = String(request.headers.range ?? '');
    const variant = variantOf(request);
    // Prepared on the server already? Serve the part that is on disk at full speed.
    const cached = prefetch.job(prefKey(request, id, folder, variant));
    if (cached && cached.received > 0 && /^bytes=\d*-\d*$/.test(range) && inlineType({ name: cached.name, mime_type: cached.mime })) {
      const want = parseRange(range, cached.size);
      if (want.unsatisfiable) { reply.code(416).header('Content-Range', `bytes */${cached.size}`).send(); return SENT; }
      const hit = prefetch.read(prefKey(request, id, folder, variant), want.start, want.end);
      if (hit) {
        reply.code(206);
        reply.header('Content-Type', inlineType({ name: hit.name, mime_type: hit.mime }));
        reply.header('Content-Disposition', 'inline');
        reply.header('Accept-Ranges', 'bytes');
        reply.header('Content-Length', String(hit.end - hit.start + 1));
        reply.header('Content-Range', `bytes ${hit.start}-${hit.end}/${hit.size}`);
        reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
        reply.header('Cache-Control', 'private, no-store');
        reply.header('X-Kurovault-Source', 'prepared');
        sendBody(reply, hit.stream);
        return SENT;
      }
    }
    const r = await request.tg.open(id, folder, { range: /^bytes=\d*-\d*$/.test(range) ? range : undefined, signal: disconnectSignal(reply), purpose: 'stream', variant });
    if (r.status === 416) { reply.code(416).header('Content-Range', r.headers['content-range']).send(); return SENT; }
    const type = inlineType(r.file);
    if (!type && r.file.protected) throw new HttpError(403, 'PROTECTED_CONTENT', 'This chat has content protection and this file type cannot be previewed.');
    const auditKey = `${request.session.id_hash}:tg:${folder}:${id}`;
    if ((streamAudits.get(auditKey) ?? 0) < Date.now() - 10 * 60_000) {
      streamAudits.set(auditKey, Date.now());
      if (streamAudits.size > 5000) streamAudits.delete(streamAudits.keys().next().value);
      audit.record('drive.open', { ...actor(request), detail: { file: id, folder: where(folder), name: String(r.file.name).slice(0, 120), type: type ?? 'download', source: 'telegram' } });
      remember(request.session.user_id, 'recent', folder, r.file);
    }
    reply.code(r.status);
    reply.header('Content-Type', type ?? 'application/octet-stream');
    reply.header('Content-Disposition', type ? 'inline' : attachmentName(r.file.name));
    reply.header('Accept-Ranges', 'bytes');
    for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    reply.header('Cache-Control', 'private, no-store');
    sendBody(reply, r.body);
    return SENT;
  });
  // ─── Smooth playback: prepare a video on the server, then play it without buffering ───
  const variantOf = request => (/^\d{1,2}$/.test(String(request.query?.variant ?? '')) ? Number(request.query.variant) : null);
  const prefKey = (request, id, folder, variant) => `${request.session.user_id}:${folder ?? 'me'}:${id}:${variant ?? 'o'}`;
  on('POST', '/api/drive/files/:id/prepare', async request => {
    const id = fileId(request.params.id);
    const folder = folderId(request.query?.folder_id);
    const variant = variantOf(request);
    const svc = request.tg;
    const meta = await svc.meta(id, folder);
    const alt = variant === null ? null : (meta.variants ?? []).find(v => v.index === variant);
    if (variant !== null && !alt) throw new HttpError(404, 'NOT_FOUND', 'That video quality is not available.');
    const mime = alt ? alt.mime : meta.mime_type;
    if (!/^(video|audio)\//.test(mime) && !inlineType({ name: meta.name, mime_type: mime })?.startsWith('video/')) throw new HttpError(400, 'NOT_MEDIA', 'Only videos and audio can be prepared for playback.');
    let duration = null;
    try { duration = (await svc.mediaInfo(id, folder)).duration_secs ?? null; } catch { /* unknown length: wait for the whole file */ }
    const status = prefetch.start(prefKey(request, id, folder, variant), {
      owner: request.session.user_id, size: alt ? alt.size : meta.size, duration, mime, name: meta.name,
      open: async function* (signal) { const r = await svc.open(id, folder, { signal, purpose: 'stream', variant }); yield* r.body; },
    });
    if (status.state === 'downloading' && status.received === 0) audit.record('drive.prepare', { ...actor(request), detail: { file: id, folder: where(folder), name: String(meta.name).slice(0, 120), bytes: alt ? alt.size : meta.size } });
    return status;
  });
  on('GET', '/api/drive/files/:id/prepare', async request => prefetch.status(prefKey(request, fileId(request.params.id), folderId(request.query?.folder_id), variantOf(request))));
  on('DELETE', '/api/drive/files/:id/prepare', async request => {
    prefetch.cancel(prefKey(request, fileId(request.params.id), folderId(request.query?.folder_id), variantOf(request)));
    return { ok: true };
  });
  for (const method of ['get', 'post', 'delete']) {
    app[method]('/api/drive/files/:id/prepare', authed, async () => { throw new HttpError(400, 'NOT_AVAILABLE', 'Smooth playback preparation is for files streamed from Telegram.'); });
  }

  on('GET', '/api/drive/files/:id/thumbnail', async (request, reply) => {
    const body = await request.tg.thumbnail(fileId(request.params.id), folderId(request.query?.folder_id));
    if (!body || body.length > 5 * 1024 * 1024 || !(body[0] === 0xff && body[1] === 0xd8)) { reply.code(404).send({ error: { code: 'NO_THUMBNAIL', message: 'No thumbnail.' } }); return SENT; }
    reply.header('Cache-Control', 'private, max-age=600');
    reply.type('image/jpeg').send(body);
    return SENT;
  });
  on('GET', '/api/drive/files/:id/media-info', async request => request.tg.mediaInfo(fileId(request.params.id), folderId(request.query?.folder_id)));
  on('POST', '/api/drive/uploads/:id/complete', async request => {
    const row = uploadRow(request, request.params.id);
    if (row.received !== row.size) throw new HttpError(409, 'INCOMPLETE', `Only ${row.received} of ${row.size} bytes arrived.`);
    const file = join(uploadDir, `${row.id}.part`);
    const folder = row.folder_key || undefined;
    const result = await request.tg.upload(file, { name: row.name, size: row.size, folder });
    rmSync(file, { force: true });
    db.prepare('DELETE FROM uploads WHERE id = ?').run(row.id);
    audit.record('drive.upload', { ...actor(request), detail: { name: row.name, bytes: row.size, folder: where(folder), source: 'telegram' } });
    return result;
  });
  on('DELETE', '/api/drive/files/:id', async request => {
    const id = fileId(request.params.id);
    const folder = folderId(request.query?.folder_id);
    await request.tg.deleteFiles([Number(id)], folder);
    forgetFile(folder, id);
    audit.record('drive.delete', { severity: 'high', ...actor(request), detail: { file: id, folder: where(folder), source: 'telegram' } });
    return { ok: true };
  });
  on('POST', '/api/drive/folders', async request => {
    const name = nameField(request);
    const folder = await request.tg.createFolder(name);
    audit.record('folder.created', { ...actor(request), detail: { name, id: folder.id, source: 'telegram' } });
    return folder;
  });
  on('PATCH', '/api/drive/folders/:id', async request => {
    const id = folderId(request.params.id);
    if (!id) throw new HttpError(400, 'INVALID_FOLDER_ID', 'Saved Messages cannot be renamed.');
    const name = nameField(request);
    await request.tg.renameFolder(id, name);
    audit.record('folder.renamed', { ...actor(request), detail: { id, name, source: 'telegram' } });
    return { ok: true };
  });
  on('DELETE', '/api/drive/folders/:id', async request => {
    const id = folderId(request.params.id);
    if (!id) throw new HttpError(400, 'INVALID_FOLDER_ID', 'Saved Messages cannot be deleted.');
    await request.tg.deleteFolder(id);
    db.prepare('DELETE FROM marks WHERE folder_key = ?').run(String(id));
    audit.record('folder.deleted', { severity: 'high', ...actor(request), detail: { id, source: 'telegram' } });
    return { ok: true };
  });
  on('PATCH', '/api/drive/files/:id', async request => {
    const id = fileId(request.params.id);
    const source = optionalFolder(request.body?.source_folder_id);
    const name = request.body?.name !== undefined ? nameField(request) : undefined;
    const moving = request.body?.folder_id !== undefined;
    if (!name && !moving) throw new HttpError(400, 'INVALID_REQUEST', 'Nothing to change.');
    if (name) request.tg.renameFile(id, source ?? undefined, name);
    const target = moving ? optionalFolder(request.body.folder_id) : source;
    if (moving) await request.tg.moveFiles([Number(id)], source ?? undefined, target ?? undefined);
    moveMarks(source, id, target, name);
    audit.record(moving ? 'file.moved' : 'file.renamed', { ...actor(request), detail: { file: id, from: where(source), ...(moving ? { to: where(target) } : {}), ...(name ? { name } : {}), source: 'telegram' } });
    return { ok: true };
  });
  on('POST', '/api/drive/files/:id/copy', async request => {
    const id = fileId(request.params.id);
    const source = optionalFolder(request.body?.source_folder_id);
    const target = optionalFolder(request.body?.folder_id);
    await request.tg.copyFiles([Number(id)], source ?? undefined, target ?? undefined);
    audit.record('file.copied', { ...actor(request), detail: { file: id, from: where(source), to: where(target), source: 'telegram' } });
    return { ok: true };
  });
  on('POST', '/api/drive/bulk/move', async request => {
    const ids = bulkIds(request);
    const source = optionalFolder(request.body?.folder_id);
    const target = optionalFolder(request.body?.target_folder_id);
    const result = await request.tg.moveFiles(ids, source ?? undefined, target ?? undefined);
    ids.forEach(id => moveMarks(source, id, target));
    audit.record('file.bulk_moved', { ...actor(request), detail: { count: ids.length, from: where(source), to: where(target), source: 'telegram' } });
    return result;
  });
  on('POST', '/api/drive/bulk/delete', async request => {
    const ids = bulkIds(request);
    const source = optionalFolder(request.body?.folder_id);
    const result = await request.tg.deleteFiles(ids, source ?? undefined);
    ids.forEach(id => forgetFile(source, id));
    audit.record('file.bulk_deleted', { severity: 'high', ...actor(request), detail: { count: ids.length, folder: where(source), source: 'telegram' } });
    return result;
  });
  on('POST', '/api/drive/bulk/archive', async (request, reply) => {
    const ids = bulkIds(request);
    const source = optionalFolder(request.body?.folder_id);
    const zip = await request.tg.archive(ids, source ?? undefined, disconnectSignal(reply));
    audit.record('file.archived', { ...actor(request), detail: { count: ids.length, folder: where(source), source: 'telegram' } });
    reply.header('Content-Type', 'application/zip');
    reply.header('Content-Disposition', `attachment; filename="kurovault-${new Date().toISOString().slice(0, 10)}.zip"`);
    sendBody(reply, zip);
    return SENT;
  });
  on('GET', '/api/drive/insights/duplicates', async request => ({ groups: await request.tg.duplicates() }));
  on('GET', '/api/drive/insights/empty-folders', async request => ({ folders: await request.tg.emptyFolders() }));

  // Account linking. The API hash and the session string are sealed with AES-256-GCM and never leave the server.
  const tgRoute = handler => async (request, reply) => { try { return await handler(request, reply); } catch (error) { throw tgHttp(error); } };
  const apiCreds = request => {
    // Reconnecting needs only a phone number: use the API ID/hash this person saved before,
    // or the server-wide app (TDC_TELEGRAM_API_ID/HASH).
    if (!request.body?.apiId) {
      const saved = request.tg.savedCredentials();
      if (saved) return saved;
      if (config.telegramApiId && config.telegramApiHash) return { apiId: config.telegramApiId, apiHash: config.telegramApiHash };
    }
    const apiId = String(request.body?.apiId ?? '').trim();
    const apiHash = String(request.body?.apiHash ?? '').trim().toLowerCase();
    if (!/^\d{3,12}$/.test(apiId)) throw new HttpError(400, 'INVALID_API_ID', 'The API ID is the number shown on my.telegram.org → API development tools.');
    if (!/^[0-9a-f]{32}$/.test(apiHash)) throw new HttpError(400, 'INVALID_API_HASH', 'The API hash is the 32-character code shown on my.telegram.org.');
    return { apiId, apiHash };
  };
  const tgLimit = request => {
    const hit = authLimiter.hit(`tg:${request.session.user_id}`);
    if (!hit.allowed) throw new HttpError(429, 'RATE_LIMITED', 'Too many Telegram sign-in attempts. Wait a minute.');
  };
  const loginFailed = (request, error) => {
    audit.record('telegram.login_failed', { severity: 'medium', ...actor(request), detail: { code: error.code ?? 'ERROR' } });
    return error;
  };
  const qrImage = async url => `data:image/svg+xml;base64,${Buffer.from(await QRCode.toString(url, { type: 'svg', margin: 1, color: { dark: '#fafafa', light: '#0a0a0b' } })).toString('base64')}`;

  app.get('/api/telegram/state', authed, async request => {
    await request.tg.ready();
    return { mode: request.tg.mode(), connected: request.tg.connected(), ...request.tg.status(), adapter: config.telegramAdapter, serverCredentials: Boolean(config.telegramApiId && config.telegramApiHash), canUseDesktop: isAdmin(request) };
  });
  app.post('/api/telegram/login/start', authedSudo, tgRoute(async request => {
    tgLimit(request);
    const creds = apiCreds(request);
    const phone = String(request.body?.phone ?? '').replace(/[\s()-]/g, '');
    if (!/^\+?\d{7,15}$/.test(phone)) throw new HttpError(400, 'INVALID_PHONE', 'Enter the phone number in international format, e.g. +44 7700 900123.');
    try { return await request.tg.loginStart(request.session.user_id, { ...creds, phone: phone.startsWith('+') ? phone : `+${phone}` }); } catch (e) { throw loginFailed(request, e); }
  }));
  app.post('/api/telegram/login/code', authedSudo, tgRoute(async request => {
    tgLimit(request);
    const code = String(request.body?.code ?? '').replace(/\D/g, '');
    if (code.length < 4 || code.length > 8) throw new HttpError(400, 'INVALID_CODE', 'Enter the login code Telegram sent you.');
    try { return await request.tg.loginCode(request.session.user_id, code, request.session.username, request.clientIp); } catch (e) { throw loginFailed(request, e); }
  }));
  app.post('/api/telegram/login/password', authedSudo, tgRoute(async request => {
    tgLimit(request);
    const password = body(request, 'password', { max: 256 });
    try { return await request.tg.loginPassword(request.session.user_id, password, request.session.username, request.clientIp); } catch (e) { throw loginFailed(request, e); }
  }));
  app.post('/api/telegram/login/qr', authedSudo, tgRoute(async request => {
    tgLimit(request);
    try {
      const r = await request.tg.qrStart(request.session.user_id, apiCreds(request), request.session.username, request.clientIp);
      return { ...r, qr: await qrImage(r.url) };
    } catch (e) { throw loginFailed(request, e); }
  }));
  app.get('/api/telegram/login/qr', authed, tgRoute(async request => {
    const r = request.tg.qrStatus(request.session.user_id);
    return { ...r, url: undefined, qr: r.url && r.step === 'waiting' ? await qrImage(r.url) : null };
  }));
  app.post('/api/telegram/login/cancel', authed, async request => { request.tg.cancelLogin(request.session.user_id); return { ok: true }; });
  app.post('/api/telegram/logout', authedSudo, tgRoute(async request => {
    await request.tg.logout(request.session.username, request.clientIp);
    metaCache.clear();
    return { ok: true };
  }));
  app.post('/api/telegram/forget-app', authed, tgRoute(async request => {
    request.tg.forgetCredentials();
    audit.record('telegram.app_forgotten', { ...actor(request) });
    return { ok: true };
  }));

  app.post('/api/telegram/mode', authedSudo, tgRoute(async request => {
    const mode = request.body?.mode;
    if (!['desktop', 'telegram'].includes(mode)) throw new HttpError(400, 'INVALID_MODE', 'Mode must be desktop or telegram.');
    await request.tg.setMode(mode);
    metaCache.clear();
    audit.record('drive.source_changed', { severity: 'high', ...actor(request), detail: { mode } });
    return { ok: true, mode };
  }));
  app.get('/api/telegram/account', authed, tgRoute(async request => request.tg.account()));
  app.post('/api/telegram/sessions/terminate', authedSudo, tgRoute(async request => {
    const hash = String(request.body?.hash ?? '');
    if (!/^-?\d{1,20}$/.test(hash)) throw new HttpError(400, 'INVALID_SESSION', 'Invalid session.');
    const target = await request.tg.terminateSession(hash);
    audit.record('telegram.session_terminated', { severity: 'high', ...actor(request), detail: { device: target.device, app: target.app, ip: target.ip, country: target.country } });
    return { ok: true };
  }));
  app.get('/api/telegram/chats', authed, tgRoute(async request => ({ chats: await request.tg.availableChats() })));
  app.post('/api/telegram/folders', authed, tgRoute(async request => {
    const id = folderId(String(request.body?.id ?? ''));
    if (!id) throw new HttpError(400, 'INVALID_FOLDER_ID', 'Pick a chat.');
    const folder = await request.tg.addFolder(id);
    audit.record('folder.linked', { ...actor(request), detail: { id, name: folder.name } });
    return folder;
  }));
  app.delete('/api/telegram/folders/:id', authed, tgRoute(async request => {
    const id = folderId(request.params.id);
    if (!id) throw new HttpError(400, 'INVALID_FOLDER_ID', 'Saved Messages is always shown.');
    request.tg.removeFolder(id);
    audit.record('folder.unlinked', { ...actor(request), detail: { id } });
    return { ok: true };
  }));

  // ─── Archives (ZIP / RAR): browse and play what is inside ─────────────
  // Reads the archive from whichever source is active (Telegram directly or the desktop app) by byte range.
  async function* readSource(ref, start, end, signal) {
    if (ref.tg) {
      const r = await ref.tg.open(ref.id, ref.folder, { range: `bytes=${start}-${end}`, signal, purpose: 'stream' });
      yield* r.body;
      return;
    }
    let response;
    try { ({ response } = await drive.stream(`/files/${ref.id}/download`, { query: { folder_id: ref.folder }, headers: { Range: `bytes=${start}-${end}` }, signal })); } catch (error) { throw driveError(error); }
    if (!response.ok) throw driveError(Object.assign(new Error(`Drive API returned ${response.status}`), { status: response.status }));
    // A server that ignores Range sends the whole file: skip to the window ourselves.
    let skip = response.status === 206 ? 0 : start;
    let left = end - start + 1;
    const body = Readable.fromWeb(response.body);
    try {
      for await (const raw of body) {
        let c = raw;
        if (skip) { if (c.length <= skip) { skip -= c.length; continue; } c = c.subarray(skip); skip = 0; }
        if (c.length > left) c = c.subarray(0, left);
        left -= c.length;
        yield c;
        if (left <= 0) return;
      }
    } finally { body.destroy(); }
  }
  const archives = createArchiveService({ config, source: { read: readSource } });
  const archiveHttp = error => (error instanceof ArchiveError ? new HttpError(error.status, error.code, error.message) : tgHttp(error));
  async function archiveRef(request) {
    const id = fileId(request.params.id);
    const folder = folderId(request.query?.folder_id);
    let meta;
    const svc = useTg(request) ? request.tg : null;
    if (svc) await svc.ready();
    try { meta = await fileMeta(id, folder, svc ? request : null); } catch (error) { throw svc ? tgHttp(error) : driveError(error); }
    if (meta.encrypted) throw new HttpError(409, 'ENCRYPTED', 'This file is end-to-end encrypted by Telegram Drive. Open it in the desktop app.');
    return { id, folder, size: Number(meta.size), name: String(meta.name), protected: Boolean(meta.protected), tg: svc, key: `${svc ? `tg:${request.session.user_id}` : 'desktop'}:${folder ?? 'saved'}:${id}:${meta.created_at ?? ''}` };
  }
  const entryIndex = value => {
    if (!/^\d{1,6}$/.test(String(value))) throw new HttpError(400, 'INVALID_ENTRY', 'Invalid archive entry.');
    return Number(value);
  };
  const archiveAudits = new Map();

  app.get('/api/archive/:id', authed, async (request, reply) => {
    const ref = await archiveRef(request);
    let r;
    try { r = await archives.list(ref); } catch (error) { throw archiveHttp(error); }
    if (r.pending) return reply.code(202).send({ pending: true, kind: r.kind, received: r.received, size: r.size });
    const auditKey = `${request.session.id_hash}:${ref.key}`;
    if ((archiveAudits.get(auditKey) ?? 0) < Date.now() - 10 * 60_000) {
      archiveAudits.set(auditKey, Date.now());
      if (archiveAudits.size > 2000) archiveAudits.delete(archiveAudits.keys().next().value);
      audit.record('archive.opened', { ...actor(request), detail: { file: ref.id, folder: where(ref.folder), name: ref.name.slice(0, 120), kind: r.kind, entries: r.entries.length } });
      remember(request.session.user_id, 'recent', ref.folder, { id: ref.id, name: ref.name, mime_type: r.kind === 'zip' ? 'application/zip' : 'application/vnd.rar', size: ref.size, created_at: '' });
    }
    return { kind: r.kind, name: ref.name, protected: ref.protected, entries: r.entries.map(archives.publicEntry) };
  });

  async function sendEntry(request, reply, download) {
    const ref = await archiveRef(request);
    const index = entryIndex(request.params.index);
    if (download && ref.protected) throw new HttpError(403, 'PROTECTED_CONTENT', 'This archive is from a protected chat: you can open its files here, but not download them.');
    const range = String(request.headers.range ?? '');
    let r;
    try { r = await archives.openEntry(ref, index, { range: /^bytes=\d*-\d*$/.test(range) ? range : undefined, signal: disconnectSignal(reply) }); } catch (error) { throw archiveHttp(error); }
    if (r.status === 416) return reply.code(416).header('Content-Range', r.headers['content-range']).send();
    const name = r.entry.path.split('/').pop() || `file-${index}`;
    const type = download ? null : inlineType({ name, mime_type: '' });
    if (!download && !type && ref.protected) throw new HttpError(403, 'PROTECTED_CONTENT', 'This archive is from a protected chat and this file type cannot be previewed.');
    if (download || r.status !== 206 || (r.headers['content-range'] ?? '').startsWith('bytes 0-')) {
      const auditKey = `${request.session.id_hash}:${ref.key}:${index}:${download}`;
      if ((archiveAudits.get(auditKey) ?? 0) < Date.now() - 10 * 60_000) {
        archiveAudits.set(auditKey, Date.now());
        audit.record(download ? 'archive.extracted' : 'archive.entry_opened', { ...actor(request), detail: { file: ref.id, folder: where(ref.folder), archive: ref.name.slice(0, 120), entry: r.entry.path.slice(0, 200) } });
      }
    }
    reply.code(r.status);
    reply.header('Content-Type', type ?? 'application/octet-stream');
    reply.header('Content-Disposition', type ? 'inline' : attachmentName(name));
    reply.header('Accept-Ranges', 'bytes');
    for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
    reply.header('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'");
    reply.header('Cache-Control', 'private, no-store');
    return sendBody(reply, r.body);
  }
  app.get('/api/archive/:id/entries/:index/stream', authed, (request, reply) => sendEntry(request, reply, false));
  app.get('/api/archive/:id/entries/:index/download', authed, (request, reply) => sendEntry(request, reply, true));

  // Favorites, pins and recents live in Kurovault (the desktop app does not expose its own lists).
  function remember(userId, kind, folder, meta) {
    db.prepare(`INSERT INTO marks(user_id, kind, folder_key, file_id, name, mime_type, size, created_at, encrypted, added_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, kind, folder_key, file_id) DO UPDATE SET name = excluded.name, mime_type = excluded.mime_type, size = excluded.size, added_at = excluded.added_at`)
      .run(userId, kind, folder ? String(folder) : '', Number(meta.id), String(meta.name).slice(0, 300), String(meta.mime_type ?? ''), Number(meta.size) || 0, String(meta.created_at ?? ''), meta.encrypted ? 1 : 0, Date.now());
    if (kind === 'recent') {
      db.prepare(`DELETE FROM marks WHERE user_id = ? AND kind = 'recent' AND rowid NOT IN (SELECT rowid FROM marks WHERE user_id = ? AND kind = 'recent' ORDER BY added_at DESC LIMIT 100)`).run(userId, userId);
    }
  }
  const markKind = value => {
    if (!['favorite', 'pin', 'recent'].includes(value)) throw new HttpError(400, 'INVALID_KIND', 'Unknown list.');
    return value;
  };

  app.get('/api/vault/marks', authed, async request => {
    const kind = markKind(request.query?.kind);
    const rows = db.prepare('SELECT * FROM marks WHERE user_id = ? AND kind = ? ORDER BY added_at DESC LIMIT 500').all(request.session.user_id, kind);
    return { files: rows.map(r => ({ id: r.file_id, folder_id: r.folder_key === '' ? null : Number(r.folder_key), name: r.name, mime_type: r.mime_type, size: r.size, created_at: r.created_at, encrypted: Boolean(r.encrypted), marked_at: r.added_at })) };
  });

  app.get('/api/vault/marks/index', authed, async request => {
    const rows = db.prepare("SELECT kind, folder_key, file_id FROM marks WHERE user_id = ? AND kind IN ('favorite','pin')").all(request.session.user_id);
    return { favorite: rows.filter(r => r.kind === 'favorite').map(r => `${r.folder_key}:${r.file_id}`), pin: rows.filter(r => r.kind === 'pin').map(r => `${r.folder_key}:${r.file_id}`) };
  });

  app.put('/api/vault/marks', authed, async request => {
    const kind = markKind(request.body?.kind);
    if (kind === 'recent') throw new HttpError(400, 'INVALID_KIND', 'Recents are recorded automatically.');
    const id = fileId(request.body?.id);
    const folder = folderId(request.body?.folder_id ?? undefined);
    let meta;
    if (useTg(request)) await request.tg.ready();
    try { meta = await fileMeta(id, folder, request); } catch (error) { throw useTg(request) ? tgHttp(error) : driveError(error); }
    remember(request.session.user_id, kind, folder, meta);
    return { ok: true };
  });

  app.delete('/api/vault/marks', authed, async request => {
    const kind = markKind(request.body?.kind);
    const id = Number(fileId(request.body?.id));
    const folder = folderId(request.body?.folder_id ?? undefined);
    db.prepare('DELETE FROM marks WHERE user_id = ? AND kind = ? AND folder_key = ? AND file_id = ?').run(request.session.user_id, kind, fkey(folder), id);
    return { ok: true };
  });

  // ─── UI ─────────────────────────────────────────────────────────────
  function sendStatic(request, reply) {
    if (request.method !== 'GET' && request.method !== 'HEAD') return reply.code(405).send({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } });
    const path = request.url.split('?')[0];
    const file = staticFiles.get(path) ?? (path.startsWith('/assets/') || extname(path) ? null : staticFiles.get('/index.html'));
    if (!file) return reply.code(404).type('text/plain').send('Not found');
    reply.header('Cache-Control', path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-store');
    return reply.type(file.type).send(file.body);
  }
  app.get('/', sendStatic);
  app.get('/robots.txt', (request, reply) => reply.type('text/plain').header('Cache-Control', 'public, max-age=86400').send('User-agent: *\nDisallow: /\n'));

  audit.record('server.start', { detail: { version: VERSION, host: config.host, port: config.port, tls: config.tls } });
  app.adminReady = adminExists;
  return app;
}

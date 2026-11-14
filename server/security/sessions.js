// Opaque 256-bit session tokens. Only a SHA-256 of the token is stored, so a
// database leak does not yield usable sessions. Sessions stay signed in while used
// (sliding expiry, TDC_SESSION_DAYS) and end only on sign-out, revocation or long disuse.
import { randomBytes } from 'node:crypto';
import { sha256 } from './vault.js';

export function cookieName(secure) {
  return secure ? '__Host-tdc_session' : 'tdc_session';
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (name && !(name in out)) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function serializeCookie(name, value, { secure, maxAgeSeconds }) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (secure) parts.push('Secure');
  if (maxAgeSeconds !== undefined) parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

export function createSessionStore(db, config) {
  const lifetimeMs = config.sessionDays * 86_400_000;

  return {
    lifetimeSeconds: Math.floor(lifetimeMs / 1000),
    create(userId, ip, ua) {
      const token = randomBytes(32).toString('base64url');
      const now = Date.now();
      const csrf = randomBytes(32).toString('base64url');
      db.prepare(`INSERT INTO sessions(id_hash, user_id, csrf, created_at, last_seen, expires_at, ip, last_ip, ua, ua_hash)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sha256(token), userId, csrf, now, now, now + lifetimeMs, ip, ip, String(ua).slice(0, 300), sha256(String(ua)));
      return { token, csrf };
    },

    /** Returns { session, problem } — problem is set when a token was presented but rejected. */
    resolve(token, ip, ua) {
      if (!token || token.length > 100) return { session: null, problem: token ? 'malformed' : null };
      const idHash = sha256(token);
      const row = db.prepare(`SELECT s.*, u.username, u.role, u.display_name, u.disabled_at FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`).get(idHash);
      const now = Date.now();
      if (!row) return { session: null, problem: 'unknown' };
      if (row.revoked_at) return { session: null, problem: 'revoked' };
      if (row.disabled_at) return { session: null, problem: 'disabled' };
      if (row.expires_at <= now) return { session: null, problem: 'expired' };
      // Sliding expiry: every visit pushes the end date out again (written at most once a minute).
      const slide = now - row.last_seen > 60_000 || row.last_ip !== ip;
      if (slide) db.prepare('UPDATE sessions SET last_seen = ?, last_ip = ?, expires_at = ?, ua = ? WHERE id_hash = ?').run(now, ip, now + lifetimeMs, String(ua).slice(0, 300), idHash);
      return { session: { ...row, last_seen: now, ipChanged: row.last_ip !== ip, previousIp: row.last_ip, slid: slide }, problem: null };
    },

    revoke(idHash, reason) {
      db.prepare('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE id_hash = ? AND revoked_at IS NULL').run(Date.now(), reason, idHash);
    },

    revokeAllForUser(userId, reason, exceptIdHash = '') {
      return db.prepare('UPDATE sessions SET revoked_at = ?, revoke_reason = ? WHERE user_id = ? AND revoked_at IS NULL AND id_hash != ?')
        .run(Date.now(), reason, userId, exceptIdHash).changes;
    },

    forUser(userId) {
      return db.prepare(`SELECT id_hash, created_at, last_seen, ip, last_ip, ua FROM sessions
        WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ? ORDER BY last_seen DESC`).all(userId, Date.now());
    },

    active() {
      const now = Date.now();
      return db.prepare(`SELECT s.id_hash, s.user_id, u.username, u.display_name, u.role, s.created_at, s.last_seen, s.expires_at, s.ip, s.last_ip, s.ua
        FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.revoked_at IS NULL AND s.expires_at > ? ORDER BY s.last_seen DESC`).all(now);
    },
  };
}

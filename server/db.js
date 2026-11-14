// SQLite store (node:sqlite). WAL mode, foreign keys, strict schema.
import { chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  pw_hash TEXT NOT NULL,
  totp_secret TEXT,
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  totp_last_step INTEGER NOT NULL DEFAULT 0,
  role TEXT NOT NULL DEFAULT 'user',
  display_name TEXT NOT NULL DEFAULT '',
  failed_count INTEGER NOT NULL DEFAULT 0,
  lock_level INTEGER NOT NULL DEFAULT 0,
  locked_until INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  password_changed_at INTEGER NOT NULL,
  last_login_at INTEGER,
  last_login_ip TEXT
) STRICT;

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  sudo_until INTEGER NOT NULL DEFAULT 0,
  ip TEXT NOT NULL,
  last_ip TEXT NOT NULL,
  ua TEXT NOT NULL,
  ua_hash TEXT NOT NULL,
  revoked_at INTEGER,
  revoke_reason TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS login_attempts (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  ip TEXT NOT NULL,
  username TEXT,
  ua TEXT NOT NULL,
  result TEXT NOT NULL,
  stage TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS login_attempts_ts ON login_attempts(ts);
CREATE INDEX IF NOT EXISTS login_attempts_ip ON login_attempts(ip, ts);

CREATE TABLE IF NOT EXISTS visits (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  ip TEXT NOT NULL,
  method TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  ua TEXT NOT NULL,
  user_id INTEGER
) STRICT;
CREATE INDEX IF NOT EXISTS visits_ts ON visits(ts);
CREATE INDEX IF NOT EXISTS visits_ip ON visits(ip, ts);

CREATE TABLE IF NOT EXISTS ip_blocks (
  ip TEXT PRIMARY KEY,
  until INTEGER NOT NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  created_by TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  severity TEXT NOT NULL,
  actor TEXT NOT NULL,
  ip TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS audit_ts ON audit(ts);

CREATE TABLE IF NOT EXISTS marks (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  folder_key TEXT NOT NULL,
  file_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  encrypted INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, kind, folder_key, file_id)
) STRICT;

CREATE TABLE IF NOT EXISTS uploads (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  folder_key TEXT NOT NULL,
  size INTEGER NOT NULL,
  chunk_size INTEGER NOT NULL,
  next_index INTEGER NOT NULL DEFAULT 0,
  received INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;
`;

export function openDatabase(dataDir) {
  const file = join(dataDir, 'console.db');
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  // Upgrades for databases created by earlier versions.
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map(c => c.name));
  if (!cols.has('display_name')) db.exec("ALTER TABLE users ADD COLUMN display_name TEXT NOT NULL DEFAULT ''");
  if (!cols.has('disabled_at')) db.exec('ALTER TABLE users ADD COLUMN disabled_at INTEGER NOT NULL DEFAULT 0');
  // The username "admin" is the only administrator; everyone else is a regular user.
  db.exec("UPDATE users SET role = CASE WHEN lower(username) = 'admin' THEN 'admin' ELSE 'user' END");
  for (const suffix of ['', '-wal', '-shm']) {
    try { chmodSync(file + suffix, 0o600); } catch { /* created lazily / non-POSIX */ }
  }
  db.file = file;
  return db;
}

export function getSetting(db, key) {
  return db.prepare('SELECT value FROM settings WHERE key = ?').get(key)?.value ?? null;
}

export function setSetting(db, key, value) {
  if (value === null) db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  else db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
}

/** Bounded retention so the logs cannot grow without limit. */
export function prune(db, retentionDays) {
  const cutoff = Date.now() - retentionDays * 86_400_000;
  db.prepare('DELETE FROM visits WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM login_attempts WHERE ts < ?').run(cutoff);
  db.prepare('DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)').run(Date.now() - 86_400_000, cutoff);
  db.prepare('DELETE FROM ip_blocks WHERE until < ?').run(Date.now());
  // Keep at most 500k visit rows even inside the retention window.
  db.prepare('DELETE FROM visits WHERE id <= (SELECT id FROM visits ORDER BY id DESC LIMIT 1 OFFSET 500000)').run();
}

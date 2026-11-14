// Sliding-window limiter (in memory) + persistent IP blocks and account lockouts (SQLite).
export class SlidingWindow {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  /** Records a hit; returns { allowed, remaining, retryAfterMs }. */
  hit(key, now = Date.now()) {
    const list = (this.hits.get(key) ?? []).filter(t => now - t < this.windowMs);
    if (list.length >= this.limit) {
      this.hits.set(key, list);
      return { allowed: false, remaining: 0, retryAfterMs: this.windowMs - (now - list[0]) };
    }
    list.push(now);
    this.hits.set(key, list);
    return { allowed: true, remaining: this.limit - list.length, retryAfterMs: 0 };
  }
  sweep(now = Date.now()) {
    for (const [key, list] of this.hits) {
      const kept = list.filter(t => now - t < this.windowMs);
      if (kept.length) this.hits.set(key, kept);
      else this.hits.delete(key);
    }
  }
}

export function createBlocklist(db) {
  const get = db.prepare('SELECT * FROM ip_blocks WHERE ip = ? AND until > ?');
  const bump = db.prepare('UPDATE ip_blocks SET hits = hits + 1 WHERE ip = ?');
  const upsert = db.prepare(`INSERT INTO ip_blocks(ip, until, reason, created_at, created_by, hits) VALUES(?, ?, ?, ?, ?, 0)
    ON CONFLICT(ip) DO UPDATE SET until = excluded.until, reason = excluded.reason, created_at = excluded.created_at, created_by = excluded.created_by`);
  const remove = db.prepare('DELETE FROM ip_blocks WHERE ip = ?');
  return {
    check(ip) {
      const row = get.get(ip, Date.now());
      if (row) bump.run(ip);
      return row ?? null;
    },
    block(ip, minutes, reason, by = 'system') {
      upsert.run(ip, Date.now() + minutes * 60_000, reason, Date.now(), by);
    },
    unblock(ip) {
      return remove.run(ip).changes > 0;
    },
    list() {
      return db.prepare('SELECT * FROM ip_blocks WHERE until > ? ORDER BY created_at DESC').all(Date.now());
    },
  };
}

/** Progressive account lock: 15 min, then 30, 60 … capped at 24 h. */
export function lockMinutesForLevel(level) {
  return Math.min(15 * 2 ** Math.max(0, level), 24 * 60);
}

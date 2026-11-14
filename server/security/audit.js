// Append-only audit trail. Every row carries an HMAC over its contents and the
// previous row's hash, so editing or deleting any row breaks the chain.
import { createHmac } from 'node:crypto';

const GENESIS = '0'.repeat(64);

function rowHash(key, row) {
  const canonical = JSON.stringify([row.id, row.ts, row.severity, row.actor, row.ip, row.action, row.detail, row.prev_hash]);
  return createHmac('sha256', key).update(canonical).digest('hex');
}

export function createAudit(db, key) {
  const lastStmt = db.prepare('SELECT id, hash FROM audit ORDER BY id DESC LIMIT 1');
  const insert = db.prepare('INSERT INTO audit(id, ts, severity, actor, ip, action, detail, prev_hash, hash) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)');

  function record(action, { severity = 'info', actor = 'system', ip = '-', detail = {} } = {}) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const last = lastStmt.get();
      const row = {
        id: (last?.id ?? 0) + 1,
        ts: Date.now(),
        severity,
        actor: String(actor).slice(0, 120),
        ip: String(ip).slice(0, 64),
        action: String(action).slice(0, 80),
        detail: JSON.stringify(detail).slice(0, 4000),
        prev_hash: last?.hash ?? GENESIS,
      };
      row.hash = rowHash(key, row);
      insert.run(row.id, row.ts, row.severity, row.actor, row.ip, row.action, row.detail, row.prev_hash, row.hash);
      db.exec('COMMIT');
      return row;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function verify() {
    let prev = GENESIS;
    let expectedId = null;
    let count = 0;
    for (const row of db.prepare('SELECT * FROM audit ORDER BY id').iterate()) {
      if (expectedId !== null && row.id !== expectedId) return { ok: false, count, brokenAt: row.id, reason: 'gap in sequence (row deleted)' };
      if (row.prev_hash !== prev) return { ok: false, count, brokenAt: row.id, reason: 'previous-hash mismatch' };
      if (rowHash(key, row) !== row.hash) return { ok: false, count, brokenAt: row.id, reason: 'row contents altered' };
      prev = row.hash;
      expectedId = row.id + 1;
      count += 1;
    }
    return { ok: true, count, head: prev };
  }

  return { record, verify };
}

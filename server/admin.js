// Break-glass administration from the server shell (requires access to the host).
//   npm run admin -- unblock <ip>
//   npm run admin -- unlock <username>
//   npm run admin -- set-password <username>      (reads the new password from TDC_NEW_PASSWORD)
//   npm run admin -- verify-audit
//   npm run admin -- blocks
import { loadConfig } from './config.js';
import { openDatabase } from './db.js';
import { createAudit } from './security/audit.js';
import { createBlocklist } from './security/ratelimit.js';
import { hashPassword, passwordProblems } from './security/passwords.js';

const [command, arg] = process.argv.slice(2);
const config = loadConfig();
const db = openDatabase(config.dataDir);
const audit = createAudit(db, config.secrets.auditKey);
const blocklist = createBlocklist(db);
const done = (msg, code = 0) => { console.log(msg); db.close(); process.exit(code); };

switch (command) {
  case 'unblock':
    if (!arg) done('usage: unblock <ip>', 1);
    done(blocklist.unblock(arg) ? (audit.record('ip.unblocked', { severity: 'medium', actor: 'cli', detail: { target: arg } }), `Unblocked ${arg}`) : `${arg} was not blocked`);
    break;
  case 'blocks':
    done(JSON.stringify(blocklist.list(), null, 2));
    break;
  case 'unlock': {
    const r = db.prepare('UPDATE users SET locked_until = 0, failed_count = 0 WHERE username = ?').run(arg ?? '');
    if (r.changes) audit.record('account.unlocked', { severity: 'medium', actor: 'cli', detail: { username: arg } });
    done(r.changes ? `Unlocked ${arg}` : `No user ${arg}`, r.changes ? 0 : 1);
    break;
  }
  case 'set-password': {
    const user = db.prepare('SELECT id, username, role FROM users WHERE username = ?').get(arg ?? '');
    if (!user) done(`No user ${arg}`, 1);
    const next = process.env.TDC_NEW_PASSWORD ?? '';
    const problems = passwordProblems(next, user.username, { min: user.role === 'admin' ? 12 : 8 });
    if (problems.length) done(`Set TDC_NEW_PASSWORD to the new password first. ${problems.join(' ')}`, 1);
    db.prepare('UPDATE users SET pw_hash = ?, password_changed_at = ?, locked_until = 0, failed_count = 0 WHERE id = ?').run(await hashPassword(next), Date.now(), user.id);
    db.prepare("UPDATE sessions SET revoked_at = ?, revoke_reason = 'password reset' WHERE user_id = ? AND revoked_at IS NULL").run(Date.now(), user.id);
    audit.record('auth.password_reset', { severity: 'critical', actor: 'cli', detail: { username: user.username } });
    done(`Password changed for ${user.username}; all of its sessions were signed out.`);
    break;
  }
  case 'verify-audit': {
    const r = audit.verify();
    done(r.ok ? `Audit chain intact: ${r.count} entries` : `AUDIT CHAIN BROKEN at entry ${r.brokenAt}: ${r.reason}`, r.ok ? 0 : 2);
    break;
  }
  default:
    done('commands: unblock <ip> | blocks | unlock <username> | set-password <username> | verify-audit', 1);
}

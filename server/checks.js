// Live system checks. Each one runs real work in the backend when requested.
// `publicDetail` is the only text an unauthenticated visitor sees.
import { statfsSync } from 'node:fs';
import { cpus, freemem, loadavg, totalmem, uptime as osUptime } from 'node:os';
import { fileMode } from './config.js';
import { REQUIRED_HEADERS } from './security/headers.js';

function fmtBytes(value) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let n = value;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function createChecks(ctx) {
  const { config, db, audit, drive, linkedTelegramAccounts, blocklist, sessions, startedAt } = ctx;

  const checks = [
    {
      id: 'runtime',
      label: 'Server runtime',
      run() {
        const mem = process.memoryUsage().rss;
        return { status: 'pass', publicDetail: `Node ${process.versions.node}`, detail: `Node ${process.versions.node}, pid ${process.pid}, up ${Math.round((Date.now() - startedAt) / 1000)} s, RSS ${fmtBytes(mem)}` };
      },
    },
    {
      id: 'database',
      label: 'Database integrity',
      run() {
        const result = db.prepare('PRAGMA quick_check').get();
        const ok = Object.values(result)[0] === 'ok';
        const mode = fileMode(db.file);
        const tight = mode === null || (mode & 0o077) === 0;
        return { status: ok ? (tight ? 'pass' : 'warn') : 'fail', publicDetail: ok ? 'Integrity verified' : 'Integrity problem', detail: `quick_check=${Object.values(result)[0]}, file mode ${mode === null ? 'n/a' : mode.toString(8)}` };
      },
    },
    {
      id: 'audit-chain',
      label: 'Audit trail chain',
      run() {
        const result = audit.verify();
        return result.ok
          ? { status: 'pass', publicDetail: 'Hash chain intact', detail: `${result.count} entries, head ${result.head.slice(0, 16)}…` }
          : { status: 'fail', publicDetail: 'Tampering detected', detail: `Chain broken at entry ${result.brokenAt}: ${result.reason}` };
      },
    },
    {
      id: 'transport',
      label: 'Transport security',
      run(request) {
        const https = request.protocol === 'https';
        const loopback = ['127.0.0.1', '::1', 'localhost'].includes(config.host);
        if (https) return { status: 'pass', publicDetail: 'TLS active, HSTS on', detail: `HTTPS with HSTS; secure cookies ${config.cookieSecure ? 'on' : 'off'}` };
        if (loopback) return { status: 'warn', publicDetail: 'Plain HTTP on loopback only', detail: `Listening on ${config.host} without TLS. Put TLS in front before exposing this host.` };
        return { status: 'fail', publicDetail: 'Plain HTTP on a network interface', detail: `Listening on ${config.host} without TLS — credentials can be intercepted.` };
      },
    },
    {
      id: 'headers',
      label: 'Security headers',
      run(_request, reply) {
        const missing = REQUIRED_HEADERS.filter(name => !reply.getHeader(name));
        return missing.length === 0
          ? { status: 'pass', publicDetail: 'CSP, framing, sniffing, isolation enforced', detail: `${REQUIRED_HEADERS.length} required headers present` }
          : { status: 'fail', publicDetail: 'Headers missing', detail: `Missing: ${missing.join(', ')}` };
      },
    },
    {
      id: 'secrets',
      label: 'Key material',
      run() {
        const mode = fileMode(config.secrets.file);
        const dirMode = fileMode(config.dataDir);
        const tight = (mode === null || (mode & 0o077) === 0) && (dirMode === null || (dirMode & 0o077) === 0);
        const status = !tight ? 'warn' : config.secrets.sealed ? 'pass' : (config.trustProxy ? 'warn' : 'pass');
        return { status, publicDetail: tight ? (config.secrets.sealed ? 'Keys sealed with master key, owner-only access' : 'Keys owner-only') : 'Key file permissions too open', detail: `secrets ${mode?.toString(8) ?? 'n/a'}, data dir ${dirMode?.toString(8) ?? 'n/a'}; master key ${config.secrets.sealed ? 'set (secrets file encrypted)' : 'not set — set TDC_MASTER_KEY on cloud hosts'}; AES-256-GCM vault, HMAC-SHA256 audit key` };
      },
    },
    {
      id: 'auth-policy',
      label: 'Authentication policy',
      run() {
        const users = db.prepare("SELECT COUNT(*) AS n, SUM(role = 'admin') AS admins FROM users").get();
        return {
          status: users.admins ? 'pass' : 'warn',
          publicDetail: users.admins ? 'Password sign-in, lockout after repeated failures' : 'Administrator not set up yet',
          detail: `${users.n} account(s); admin ${users.admins ? 'ready' : 'missing — set TDC_ADMIN_PASSWORD'}; registration ${config.allowRegistration ? 'open' : 'closed'}; scrypt N=32768; lock after ${config.limits.accountFailuresBeforeLock} failures`,
        };
      },
    },
    {
      id: 'threats',
      label: 'Intrusion defenses',
      run() {
        const since = Date.now() - 3_600_000;
        const failures = db.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE ts > ? AND result != 'success'").get(since).n;
        const blocked = blocklist.list().length;
        return {
          status: failures > 50 ? 'warn' : 'pass',
          publicDetail: 'Rate limiting and auto-blocking armed',
          detail: `${failures} failed sign-ins in the last hour, ${blocked} IP(s) blocked, ${sessions.active().length} active session(s)`,
        };
      },
    },
    {
      id: 'drive-api',
      label: 'Telegram link',
      async run() {
        const linked = linkedTelegramAccounts?.() ?? 0;
        const result = await drive.health();
        if (!result.ok && linked > 0) return { status: 'pass', publicDetail: 'Direct to Telegram', detail: `${linked} Telegram account(s) linked directly; desktop app API not reachable (${result.error})` };
        if (!result.ok && !drive.keyConfigured()) return { status: 'pass', publicDetail: 'Ready — members connect their own Telegram', detail: `No Telegram account linked yet; no desktop app configured (${result.error})` };
        if (result.ok) return { status: result.authorized ? 'pass' : 'warn', publicDetail: result.authorized ? 'Connected' : 'Reachable, key not accepted', detail: `${drive.baseUrl()} — v${result.version ?? '?'} in ${result.ms} ms; key ${result.authorized ? 'accepted' : result.keyConfigured ? 'rejected' : 'not configured'}` };
        return { status: 'warn', publicDetail: 'Desktop app API not reachable', detail: `${drive.baseUrl()} — ${result.error}` };
      },
    },
    {
      id: 'host',
      label: 'Host resources',
      run() {
        let disk = 'n/a';
        let diskLow = false;
        try {
          const fs = statfsSync(config.dataDir);
          const free = fs.bavail * fs.bsize;
          disk = `${fmtBytes(free)} free`;
          diskLow = free < 512 * 1024 * 1024;
        } catch { /* statfs unsupported */ }
        const load = loadavg()[0];
        const cores = cpus().length || 1;
        const memFree = freemem() / totalmem();
        const status = diskLow || memFree < 0.05 || load > cores * 2 ? 'warn' : 'pass';
        return { status, publicDetail: status === 'pass' ? 'Within limits' : 'Resource pressure', detail: `load ${load.toFixed(2)} / ${cores} cores, memory ${(memFree * 100).toFixed(0)}% free, disk ${disk}, host up ${Math.round(osUptime() / 3600)} h` };
      },
    },
  ];

  async function run(id, request, reply) {
    const check = checks.find(c => c.id === id);
    if (!check) return null;
    const started = process.hrtime.bigint();
    let result;
    try {
      result = await check.run(request, reply);
    } catch (error) {
      result = { status: 'fail', publicDetail: 'Check failed to run', detail: String(error?.message ?? error) };
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    return { id: check.id, label: check.label, ms: Math.round(ms * 10) / 10, ...result };
  }

  // Before sign-in only the application's own health is shown; security internals are for the admin.
  const APP_CHECKS = new Set(['runtime', 'database', 'drive-api', 'host']);
  return {
    list: checks.map(({ id, label }) => ({ id, label })),
    appList: checks.filter(c => APP_CHECKS.has(c.id)).map(({ id, label }) => ({ id, label })),
    isAppCheck: id => APP_CHECKS.has(id),
    run,
  };
}

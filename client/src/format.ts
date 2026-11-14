export function fmtTime(ts: number | null | undefined) {
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

export function fmtClock(ts: number) {
  return new Date(ts).toISOString().slice(11, 19) + 'Z';
}

export function ago(ts: number | null | undefined, now = Date.now()) {
  if (!ts) return '—';
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function fmtBytes(n: number | null | undefined) {
  if (n === null || n === undefined) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export const ACTION_LABELS: Record<string, string> = {
  'server.start': 'Server started',
  'setup.operator_created': 'Operator account created',
  'setup.bad_token': 'Setup attempted with wrong token',
  'auth.login': 'Signed in',
  'auth.logout': 'Signed out',
  'account.disabled': 'Account switched off',
  'account.enabled': 'Account switched on',
  'account.deleted': 'Account removed',
  'auth.sudo': 'Elevated for sensitive actions',
  'auth.sudo_failed': 'Elevation failed',
  'auth.password_changed': 'Password changed',
  'mfa.enabled': 'Two-factor enabled',
  'mfa.reset': 'Two-factor reset from server shell',
  'account.locked': 'Account locked',
  'account.unlocked': 'Account unlocked',
  'session.revoked': 'Session revoked',
  'session.revoked_others': 'Other sessions revoked',
  'session.anomaly': 'Session fingerprint changed',
  'session.ip_change': 'Session moved to a new IP',
  'csrf.rejected': 'Forged request rejected',
  'ip.auto_blocked': 'IP auto-blocked',
  'ip.blocked': 'IP blocked',
  'ip.unblocked': 'IP unblocked',
  'drive.configured': 'Drive link reconfigured',
  'drive.download': 'File downloaded',
  'drive.upload': 'File uploaded',
  'drive.delete': 'File deleted',
  'drive.open': 'File opened',
  'drive.prepare': 'Video prepared for smooth playback',
  'folder.created': 'Folder created',
  'folder.renamed': 'Folder renamed',
  'folder.deleted': 'Folder deleted',
  'folder.linked': 'Chat added as folder',
  'folder.unlinked': 'Chat removed from Kurovault',
  'telegram.connected': 'Telegram connected',
  'telegram.disconnected': 'Telegram disconnected',
  'telegram.login_failed': 'Telegram sign-in failed',
  'telegram.session_terminated': 'Telegram session terminated',
  'drive.source_changed': 'Vault source changed',
  'archive.opened': 'Archive opened',
  'account.created': 'Account created',
  'setup.admin_created': 'Admin account created',
  'auth.password_reset': 'Password reset from server shell',
  'telegram.migrated': 'Telegram connection moved to an account',
  'archive.entry_opened': 'File in archive opened',
  'archive.extracted': 'File extracted from archive',
  'file.renamed': 'File renamed',
  'file.moved': 'File moved',
  'file.copied': 'File copied',
  'file.bulk_moved': 'Files moved',
  'file.bulk_deleted': 'Files deleted',
  'file.archived': 'Files downloaded as zip',
};

export const RESULT_LABELS: Record<string, string> = {
  success: 'Success',
  password_ok: 'Password OK',
  bad_password: 'Wrong password',
  unknown_user: 'Unknown user',
  bad_totp: 'Wrong 2FA code',
  username_taken: 'Username taken',
  locked: 'Account locked',
  rate_limited: 'Rate limited',
  bad_setup_token: 'Bad setup token',
  bad_invite: 'Wrong invitation code',
  signup_limit: 'Sign-up limit reached',
  disabled: 'Account switched off',
};

export function resultTone(result: string): 'ok' | 'warn' | 'crit' | 'info' {
  if (result === 'success') return 'ok';
  if (result === 'password_ok') return 'info';
  if (result === 'locked' || result === 'rate_limited' || result === 'bad_setup_token') return 'crit';
  return 'warn';
}

export function severityTone(sev: string): 'ok' | 'warn' | 'crit' | 'info' {
  return sev === 'critical' ? 'crit' : sev === 'high' ? 'warn' : sev === 'medium' ? 'info' : 'ok';
}

export function describeDetail(detail: string) {
  try {
    const obj = JSON.parse(detail) as Record<string, unknown>;
    return Object.entries(obj)
      .filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object')
      .map(([k, v]) => `${k}=${String(v)}`)
      .join('  ');
  } catch {
    return '';
  }
}

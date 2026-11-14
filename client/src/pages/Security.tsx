import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { fmtTime } from '../format';
import { DataTable, Empty, ErrorNote, Loading, Panel, Tag, usePoll } from '../ui';
import { TelegramSessions } from '../vault/Telegram';

export function SecurityPage({ me }: { me: any }) {
  const admin = me.user.role === 'admin';
  const blocks = usePoll(async () => (admin ? api('/api/console/blocks') : null), 10000);
  const [pw, setPw] = useState({ current: '', next: '', confirm: '' });
  const [pwNote, setPwNote] = useState('');
  const [pwError, setPwError] = useState<unknown>(null);
  const [ip, setIp] = useState('');
  const [reason, setReason] = useState('');
  const [blockError, setBlockError] = useState<unknown>(null);

  async function changePassword(e: FormEvent) {
    e.preventDefault();
    setPwError(null);
    setPwNote('');
    try {
      if (pw.next !== pw.confirm) throw new Error('New passwords do not match.');
      const r = await api('/api/auth/password', { method: 'POST', body: { current: pw.current, next: pw.next } });
      setPw({ current: '', next: '', confirm: '' });
      setPwNote(`Password changed. ${r.revoked} other session(s) were signed out.`);
    } catch (err) { setPwError(err); }
  }

  async function block(e: FormEvent) {
    e.preventDefault();
    setBlockError(null);
    try {
      await api('/api/console/blocks', { method: 'POST', body: { ip: ip.trim(), reason, minutes: 1440 } });
      setIp('');
      setReason('');
      void blocks.refresh();
    } catch (err) { setBlockError(err); }
  }

  async function unblock(target: string) {
    try { await api(`/api/console/blocks/${encodeURIComponent(target)}`, { method: 'DELETE' }); void blocks.refresh(); } catch (err) { setBlockError(err); }
  }

  return (
    <div className="page">
      <div className="grid-1-1">
        <Panel title="Your account">
          <dl className="kv">
            <div><dt>Name</dt><dd>{me.user.name}</dd></div>
            <div><dt>Username</dt><dd>@{me.user.username}</dd></div>
            <div><dt>Role</dt><dd>{admin ? <Tag tone="warn">administrator</Tag> : 'member'}</dd></div>
            <div><dt>Member since</dt><dd className="mono">{fmtTime(me.user.created_at)}</dd></div>
            <div><dt>This browser</dt><dd className="mono">{me.session.ip}{me.session.location ? ` · ${me.session.location}` : ''}</dd></div>
            <div><dt>Stays signed in</dt><dd>until you sign out (or {me.sessionDays} days unused)</dd></div>
          </dl>
        </Panel>
        <Panel title="Change password" meta="signs out every other session">
          <form className="form" onSubmit={changePassword}>
            <label className="field"><span>Current password</span><input type="password" autoComplete="current-password" value={pw.current} onChange={e => setPw({ ...pw, current: e.target.value })} required /></label>
            <label className="field"><span>New password</span><input type="password" autoComplete="new-password" value={pw.next} onChange={e => setPw({ ...pw, next: e.target.value })} required /></label>
            <label className="field"><span>Confirm new password</span><input type="password" autoComplete="new-password" value={pw.confirm} onChange={e => setPw({ ...pw, confirm: e.target.value })} required /></label>
            <ErrorNote error={pwError} />
            {pwNote && <div className="ok-note">{pwNote}</div>}
            <button className="btn btn-primary">Update password</button>
          </form>
        </Panel>
      </div>

      <Devices />

      <TelegramSessions />

      {admin && <Panel title="IP blocklist" meta="blocked addresses get 403 on every request" flush>
        <form className="form form-row" onSubmit={block}>
          <input className="input-sm mono" placeholder="IPv4 or IPv6 address" value={ip} onChange={e => setIp(e.target.value)} required aria-label="IP address to block" />
          <input className="input-sm" placeholder="Reason" value={reason} onChange={e => setReason(e.target.value)} maxLength={200} aria-label="Reason" />
          <button className="btn btn-danger btn-sm">Block for 24 h</button>
        </form>
        <ErrorNote error={blockError} />
        {blocks.data && (blocks.data.blocks.length === 0 ? <Empty>No addresses are blocked.</Empty> : (
          <DataTable<any> label="Blocked addresses" rows={blocks.data.blocks} rowKey={b => b.ip} columns={[
            { key: 'ip', label: 'IP', primary: true, className: 'mono', render: b => b.ip },
            { key: 'reason', label: 'Reason', render: b => b.reason },
            { key: 'by', label: 'By', render: b => b.created_by },
            { key: 'since', label: 'Since', className: 'mono nowrap', render: b => fmtTime(b.created_at) },
            { key: 'until', label: 'Until', className: 'mono nowrap', render: b => fmtTime(b.until) },
            { key: 'hits', label: 'Hits', className: 'num', render: b => b.hits },
            { key: 'act', label: 'Action', actions: true, render: b => <button className="btn btn-ghost btn-sm" onClick={() => unblock(b.ip)}>Unblock</button> },
          ]} />
        ))}
      </Panel>}

      {admin && <Panel title="Active protections">
        <ul className="policy">
          <li><Tag tone="ok">on</Tag> Password hashing with scrypt (N=32768, r=8), per-user salt, constant-time comparison, timing-equalized unknown users</li>
          <li><Tag tone="ok">on</Tag> Progressive account lockout (15 min doubling to 24 h) and automatic IP blocking after repeated failures</li>
          <li><Tag tone="ok">on</Tag> Sliding-window rate limits on every request and stricter limits on sign-in endpoints</li>
          <li><Tag tone="ok">on</Tag> Opaque 256-bit sessions stored only as SHA-256, HttpOnly + SameSite=Strict cookies; sign-out ends only that browser</li>
          <li><Tag tone="ok">on</Tag> Admin-only intelligence: sign-in attempts, visitors, sessions and the audit trail are visible to the admin account only</li>
          <li><Tag tone="ok">on</Tag> Visitor locations (city, state, country) resolved on this server — no IP address is sent to anyone</li>
          <li><Tag tone="ok">on</Tag> Everyone can see their own signed-in devices and sign the others out; the admin can switch off or remove any account</li>
          <li><Tag tone="ok">on</Tag> Sign-up limits per address and in total, optional invitation code, and a lock that strangers cannot use to shut the owner out</li>
          <li><Tag tone="ok">on</Tag> Hidden from search engines (noindex on every response)</li>
          <li><Tag tone="ok">on</Tag> CSRF tokens plus Origin and Fetch-Metadata checks on every state-changing request</li>
          <li><Tag tone="ok">on</Tag> Strict Content-Security-Policy, no framing, no sniffing, cross-origin isolation, no referrers</li>
          <li><Tag tone="ok">on</Tag> Telegram API hash and session sealed with AES-256-GCM on the server; never sent to browsers, never logged</li>
          <li><Tag tone="ok">on</Tag> HMAC-chained audit trail; any edit or deletion is detected</li>
          <li><Tag tone="ok">on</Tag> No third-party scripts, fonts, analytics or IP lookups — visitor data never leaves this server</li>
        </ul>
      </Panel>}
    </div>
  );
}

/** Every browser signed in to this account, with a way to sign the others out. */
function Devices() {
  const { data, error, loading, refresh } = usePoll(() => api('/api/auth/sessions'), 20000);
  const [actionError, setActionError] = useState<unknown>(null);
  const run = async (fn: () => Promise<unknown>) => { setActionError(null); try { await fn(); void refresh(); } catch (e) { setActionError(e); } };
  const others = data ? data.sessions.filter((s: any) => !s.current).length : 0;
  return (
    <Panel title="Your devices" meta="browsers signed in to this account" flush
      actions={others > 0 ? <button className="btn btn-ghost btn-sm" onClick={() => run(() => api('/api/auth/sessions/revoke-others', { method: 'POST', body: {} }))}>Sign out all others</button> : undefined}>
      {loading && !data ? <Loading /> : <ErrorNote error={error ?? actionError} />}
      {data && (
        <DataTable<any> label="Your devices" rows={data.sessions} rowKey={s => s.id} columns={[
          { key: 'dev', label: 'Device', primary: true, render: s => <>{s.agent.browser} on {s.agent.os} {s.current && <Tag tone="ok">this one</Tag>}</> },
          { key: 'where', label: 'From', render: s => <><span className="mono">{s.ip}</span><div className="sub">{s.location ?? ''}</div></> },
          { key: 'since', label: 'Signed in', className: 'mono nowrap', render: s => fmtTime(s.createdAt) },
          { key: 'seen', label: 'Last used', className: 'mono nowrap', render: s => fmtTime(s.lastSeen) },
          { key: 'act', label: 'Action', actions: true, render: s => (s.current ? <span className="sub">—</span> : <button className="btn btn-ghost btn-sm" onClick={() => run(() => api('/api/auth/sessions/revoke', { method: 'POST', body: { id: s.id } }))}>Sign out</button>) },
        ]} />
      )}
    </Panel>
  );
}

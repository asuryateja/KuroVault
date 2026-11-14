import { useState } from 'react';
import { api } from '../api';
import { ACTION_LABELS, ago, describeDetail, fmtTime, RESULT_LABELS, resultTone, severityTone } from '../format';
import { ActivityChart, DataTable, Dialog, Empty, ErrorNote, Kpi, Loading, Panel, Tag, usePoll } from '../ui';
import { SystemSweep } from './Gate';
import { ConfirmDialog } from '../vault/parts';

type AuditRow = { id: number; ts: number; severity: string; actor: string; ip: string; action: string; detail: string; hash?: string; prev_hash?: string };

function EventRow({ e }: { e: AuditRow }) {
  return (
    <li className="event">
      <span className="event-time">{fmtTime(e.ts)}</span>
      <Tag tone={severityTone(e.severity)}>{e.severity}</Tag>
      <span className="event-text"><b>{ACTION_LABELS[e.action] ?? e.action}</b> <span className="muted">by {e.actor}</span></span>
      <span className="event-ip mono">{e.ip}</span>
      <span className="event-detail mono">{describeDetail(e.detail)}</span>
    </li>
  );
}

export function Overview({ go }: { go: (page: string, filter?: string) => void }) {
  const { data, error, loading } = usePoll(() => api('/api/console/overview'), 5000);
  if (loading && !data) return <Loading label="Collecting telemetry" />;
  if (!data) return <ErrorNote error={error} />;
  const k = data.kpi;
  return (
    <div className="page">
      <div className="kpis">
        <Kpi label="Sign-ins · 24h" value={k.loginsOk} tone="ok" />
        <Kpi label="Failed attempts · 24h" value={k.loginsFailed} tone={k.loginsFailed ? 'warn' : undefined} />
        <Kpi label="Unique IPs · 24h" value={k.uniqueIps} sub={`${k.requests} requests`} />
        <Kpi label="Blocked IPs" value={k.blockedIps} tone={k.blockedIps ? 'crit' : undefined} />
        <Kpi label="Active sessions" value={k.activeSessions} />
        <Kpi label="High-severity events · 24h" value={k.highSeverity} tone={k.highSeverity ? 'warn' : undefined} />
        <Kpi label="Audit chain" value={data.chain.ok ? 'Intact' : 'Broken'} tone={data.chain.ok ? 'ok' : 'crit'} sub={`${data.chain.count} sealed entries`} />
      </div>
      <div className="grid-2-1">
        <Panel title="Traffic & sign-in failures" meta="last 24 hours · hourly">
          <ActivityChart series={data.series} />
          <div className="legend"><span><i className="lg-bar" /> Requests</span><span><i className="lg-line" /> Failed sign-ins</span></div>
        </Panel>
        <Panel title="Threat sources" meta="failed sign-ins · 24h" flush>
          {data.topThreats.length === 0 ? <Empty>No failed sign-ins in the last 24 hours.</Empty> : (
            <DataTable<any> label="Threat sources" rows={data.topThreats} rowKey={t => t.ip} columns={[
              { key: 'ip', label: 'IP', primary: true, render: t => <><button className="link mono" onClick={() => go('visitors', t.ip)}>{t.ip}</button><div className="sub">{t.location ?? t.scope}</div></> },
              { key: 'fails', label: 'Fails', className: 'num', render: t => t.failures },
              { key: 'tried', label: 'Tried', className: 'mono clip clip-sm col-xl', render: t => <span title={t.usernames ?? ''}>{t.usernames ?? '—'}</span> },
              { key: 'state', label: 'State', render: t => t.blocked ? <Tag tone="crit">Blocked</Tag> : <span className="sub">{ago(t.last)}</span> },
            ]} />
          )}
        </Panel>
      </div>
      <div className="grid-2-1">
        <Panel title="Live event stream" meta="audit log · refreshes every 5 s" actions={<button className="btn btn-ghost btn-sm" onClick={() => go('audit')}>Open audit</button>}>
          <ul className="events">{data.events.map((e: AuditRow) => <EventRow key={e.id} e={e} />)}</ul>
        </Panel>
        <Panel title="System checks" meta="executed now">
          <SystemSweep authenticated />
        </Panel>
      </div>
    </div>
  );
}

export function AccessLog({ go, initialIp }: { go: (page: string, filter?: string) => void; initialIp?: string }) {
  const [result, setResult] = useState('');
  const [ip, setIp] = useState(initialIp ?? '');
  const { data, error, loading } = usePoll(() => api('/api/console/attempts', { query: { result, ip: ip.trim() || undefined } }), 5000, [result, ip]);
  return (
    <div className="page">
      <Panel
        title="Sign-in attempts"
        meta="every attempt, successful or not"
        actions={
          <div className="filters">
            <div className="seg" role="group" aria-label="Result filter">
              {[['', 'All'], ['failed', 'Failed'], ['success', 'Successful']].map(([v, l]) => (
                <button key={v} className={result === v ? 'on' : ''} onClick={() => setResult(v)}>{l}</button>
              ))}
            </div>
            <input className="input-sm mono" placeholder="Filter by IP" value={ip} onChange={e => setIp(e.target.value)} aria-label="Filter by IP" />
          </div>
        }
        flush
      >
        {loading && !data ? <Loading /> : <ErrorNote error={error} />}
        {data && (data.attempts.length === 0 ? <Empty>No attempts match.</Empty> : (
          <DataTable<any> label="Sign-in attempts" rows={data.attempts} rowKey={a => a.id} columns={[
            { key: 'time', label: 'Time', className: 'mono nowrap', render: a => fmtTime(a.ts) },
            { key: 'result', label: 'Result', primary: true, render: a => <Tag tone={resultTone(a.result)}>{RESULT_LABELS[a.result] ?? a.result}</Tag> },
            { key: 'stage', label: 'Stage', className: 'sub col-xl', render: a => a.stage },
            { key: 'user', label: 'Username', className: 'mono', render: a => a.username ?? '—' },
            { key: 'ip', label: 'Source IP', render: a => <><button className="link mono" onClick={() => go('visitors', a.ip)}>{a.ip}</button> <span className="sub">{a.scope}</span></> },
            { key: 'loc', label: 'Location', render: a => a.location ?? <span className="sub">—</span> },
            { key: 'client', label: 'Client', className: 'sub', render: a => `${a.agent.browser} · ${a.agent.os}${a.agent.automated ? ' · automated' : ''}` },
          ]} />
        ))}
      </Panel>
    </div>
  );
}

export function Visitors({ initialIp }: { initialIp?: string }) {
  const { data, error, loading, refresh } = usePoll(() => api('/api/console/visitors'), 8000);
  const [selected, setSelected] = useState<string | null>(initialIp ?? null);
  const [blockTarget, setBlockTarget] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [minutes, setMinutes] = useState(1440);
  const [actionError, setActionError] = useState<unknown>(null);
  const visits = usePoll(() => (selected ? api('/api/console/visits', { query: { ip: selected } }) : Promise.resolve(null)), 0, [selected]);

  async function block() {
    if (!blockTarget) return;
    try {
      await api('/api/console/blocks', { method: 'POST', body: { ip: blockTarget, minutes, reason } });
      setBlockTarget(null);
      setReason('');
      void refresh();
    } catch (e) { setActionError(e); }
  }
  async function unblock(ip: string) {
    try { await api(`/api/console/blocks/${encodeURIComponent(ip)}`, { method: 'DELETE' }); void refresh(); } catch (e) { setActionError(e); }
  }

  return (
    <div className="page">
      <ErrorNote error={actionError} />
      <Panel title="Visitors by IP address" meta="every address that reached this console" flush>
        {loading && !data ? <Loading /> : <ErrorNote error={error} />}
        {data && (data.visitors.length === 0 ? <Empty>No traffic recorded yet.</Empty> : (
          <DataTable<any> label="Visitors" rows={data.visitors} rowKey={v => v.ip} rowClass={v => (selected === v.ip ? 'row-on' : '')} columns={[
            { key: 'ip', label: 'IP address', primary: true, render: v => <><button className="link mono" onClick={() => setSelected(v.ip)}>{v.ip}</button><div className="sub">{v.scope} · IPv{v.version || '?'}</div></> },
            { key: 'loc', label: 'Location', render: v => (v.location ? <>{[v.location.city, v.location.district].filter(Boolean).join(', ') || '—'}<div className="sub">{[v.location.region, v.location.country].filter(Boolean).join(', ')}</div></> : <span className="sub">{v.scope === 'public' ? 'unknown' : 'local network'}</span>) },
            { key: 'risk', label: 'Risk', render: v => <Tag tone={v.blocked ? 'crit' : v.risk === 'high' ? 'crit' : v.risk === 'elevated' ? 'warn' : 'ok'}>{v.blocked ? 'blocked' : v.risk}</Tag> },
            { key: 'first', label: 'First seen', className: 'mono nowrap col-xl', render: v => fmtTime(v.first_seen) },
            { key: 'last', label: 'Last', className: 'nowrap', render: v => ago(v.last_seen) },
            { key: 'req', label: 'Requests', className: 'num', render: v => v.requests },
            { key: 'err', label: 'Errors', className: 'num col-xl', render: v => v.errors },
            { key: 'ok', label: 'Sign-ins', className: 'num', render: v => v.loginsOk },
            { key: 'bad', label: 'Failed', className: 'num', render: v => v.loginsFailed },
            { key: 'tried', label: 'Usernames tried', className: 'mono clip clip-sm', render: v => <span title={v.triedUsernames ?? ''}>{v.triedUsernames ?? '—'}</span> },
            { key: 'client', label: 'Client', className: 'sub nowrap col-xl', render: v => `${v.agent.browser} · ${v.agent.os}` },
            { key: 'act', label: 'Action', actions: true, render: v => v.blocked
              ? <button className="btn btn-ghost btn-sm" onClick={() => unblock(v.ip)}>Unblock</button>
              : <button className="btn btn-danger btn-sm" onClick={() => setBlockTarget(v.ip)}>Block</button> },
          ]} />
        ))}
      </Panel>
      {selected && (
        <Panel title={<>Request trail · <span className="mono">{selected}</span></>} meta="latest 200 requests" actions={<button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>Close</button>} flush>
          {visits.loading ? <Loading /> : visits.data && (visits.data.visits.length === 0 ? <Empty>No requests recorded for this address.</Empty> : (
            <DataTable<any> label="Request trail" rows={visits.data.visits} rowKey={r => r.id} columns={[
              { key: 'time', label: 'Time', className: 'mono nowrap', render: r => fmtTime(r.ts) },
              { key: 'req', label: 'Request', primary: true, className: 'mono clip', render: r => `${r.method} ${r.path}` },
              { key: 'status', label: 'Status', className: 'num', render: r => <Tag tone={r.status >= 500 ? 'crit' : r.status >= 400 ? 'warn' : 'ok'}>{r.status}</Tag> },
              { key: 'ms', label: 'ms', className: 'num', render: r => r.ms },
              { key: 'ua', label: 'User agent', className: 'sub clip', render: r => <span title={r.ua}>{r.ua || '—'}</span> },
            ]} />
          ))}
        </Panel>
      )}
      {blockTarget && (
        <Dialog title={`Block ${blockTarget}`} onClose={() => setBlockTarget(null)}>
          <div className="form">
            <label className="field"><span>Duration</span>
              <select value={minutes} onChange={e => setMinutes(Number(e.target.value))}>
                <option value={60}>1 hour</option><option value={1440}>24 hours</option><option value={10080}>7 days</option><option value={525600}>1 year</option>
              </select>
            </label>
            <label className="field"><span>Reason</span><input value={reason} onChange={e => setReason(e.target.value)} maxLength={200} placeholder="e.g. credential stuffing" /></label>
            <button className="btn btn-danger btn-block" onClick={block}>Block address</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

export function Sessions() {
  const { data, error, loading, refresh } = usePoll(() => api('/api/console/sessions'), 6000);
  const [note, setNote] = useState('');
  async function revoke(id: string) { await api('/api/console/sessions/revoke', { method: 'POST', body: { id } }); void refresh(); }
  async function revokeOthers() { const r = await api('/api/console/sessions/revoke-others', { method: 'POST', body: {} }); setNote(`${r.count} other session(s) revoked.`); void refresh(); }
  return (
    <div className="page">
      <Panel title="Active sessions" meta="signed-in browsers" actions={<button className="btn btn-ghost btn-sm" onClick={revokeOthers}>Sign out all others</button>} flush>
        {note && <div className="ok-note">{note}</div>}
        {loading && !data ? <Loading /> : <ErrorNote error={error} />}
        {data && (
          <DataTable<any> label="Sessions" rows={data.sessions} rowKey={x => x.id} columns={[
            { key: 'op', label: 'Account', primary: true, render: x => <>{x.name} <span className="sub">@{x.username}</span> {x.role === 'admin' && <Tag tone="warn">admin</Tag>} {x.current && <Tag tone="info">this browser</Tag>}</> },
            { key: 'start', label: 'Signed in', className: 'mono nowrap col-xl', render: x => fmtTime(x.createdAt) },
            { key: 'seen', label: 'Last activity', render: x => ago(x.lastSeen) },
            { key: 'ip', label: 'Origin IP', className: 'mono', render: x => x.ip },
            { key: 'cur', label: 'Current IP', className: 'mono', render: x => <>{x.lastIp} {x.lastIp !== x.ip && <Tag tone="warn">moved</Tag>}</> },
            { key: 'loc', label: 'Location', render: x => x.location ?? <span className="sub">—</span> },
            { key: 'client', label: 'Client', className: 'sub', render: x => `${x.agent.browser} · ${x.agent.os}` },
            { key: 'exp', label: 'Expires', className: 'mono nowrap col-xl', render: x => fmtTime(x.expiresAt) },
            { key: 'act', label: 'Action', actions: true, render: x => (!x.current ? <button className="btn btn-danger btn-sm" onClick={() => revoke(x.id)}>Revoke</button> : null) },
          ]} />
        )}
      </Panel>
      <UsersPanel />
    </div>
  );
}

function UsersPanel() {
  const { data, error, loading, refresh } = usePoll(() => api('/api/console/users'), 15000);
  const [actionError, setActionError] = useState<unknown>(null);
  const [removing, setRemoving] = useState<any>(null);
  const run = async (fn: () => Promise<unknown>) => { setActionError(null); try { await fn(); void refresh(); } catch (e) { setActionError(e); } };
  return (
    <Panel title="Accounts" meta={data ? `${data.users.length} registered` : undefined} flush>
      {loading && !data ? <Loading /> : <ErrorNote error={error ?? actionError} />}
      {removing && <ConfirmDialog title={`Remove ${removing.name}?`} confirmLabel="Remove account" onClose={() => setRemoving(null)}
        message={<>This signs @{removing.username} out everywhere, disconnects their Telegram from this server and erases their account. Their files on Telegram are not touched. This cannot be undone.</>}
        onConfirm={async () => { await api(`/api/console/users/${removing.id}`, { method: 'DELETE' }); setRemoving(null); void refresh(); }} />}
      {data && (
        <DataTable<any> label="Accounts" rows={data.users} rowKey={u => u.id} columns={[
          { key: 'name', label: 'Name', primary: true, render: u => <>{u.name} <span className="sub">@{u.username}</span> {u.role === 'admin' && <Tag tone="warn">admin</Tag>}</> },
          { key: 'created', label: 'Registered', className: 'mono nowrap', render: u => fmtTime(u.created_at) },
          { key: 'last', label: 'Last sign-in', className: 'mono nowrap', render: u => (u.last_login_at ? fmtTime(u.last_login_at) : '—') },
          { key: 'where', label: 'From', render: u => (u.last_login_ip ? <><span className="mono">{u.last_login_ip}</span><div className="sub">{u.location ?? ''}</div></> : '—') },
          { key: 'tg', label: 'Telegram', render: u => (u.telegram ? <Tag tone="ok">linked</Tag> : <span className="sub">not linked</span>) },
          { key: 'sess', label: 'Sessions', className: 'num', render: u => u.sessions },
          { key: 'lock', label: 'Status', render: u => (u.disabled_at ? <Tag tone="crit">switched off</Tag> : u.locked_until > Date.now() ? <Tag tone="warn">locked</Tag> : <Tag tone="ok">active</Tag>) },
          { key: 'act', label: 'Actions', actions: true, render: u => (u.role === 'admin' ? <span className="sub">protected</span> : (
            <span className="row-actions">
              {u.disabled_at
                ? <button className="btn btn-ghost btn-sm" onClick={() => run(() => api(`/api/console/users/${u.id}/enable`, { method: 'POST', body: {} }))}>Switch on</button>
                : <button className="btn btn-ghost btn-sm" onClick={() => run(() => api(`/api/console/users/${u.id}/disable`, { method: 'POST', body: {} }))}>Switch off</button>}
              {u.sessions > 0 && <button className="btn btn-ghost btn-sm" onClick={() => run(() => api(`/api/console/users/${u.id}/sign-out`, { method: 'POST', body: {} }))}>Sign out</button>}
              <button className="btn btn-danger btn-sm" onClick={() => setRemoving(u)}>Remove</button>
            </span>
          )) },
        ]} />
      )}
    </Panel>
  );
}

export function AuditTrail() {
  const { data, error, loading } = usePoll(() => api('/api/console/audit'), 8000);
  return (
    <div className="page">
      {data && (
        <div className={`banner ${data.chain.ok ? 'banner-ok' : 'banner-crit'}`}>
          {data.chain.ok
            ? <>Chain verified: {data.chain.count} entries sealed with HMAC-SHA256. Head <span className="mono">{data.chain.head.slice(0, 24)}…</span></>
            : <>Tampering detected at entry {data.chain.brokenAt}: {data.chain.reason}</>}
        </div>
      )}
      <Panel title="Audit trail" meta="append-only · hash-chained" flush>
        {loading && !data ? <Loading /> : <ErrorNote error={error} />}
        {data && (
          <DataTable<AuditRow> label="Audit trail" rows={data.entries} rowKey={e => e.id} columns={[
            { key: 'id', label: '#', className: 'num mono', render: e => e.id },
            { key: 'time', label: 'Time', className: 'mono nowrap', render: e => fmtTime(e.ts) },
            { key: 'sev', label: 'Severity', render: e => <Tag tone={severityTone(e.severity)}>{e.severity}</Tag> },
            { key: 'event', label: 'Event', primary: true, render: e => <>{ACTION_LABELS[e.action] ?? e.action}<div className="sub mono">{e.action}</div></> },
            { key: 'actor', label: 'Actor', render: e => e.actor },
            { key: 'ip', label: 'IP', className: 'mono', render: e => e.ip },
            { key: 'detail', label: 'Detail', className: 'mono clip sub', render: e => <span title={describeDetail(e.detail)}>{describeDetail(e.detail) || '—'}</span> },
            { key: 'seal', label: 'Seal', className: 'mono sub', render: e => <span title={e.hash}>{e.hash?.slice(0, 10)}</span> },
          ]} />
        )}
      </Panel>
    </div>
  );
}

export function SystemPage() {
  const [run, setRun] = useState(0);
  return (
    <div className="page">
      <Panel title="System diagnostics" meta="each check runs on the server when requested" actions={<button className="btn btn-ghost btn-sm" onClick={() => setRun(r => r + 1)}>Run again</button>}>
        <SystemSweep key={run} authenticated />
      </Panel>
    </div>
  );
}

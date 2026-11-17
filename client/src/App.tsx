import { useCallback, useEffect, useRef, useState, type JSX } from 'react';
import { api, ApiError, onApiError, setCsrf } from './api';
import { ago, fmtClock } from './format';
import { Loading, useNow } from './ui';
import { IconFile, IconFit, IconFolder, IconGrid, IconLink, IconList, IconLock, IconWave } from './icons';
import { DrivePage } from './pages/Drive';
import { LinksPage } from './pages/Links';
import { BannedScreen } from './pages/Banned';
import { Gate } from './pages/Gate';
import { AccessLog, AuditTrail, Overview, Sessions, SystemPage, Visitors } from './pages/Intel';
import { SecurityPage } from './pages/Security';

const NAV = [
  { id: 'overview', label: 'Overview', group: 'Intelligence', admin: true },
  { id: 'access', label: 'Sign-in attempts', group: 'Intelligence', admin: true },
  { id: 'visitors', label: 'Visitors & IPs', group: 'Intelligence', admin: true },
  { id: 'sessions', label: 'Sessions & users', group: 'Intelligence', admin: true },
  { id: 'audit', label: 'Audit trail', group: 'Intelligence', admin: true },
  { id: 'drive', label: 'Vault', group: 'Library', admin: false },
  { id: 'links', label: 'Links', group: 'Library', admin: false },
  { id: 'security', label: 'Account & security', group: 'Library', admin: false },
  { id: 'system', label: 'System', group: 'Library', admin: true },
] as const;

const TAB_ICON: Record<string, JSX.Element> = {
  overview: <IconGrid />, access: <IconLock />, visitors: <IconWave />, sessions: <IconList />, audit: <IconFile />,
  drive: <IconFolder />, links: <IconLink />, security: <IconLock />, system: <IconFit />,
};

type Phase = { kind: 'boot' } | { kind: 'banned'; until: number | null } | { kind: 'gate'; registration: boolean; adminReady: boolean; invite: boolean } | { kind: 'console'; me: any };

function Console({ me, onSignedOut }: { me: any; onSignedOut: () => void }) {
  const now = useNow();
  const admin = me.user.role === 'admin';
  const nav = NAV.filter(n => admin || !n.admin);
  const home = admin ? 'overview' : 'drive';
  const allowed = (id: string) => nav.some(n => n.id === id);
  const initial = (window.location.hash.slice(1) || home).split(':');
  const [page, setPage] = useState<string>(allowed(initial[0]) ? initial[0] : home);
  const [filter, setFilter] = useState<string | undefined>(initial[1] ? decodeURIComponent(initial[1]) : undefined);

  const go = useCallback((next: string, f?: string) => {
    setPage(next);
    setFilter(f);
    window.location.hash = f ? `${next}:${encodeURIComponent(f)}` : next;
  }, []);

  useEffect(() => {
    const sync = () => {
      const [next, f] = (window.location.hash.slice(1) || home).split(':');
      if (allowed(next)) {
        setPage(next);
        setFilter(f ? decodeURIComponent(f) : undefined);
      }
    };
    window.addEventListener('hashchange', sync);
    return () => window.removeEventListener('hashchange', sync);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [admin]);

  useEffect(() => {
    const off = onApiError(err => { if (err.code === 'UNAUTHENTICATED') onSignedOut(); });
    return () => { off(); };
  }, [onSignedOut]);

  /** Signs out this browser only: Telegram and other devices stay signed in. */
  async function signOut() {
    try { await api('/api/auth/logout', { method: 'POST', body: {} }); } finally { setCsrf(''); onSignedOut(); }
  }

  const title = NAV.find(n => n.id === page)?.label ?? '';
  return (
    <div className={`app ${admin ? 'is-admin' : 'is-member'}`}>
      <header className="topbar" aria-label="Navigation">
        <button type="button" className="topbar-brand" onClick={() => go(home)} aria-label="Go to start"><img src="/logo.svg" alt="" /><span>KUROVAULT</span></button>
        <nav className="tabs" aria-label="Sections">
          {nav.map(n => (
            <button key={n.id} type="button" className={page === n.id ? 'on' : ''} onClick={() => go(n.id)} aria-current={page === n.id ? 'page' : undefined}>
              <span className="tab-ico" aria-hidden="true">{TAB_ICON[n.id]}</span><span className="tab-label">{n.label}</span>
            </button>
          ))}
        </nav>
        <div className="topbar-user">
          <span className="topbar-where" title={`${fmtClock(now)} · ${me.session.location ?? me.session.ip}`}>{me.session.location ?? me.session.ip}</span>
          <span className="nav-avatar" aria-hidden="true">{String(me.user.name || me.user.username).slice(0, 1).toUpperCase()}</span>
          <span className="topbar-name"><span className="nav-user-name">{me.user.name}</span><span className="sub">@{me.user.username}{admin ? ' · admin' : ''}</span></span>
          <button className="btn btn-sm topbar-out" onClick={signOut} aria-label="Sign out of this browser">Sign out</button>
        </div>
      </header>
      <main className="main">
        <header className="main-head">
          <span className="main-chapter" aria-hidden="true">{String(nav.findIndex(n => n.id === page) + 1).padStart(2, '0')}</span>
          <h1>{title}</h1>
          <span className="sub">signed in {ago(me.session.createdAt, now)} · stays signed in on this browser</span>
        </header>
        {admin && page === 'overview' && <Overview go={go} />}
        {admin && page === 'access' && <AccessLog go={go} initialIp={filter} />}
        {admin && page === 'visitors' && <Visitors key={filter} initialIp={filter} />}
        {admin && page === 'sessions' && <Sessions />}
        {admin && page === 'audit' && <AuditTrail />}
        {page === 'drive' && <DrivePage />}
        {page === 'links' && <LinksPage />}
        {page === 'security' && <SecurityPage me={me} />}
        {admin && page === 'system' && <SystemPage />}
      </main>
    </div>
  );
}

export function App() {
  const [phase, setPhase] = useState<Phase>({ kind: 'boot' });
  const booted = useRef(false);

  const resolve = useCallback(async () => {
    try {
      const me = await api('/api/auth/me');
      setCsrf(me.csrf);
      setPhase({ kind: 'console', me });
    } catch (err) {
      if (!(err instanceof ApiError) || err.status !== 401) console.warn(err);
      const status = await api('/api/public/status');
      if (status.banned) { setPhase({ kind: 'banned', until: status.bannedUntil ?? null }); return; }
      setPhase({ kind: 'gate', registration: Boolean(status.registration), adminReady: Boolean(status.adminReady), invite: Boolean(status.inviteRequired) });
    }
  }, []);

  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    void resolve();
  }, [resolve]);

  useEffect(() => onApiError(err => { if (err.code === 'BANNED') setPhase({ kind: 'banned', until: (err.extra?.until as number) ?? null }); }), []);

  const signedOut = useCallback(() => { setCsrf(''); void resolve(); }, [resolve]);

  if (phase.kind === 'boot') return <div className="boot"><Loading label="Loading" /></div>;
  if (phase.kind === 'banned') return <BannedScreen until={phase.until} />;
  if (phase.kind === 'gate') return <Gate registration={phase.registration} adminReady={phase.adminReady} invite={phase.invite} onAuthenticated={() => void resolve()} />;
  return <Console me={phase.me} onSignedOut={signedOut} />;
}

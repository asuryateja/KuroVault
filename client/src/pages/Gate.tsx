import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, setCsrf } from '../api';
import { fmtClock } from '../format';
import { Dot, Tag, useNow, type Tone } from '../ui';

type Check = { id: string; label: string; status?: 'pass' | 'warn' | 'fail'; ms?: number; detail?: string; running?: boolean };
type Connection = { ip: string; ipVersion: number; scope: string; protocol: string; tls: string | null; httpVersion: string; browser: string; os: string; automated: boolean; requestId: string; serverTime: number };

const statusTone = (s?: string): Tone => (s === 'pass' ? 'ok' : s === 'warn' ? 'warn' : s === 'fail' ? 'crit' : 'muted');

/** Runs every backend check one at a time so the screen shows what is actually executing. */
export function SystemSweep({ authenticated = false, onDone }: { authenticated?: boolean; onDone?: (checks: Check[]) => void }) {
  const [checks, setChecks] = useState<Check[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { checks: list } = await api<{ checks: Check[] }>('/api/public/checks');
        if (cancelled) return;
        const state: Check[] = list.map(c => ({ ...c }));
        setChecks([...state]);
        for (let i = 0; i < state.length; i += 1) {
          state[i] = { ...state[i], running: true };
          if (!cancelled) setChecks([...state]);
          try {
            const result = await api<Check>(`/api/public/checks/${state[i].id}`);
            state[i] = { ...result, running: false };
          } catch (e) {
            state[i] = { ...state[i], running: false, status: 'fail', detail: (e as Error).message };
          }
          if (!cancelled) setChecks([...state]);
        }
        if (!cancelled) onDone?.(state);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authenticated]);

  const done = checks.filter(c => c.status).length;
  return (
    <div className="sweep" aria-label="System checks">
      <div className="sweep-progress" aria-hidden="true"><span style={{ width: `${checks.length ? (done / checks.length) * 100 : 0}%` }} /></div>
      {error && <div className="error-note">{error}</div>}
      <ol className="sweep-list">
        {checks.map(c => (
          <li key={c.id} className={c.running ? 'is-running' : c.status ? `is-${c.status}` : 'is-queued'}>
            <span className="sweep-state">{c.running ? <span className="spinner" aria-label="Running" /> : <Dot tone={statusTone(c.status)} />}</span>
            <span className="sweep-label">{c.label}</span>
            <span className="sweep-detail">{c.running ? 'running…' : c.detail ?? 'queued'}</span>
            <span className="sweep-ms">{c.ms !== undefined ? `${c.ms} ms` : ''}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

type Loc = { city: string; region: string; country: string; countryCode: string; label: string } | null;

function ConnectionPanel() {
  const [conn, setConn] = useState<(Connection & { location?: Loc }) | null>(null);
  useEffect(() => { void api('/api/public/connection').then(setConn).catch(() => undefined); }, []);
  const rows: [string, string][] = conn ? [
    ['IP address', conn.ip],
    ['Location', conn.location?.label ?? (conn.scope === 'public' ? 'Unknown' : `${conn.scope} network`)],
    ['Protocol', `${conn.protocol.toUpperCase()} / HTTP ${conn.httpVersion}${conn.tls ? ` · ${conn.tls}` : ''}`],
    ['Browser', `${conn.browser} on ${conn.os}${conn.automated ? ' · automated' : ''}`],
  ] : [];
  return (
    <section className="gate-card gate-conn" aria-label="Your connection">
      <header className="gate-card-head"><h2>Your connection</h2>{conn && <Tag tone={conn.protocol === 'https' ? 'ok' : 'warn'}>{conn.protocol === 'https' ? 'Encrypted' : 'Not encrypted'}</Tag>}</header>
      <dl className="kv">
        {conn ? rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>) : <div><dt>Resolving</dt><dd>…</dd></div>}
      </dl>
      <p className="gate-note">This visit is recorded: IP address, location, browser, time and every sign-in attempt.</p>
    </section>
  );
}

type Mode = 'login' | 'register';

export function Gate({ registration, adminReady, invite, onAuthenticated }: { registration: boolean; adminReady: boolean; invite: boolean; onAuthenticated: () => void }) {
  const now = useNow();
  const [mode, setMode] = useState<Mode>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState({ name: '', username: '', password: '', confirm: '', invite: '' });
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm(f => ({ ...f, [k]: e.target.value }));
  const switchTo = (m: Mode) => { setMode(m); setError(''); setForm(f => ({ ...f, password: '', confirm: '' })); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'register') {
        if (form.password !== form.confirm) throw new Error('The two passwords do not match.');
        const r = await api<{ csrf: string }>('/api/auth/register', { method: 'POST', body: { name: form.name, username: form.username, password: form.password, confirm: form.confirm, ...(invite ? { invite: form.invite } : {}) } });
        setCsrf(r.csrf);
      } else {
        const r = await api<{ csrf: string }>('/api/auth/login', { method: 'POST', body: { username: form.username, password: form.password } });
        setCsrf(r.csrf);
      }
      onAuthenticated();
    } catch (err) {
      setError((err as ApiError).message);
      setForm(f => ({ ...f, password: '', confirm: '' }));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gate cover">
      <header className="cover-top">
        <span className="cover-mark"><img src="/logo.svg" alt="" /> <span>Kurovault</span></span>
        <span className="cover-vol">Vol. 01 · Private vault</span>
        <span className="strip-clock" aria-label="Server time (UTC)">{fmtClock(now)}</span>
      </header>

      <main className="cover-stage">
        <section className="cover-title" aria-label="Kurovault">
          <CoverSeal />
          <p className="cover-kicker">Your Telegram files · one private shelf</p>
          <h2 className="cover-name" aria-hidden="true">KUROVAULT</h2>
          <p className="cover-tag"><span>Open it.</span> <span>Play it.</span> <span>Keep it yours.</span></p>
        </section>

        <section className="cover-form gate-auth" aria-label={mode === 'login' ? 'Sign in' : 'Create account'}>
          <span className="cover-form-pin" aria-hidden="true">{mode === 'login' ? 'ENTER' : 'JOIN'}</span>
          <div className="auth-tabs" data-mode={mode} data-tabs={registration ? 2 : 1} role="tablist">
            <button type="button" role="tab" aria-selected={mode === 'login'} className={mode === 'login' ? 'on' : ''} onClick={() => switchTo('login')}>Sign in</button>
            {registration && <button type="button" role="tab" aria-selected={mode === 'register'} className={mode === 'register' ? 'on' : ''} onClick={() => switchTo('register')}>Create account</button>}
          </div>
          <h1>{mode === 'login' ? 'Welcome back.' : 'Start your shelf.'}</h1>
          <p className="gate-sub">{mode === 'login' ? 'Sign in to open your vault.' : (invite ? 'By invitation only. ' : '') + 'A name, a username, a password. Connect Telegram once — it stays connected.'}</p>
          <form onSubmit={submit} className="form" autoComplete="on">
            {mode === 'register' && <label className="field"><span>Name</span><input name="name" value={form.name} onChange={set('name')} autoComplete="name" required maxLength={80} /></label>}
            <label className="field"><span>Username</span><input name="username" value={form.username} onChange={set('username')} autoComplete="username" spellCheck={false} autoCapitalize="none" required maxLength={32} /></label>
            <label className="field"><span>Password</span><input name="password" type="password" value={form.password} onChange={set('password')} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} required /></label>
            {mode === 'register' && <label className="field"><span>Confirm password</span><input name="confirm" type="password" value={form.confirm} onChange={set('confirm')} autoComplete="new-password" required /></label>}
            {mode === 'register' && invite && <label className="field"><span>Invitation code</span><input name="invite" value={form.invite} onChange={set('invite')} autoComplete="off" spellCheck={false} autoCapitalize="none" required maxLength={128} /></label>}
            {mode === 'register' && <p className="hint">At least 8 characters, mixing letters with digits or symbols.</p>}
            {error && <div className="error-note" role="alert">{error}</div>}
            <button className="btn btn-primary btn-block btn-lg" disabled={busy}>{busy ? 'Please wait…' : mode === 'login' ? 'Sign in' : 'Register'}</button>
          </form>
          {registration && (
            <p className="auth-switch">
              {mode === 'login' ? <>New here? <button type="button" className="link" onClick={() => switchTo('register')}>Create an account</button></>
                : <>Already have an account? <button type="button" className="link" onClick={() => switchTo('login')}>Sign in</button></>}
            </p>
          )}
          {!adminReady && <p className="hint auth-admin-note">Administrator not set up yet: set <span className="mono">TDC_ADMIN_PASSWORD</span> on the server and restart.</p>}
        </section>
      </main>

      <section className="cover-panels" aria-label="Details">
        <ConnectionPanel />
        <section className="gate-card gate-sweep">
          <header className="gate-card-head"><h2>Application status</h2><span className="panel-meta">live · server-side</span></header>
          <SystemSweep />
        </section>
      </section>
    </div>
  );
}

/** An inked Japanese seal (hanko): a weathered double ring, a samurai kabuto helmet, and the kanji 黒蔵 (black vault). */
function CoverSeal() {
  return (
    <svg className="cover-seal" viewBox="0 0 240 240" role="img" aria-label="Kurovault seal">
      <g className="seal-ink">
        {/* weathered seal rings */}
        <circle cx="120" cy="120" r="112" fill="none" stroke="currentColor" strokeWidth="2" opacity="0.4" />
        <circle cx="120" cy="120" r="104" fill="none" stroke="currentColor" strokeWidth="8" />
        <circle cx="120" cy="120" r="90" fill="none" stroke="currentColor" strokeWidth="2" />
        {/* samurai kabuto */}
        <g fill="currentColor">
          {/* crescent maedate (crest) */}
          <path d="M120 40c-20 0-37 12-45 30 10-9 23-14 45-14s35 5 45 14c-8-18-25-30-45-30z" />
          {/* helmet bowl */}
          <path d="M78 116c0-30 19-50 42-50s42 20 42 50c-28-11-56-11-84 0z" />
          <path d="M120 66c-4 10-4 40-4 50h8c0-10 0-40-4-50z" fill="var(--bg)" opacity="0.9" />
          {/* fukigaeshi (side flaps) */}
          <path d="M70 118c-8 2-16 8-20 16 10-4 20-5 30-4z" />
          <path d="M170 118c8 2 16 8 20 16-10-4-20-5-30-4z" />
          {/* shikoro (neck guard, layered) */}
          <path d="M80 120h80l-5 14H85z" />
          <path d="M74 136h92l-6 15H80z" />
          <path d="M68 153h104l-7 15H75z" />
          {/* face opening */}
          <ellipse cx="120" cy="132" rx="11" ry="13" fill="var(--bg)" />
        </g>
        {/* kanji flanking the helmet */}
        <text className="seal-kanji" x="40" y="138" textAnchor="middle">黒</text>
        <text className="seal-kanji" x="200" y="138" textAnchor="middle">蔵</text>
      </g>
    </svg>
  );
}

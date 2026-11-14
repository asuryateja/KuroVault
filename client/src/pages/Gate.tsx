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
          <CoverArt />
          <p className="cover-kicker">Your Telegram files · one private shelf</p>
          <h2 className="cover-name" aria-hidden="true">KUROVAULT</h2>
          <p className="cover-tag"><span>Open it.</span> <span>Play it.</span> <span>Keep it yours.</span></p>
        </section>

        <section className="cover-form gate-auth" aria-label={mode === 'login' ? 'Sign in' : 'Create account'}>
          <span className="cover-form-pin" aria-hidden="true">{mode === 'login' ? 'ENTER' : 'JOIN'}</span>
          <div className="auth-tabs" role="tablist">
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

/** Cover art, drawn like a manga splash page: a halftone burst, speed lines, and three ink panels. */
function CoverArt() {
  const rays = Array.from({ length: 28 }, (_, i) => i * (360 / 28));
  return (
    <svg className="cover-art" viewBox="0 0 600 420" aria-hidden="true">
      <defs>
        <pattern id="tone" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><circle cx="4.5" cy="4.5" r="2.4" fill="#e9e4d8" /></pattern>
        <pattern id="tone-s" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><circle cx="3" cy="3" r="1.1" fill="#e9e4d8" /></pattern>
        <radialGradient id="fade" cx="50%" cy="50%" r="50%"><stop offset="0" stopColor="#e9e4d8" /><stop offset=".55" stopColor="#e9e4d8" stopOpacity=".55" /><stop offset="1" stopColor="#e9e4d8" stopOpacity="0" /></radialGradient>
        <mask id="burst"><circle cx="330" cy="200" r="230" fill="url(#fade)" /></mask>
      </defs>
      <circle cx="330" cy="200" r="150" fill="#e9e4d8" opacity=".06" />
      <g className="cover-rays" stroke="#e9e4d8" strokeLinecap="round">
        {rays.map((a, i) => <line key={a} x1="330" y1="200" x2="330" y2="-140" strokeWidth={i % 3 === 0 ? 3 : 1.2} strokeDasharray={i % 2 ? '70 300' : '40 330'} strokeDashoffset={i % 2 ? -150 : -190} transform={`rotate(${a} 330 200)`} opacity={i % 3 === 0 ? 0.9 : 0.5} />)}
      </g>
      <g className="ink ink-a" transform="translate(96 150) rotate(-9 90 70)">
        <rect x="7" y="7" width="180" height="128" rx="10" fill="#8f8c85" />
        <rect width="180" height="128" rx="10" fill="#101013" stroke="#e9e4d8" strokeWidth="4" />
        <rect x="12" y="12" width="156" height="74" rx="6" fill="#55545c" />
        <path d="M78 30v38l32-19Z" fill="#e9e4d8" stroke="#101013" strokeWidth="3" strokeLinejoin="round" />
        <rect x="12" y="98" width="96" height="9" fill="#e9e4d8" /><rect x="12" y="113" width="58" height="6" fill="#8f8c85" />
      </g>
      <g className="ink ink-c" transform="translate(380 176) rotate(8 80 60)">
        <rect x="7" y="7" width="164" height="118" rx="10" fill="#8f8c85" />
        <rect width="164" height="118" rx="10" fill="#101013" stroke="#e9e4d8" strokeWidth="4" />
        <rect x="14" y="14" width="42" height="54" fill="#e9e4d8" /><path d="M35 14v54M29 24h12M29 34h12M29 44h12" stroke="#101013" strokeWidth="3" />
        <rect x="68" y="20" width="80" height="9" fill="#e9e4d8" /><rect x="68" y="38" width="56" height="6" fill="#8f8c85" />
        <rect x="14" y="82" width="134" height="6" fill="#8f8c85" /><rect x="14" y="96" width="80" height="8" fill="#55545c" />
      </g>
      <g className="ink ink-b" transform="translate(214 96)">
        <rect x="8" y="8" width="208" height="170" rx="14" fill="#8f8c85" />
        <rect width="208" height="170" rx="14" fill="#101013" stroke="#e9e4d8" strokeWidth="5" />
        <rect x="16" y="16" width="176" height="96" rx="8" fill="#e9e4d8" />
        <rect x="16" y="16" width="176" height="96" fill="none" />
        <circle cx="104" cy="64" r="27" fill="#101013" /><path d="M95 49v30l26-15Z" fill="#e9e4d8" />
        <rect x="16" y="126" width="112" height="10" fill="#e9e4d8" /><rect x="16" y="144" width="70" height="7" fill="#8f8c85" />
        <rect x="152" y="134" width="40" height="18" fill="#e9e4d8" />
      </g>
      <g className="cover-sfx" fill="#e9e4d8" stroke="#101013" strokeWidth="3" strokeLinejoin="round">
        <path d="M470 60l10 24 26 2-20 17 7 26-23-14-22 14 6-26-20-17 26-2Z" />
        <path d="M120 96l6 14 15 1-12 10 4 15-13-8-13 8 4-15-12-10 15-1Z" />
      </g>
    </svg>
  );
}

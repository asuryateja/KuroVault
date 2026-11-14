import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { fmtTime } from '../format';
import { DataTable, Dialog, Empty, ErrorNote, Loading, Panel, Tag, usePoll } from '../ui';

export type TgState = { mode: 'desktop' | 'telegram'; connected: boolean; keyConfigured: boolean; state: string; error: string | null; account: { name: string; username: string | null } | null; serverCredentials?: boolean; canUseDesktop?: boolean; savedApp?: { apiIdHint: string } | null };

type Step = 'creds' | 'code' | 'password' | 'qr' | 'done';

/** Sign Kurovault into Telegram. The API hash and the resulting session are sealed on the server, never kept in the browser. */
export function TelegramConnect({ onConnected, serverCredentials = false, savedApp = null }: { onConnected: () => void; serverCredentials?: boolean; savedApp?: { apiIdHint: string } | null }) {
  const [changeApp, setChangeApp] = useState(false);
  const needApp = changeApp || (!savedApp && !serverCredentials);
  const [method, setMethod] = useState<'phone' | 'qr'>('phone');
  const [step, setStep] = useState<Step>('creds');
  const [apiId, setApiId] = useState('');
  const [apiHash, setApiHash] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [hint, setHint] = useState('');
  const [viaApp, setViaApp] = useState(true);
  const [qr, setQr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const qrMode = useRef(false);

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await fn(); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  const done = () => { setStep('done'); onConnected(); };

  async function start(e: FormEvent) {
    e.preventDefault();
    await act(async () => {
      if (method === 'phone') {
        const r = await api('/api/telegram/login/start', { method: 'POST', body: needApp ? { apiId, apiHash, phone } : { phone } });
        setViaApp(Boolean(r.viaApp));
        setStep('code');
      } else {
        const r = await api('/api/telegram/login/qr', { method: 'POST', body: needApp ? { apiId, apiHash } : {} });
        qrMode.current = true;
        setQr(r.qr);
        setStep('qr');
      }
    });
  }
  async function sendCode(e: FormEvent) {
    e.preventDefault();
    await act(async () => {
      const r = await api('/api/telegram/login/code', { method: 'POST', body: { code } });
      if (r.step === 'password') { setHint(r.hint ?? ''); setStep('password'); } else done();
    });
  }
  async function sendPassword(e: FormEvent) {
    e.preventDefault();
    await act(async () => {
      await api('/api/telegram/login/password', { method: 'POST', body: { password } });
      setPassword('');
      done();
    });
  }
  async function cancel() {
    qrMode.current = false;
    await api('/api/telegram/login/cancel', { method: 'POST' }).catch(() => undefined);
    setStep('creds'); setCode(''); setPassword(''); setQr(null); setError(null);
  }

  // QR: poll until the phone approves, then ask for the 2FA password if the account has one.
  useEffect(() => {
    if (step !== 'qr') return undefined;
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const r = await api('/api/telegram/login/qr');
        if (stop) return;
        if (r.step === 'done') { done(); return; }
        if (r.step === 'password') { setHint(r.hint ?? ''); setStep('password'); return; }
        if (r.step === 'error') { setError(new Error(r.error ?? 'Telegram rejected the QR sign-in.')); setStep('creds'); return; }
        if (r.qr) setQr(r.qr);
      } catch (e) { setError(e); }
      window.setTimeout(tick, 1500);
    };
    const t = window.setTimeout(tick, 1500);
    return () => { stop = true; window.clearTimeout(t); };
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

  if (step === 'done') return <div className="ok-note" role="status">Telegram connected.</div>;

  return (
    <div className="tg-connect">
      {step === 'creds' && (
        <form className="form" onSubmit={start} aria-label="Connect Telegram">
          {!needApp ? (
            <>
              <p className="sub tg-help">Sign in with the phone number of your Telegram account, or scan a QR code with the Telegram app. Kurovault keeps you connected after that.</p>
              {savedApp && <p className="sub tg-saved">Using your saved Telegram app (API ID {savedApp.apiIdHint}). <button type="button" className="link" onClick={() => setChangeApp(true)}>Use a different API ID</button></p>}
            </>
          ) : (
            <>
              <p className="sub tg-help">Create an app at <span className="mono">my.telegram.org</span> → <b>API development tools</b> and paste its two values here. Kurovault seals them on this server; your browser never stores them. You only do this once.</p>
              <div className="form-2">
                <label className="field"><span>API ID</span><input className="mono" inputMode="numeric" value={apiId} onChange={e => setApiId(e.target.value)} autoComplete="off" required /></label>
                <label className="field"><span>API hash</span><input className="mono" type="password" value={apiHash} onChange={e => setApiHash(e.target.value)} autoComplete="off" required /></label>
              </div>
            </>
          )}
          <div className="seg" role="group" aria-label="Sign-in method">
            <button type="button" className={method === 'phone' ? 'on' : ''} onClick={() => setMethod('phone')}>Phone number</button>
            <button type="button" className={method === 'qr' ? 'on' : ''} onClick={() => setMethod('qr')}>QR code</button>
          </div>
          {method === 'phone' && <label className="field"><span>Phone number</span><input className="mono" type="tel" placeholder="+44 7700 900123" value={phone} onChange={e => setPhone(e.target.value)} autoComplete="tel" required /></label>}
          <ErrorNote error={error} />
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Contacting Telegram…' : method === 'phone' ? 'Send login code' : 'Show QR code'}</button>
        </form>
      )}
      {step === 'code' && (
        <form className="form" onSubmit={sendCode} aria-label="Telegram login code">
          <p className="sub">{viaApp ? 'Telegram sent a code to your other Telegram apps (look for the “Telegram” service chat).' : 'Telegram sent the code by SMS.'}</p>
          <label className="field"><span>Login code</span><input className="mono" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={e => setCode(e.target.value)} required autoFocus /></label>
          <ErrorNote error={error} />
          <div className="row-gap"><button className="btn btn-primary" disabled={busy}>Sign in</button><button type="button" className="btn btn-ghost" onClick={cancel}>Cancel</button></div>
        </form>
      )}
      {step === 'password' && (
        <form className="form" onSubmit={sendPassword} aria-label="Telegram two-step password">
          <p className="sub">This account has two-step verification.{hint ? ` Hint: ${hint}` : ''}</p>
          <label className="field"><span>Two-step password</span><input type="password" autoComplete="off" value={password} onChange={e => setPassword(e.target.value)} required autoFocus /></label>
          <ErrorNote error={error} />
          <div className="row-gap"><button className="btn btn-primary" disabled={busy}>Unlock</button><button type="button" className="btn btn-ghost" onClick={cancel}>Cancel</button></div>
        </form>
      )}
      {step === 'qr' && (
        <div className="tg-qr">
          {qr ? <img src={qr} alt="Telegram login QR code" width={208} height={208} /> : <Loading label="Waiting for Telegram" />}
          <ol className="sub">
            <li>Open Telegram on your phone.</li>
            <li>Settings → Devices → <b>Link Desktop Device</b>.</li>
            <li>Point the camera at this code.</li>
          </ol>
          <ErrorNote error={error} />
          <button type="button" className="btn btn-ghost btn-sm" onClick={cancel}>Cancel</button>
        </div>
      )}
    </div>
  );
}

/** Source settings: direct Telegram (recommended for hosting) or the desktop app's REST API. */
export function SourcePanel({ desktop, onChanged, desktopOpen = false }: { desktop: ReactNode; onChanged: () => void; desktopOpen?: boolean }) {
  const state = usePoll(() => api<TgState>('/api/telegram/state'), 15000);
  const [error, setError] = useState<unknown>(null);
  const [showDesktop, setShowDesktop] = useState(desktopOpen);
  const s = state.data;
  const refresh = () => { void state.refresh(); onChanged(); };
  const run = async (fn: () => Promise<unknown>) => { setError(null); try { await fn(); refresh(); } catch (e) { setError(e); } };

  return (
    <div className="source-stack">
      <Panel title="Telegram account" meta="direct · no desktop app needed">
        {!s ? <Loading /> : s.keyConfigured ? (
          <div className="tg-linked">
            <div className="link-status">
              <span><b>{s.account?.name ?? 'Telegram account'}</b>{s.account?.username ? <span className="sub mono"> @{s.account.username}</span> : null}</span>
              {s.connected ? <Tag tone="ok">connected</Tag> : <Tag tone="warn">{s.state === 'connecting' ? 'connecting' : 'offline'}</Tag>}
              {s.mode === 'telegram' ? <Tag tone="info">active source</Tag> : <Tag>not in use</Tag>}
            </div>
            {s.error && <div className="error-note" role="alert">{s.error}</div>}
            <div className="row-gap">
              {s.mode !== 'telegram' && <button className="btn btn-primary btn-sm" onClick={() => run(() => api('/api/telegram/mode', { method: 'POST', body: { mode: 'telegram' } }))}>Use Telegram account</button>}
              <button className="btn btn-danger btn-sm" onClick={() => run(() => api('/api/telegram/logout', { method: 'POST' }))}>Disconnect Telegram</button>
            </div>
          </div>
        ) : <>{s.error && <div className="error-note tg-note" role="status">{s.error}</div>}<TelegramConnect onConnected={refresh} serverCredentials={Boolean(s.serverCredentials)} savedApp={s.savedApp ?? null} /></>}
        <ErrorNote error={error} />
      </Panel>
      {s?.canUseDesktop && <div className="source-alt">
        <button type="button" className="link-plain" onClick={() => setShowDesktop(v => !v)} aria-expanded={showDesktop}>
          {showDesktop ? 'Hide' : 'Use the Telegram Drive desktop app instead'}
        </button>
        {s?.mode === 'telegram' && showDesktop && <button className="btn btn-ghost btn-sm" onClick={() => run(() => api('/api/telegram/mode', { method: 'POST', body: { mode: 'desktop' } }))}>Switch to desktop app</button>}
      </div>}
      {s?.canUseDesktop && showDesktop && desktop}
    </div>
  );
}

/** Pick channels and groups to show as folders. */
export function ChatPicker({ onClose, onChanged }: { onClose: () => void; onChanged: () => void }) {
  const chats = usePoll(() => api('/api/telegram/chats'), 0);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<unknown>(null);
  const toggle = async (c: any) => {
    setError(null);
    try {
      if (c.added) await api(`/api/telegram/folders/${c.id}`, { method: 'DELETE' });
      else await api('/api/telegram/folders', { method: 'POST', body: { id: String(c.id) } });
      await chats.refresh();
      onChanged();
    } catch (e) { setError(e); }
  };
  const rows = (chats.data?.chats ?? []).filter((c: any) => c.title.toLowerCase().includes(filter.toLowerCase()));
  return (
    <Dialog title="Channels and groups" onClose={onClose}>
      <p className="sub">Add a chat to browse its videos, music and documents as a folder. Forward anything into Saved Messages and it shows up automatically.</p>
      <input className="input-sm" type="search" placeholder="Filter chats" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Filter chats" />
      <ErrorNote error={error ?? chats.error} />
      {chats.loading && !chats.data ? <Loading /> : rows.length === 0 ? <Empty>No channels or groups found.</Empty> : (
        <ul className="chat-list">
          {rows.map((c: any) => (
            <li key={c.id}>
              <span className="clip-text"><b>{c.title}</b> <span className="sub">{c.type}{c.owned ? ' · yours' : ''}</span></span>
              {c.protected && <Tag tone="warn" title="Content protection: watch only, no downloads">protected</Tag>}
              <button className={`btn btn-sm ${c.added ? 'btn-ghost' : 'btn-primary'}`} onClick={() => toggle(c)} aria-label={`${c.added ? 'Remove' : 'Add'} ${c.title}`}>{c.added ? 'Remove' : 'Add'}</button>
            </li>
          ))}
        </ul>
      )}
      <button className="btn btn-ghost btn-block" onClick={onClose}>Done</button>
    </Dialog>
  );
}

/** Every device signed into the Telegram account, with remote sign-out. */
export function TelegramSessions() {
  const state = usePoll(() => api<TgState>('/api/telegram/state'), 30000);
  const connected = Boolean(state.data?.connected);
  const account = usePoll(async () => (connected ? api('/api/telegram/account') : null), 30000, [connected]);
  const [error, setError] = useState<unknown>(null);
  const [note, setNote] = useState('');
  if (!state.data?.keyConfigured) return null;
  const terminate = async (s: any) => {
    setError(null);
    try {
      await api('/api/telegram/sessions/terminate', { method: 'POST', body: { hash: s.hash } });
      setNote(`Signed out ${s.device} (${s.ip}).`);
      void account.refresh();
    } catch (e) { setError(e); }
  };
  const sessions: any[] = account.data?.sessions ?? [];
  return (
    <Panel title="Telegram sessions" meta={account.data?.me ? `${account.data.me.name}${account.data.me.username ? ` · @${account.data.me.username}` : ''}` : 'devices signed into your account'} flush>
      <ErrorNote error={error ?? account.error} />
      {note && <div className="ok-note" role="status">{note}</div>}
      {!connected ? <Empty>Telegram is offline. Reconnect it from the Vault.</Empty> : account.loading && !account.data ? <Loading /> : (
        <DataTable<any> label="Telegram sessions" rows={sessions} rowKey={s => s.hash} columns={[
          { key: 'device', label: 'Device', primary: true, render: s => <span>{s.device} {s.current && <Tag tone="info">current</Tag>} {!s.official && !s.current && <Tag tone="warn" title="Not an official Telegram app">third-party</Tag>}</span> },
          { key: 'app', label: 'App', className: 'sub', render: s => `${s.app} · ${s.platform}` },
          { key: 'ip', label: 'IP', className: 'mono', render: s => s.ip },
          { key: 'where', label: 'Location', render: s => [s.region, s.country].filter(Boolean).join(', ') },
          { key: 'active', label: 'Last active', className: 'mono nowrap', render: s => fmtTime(s.active) },
          { key: 'act', label: 'Action', actions: true, render: s => (s.current ? <span className="sub">this server</span> : <button className="btn btn-danger btn-sm" onClick={() => terminate(s)} aria-label={`Terminate ${s.device}`}>Terminate</button>) },
        ]} />
      )}
    </Panel>
  );
}

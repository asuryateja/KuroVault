import { useMemo, useState, type FormEvent } from 'react';
import { api } from '../api';
import { fmtBytes, fmtTime } from '../format';
import { Empty, ErrorNote, Loading, Tag, usePoll } from '../ui';
import { IconFilm, IconFolder, IconImage, IconPdf, IconPlay, IconTrash, IconWave } from '../icons';
import { Viewer } from '../viewer/Viewer';
import { ConfirmDialog } from '../vault/parts';
import type { DriveFile } from '../media';

type Link = { id: number; url: string; title: string; mime: string; kind: 'video' | 'audio' | 'image' | 'pdf' | 'file'; size: number; added_at: number; src: string };
type StFile = { id: string; linkid: string; name: string; size: number; converted: boolean; src: string };

const KIND_ICON = { video: IconFilm, audio: IconWave, image: IconImage, pdf: IconPdf, file: IconFilm } as const;

/** Shape any external media so the normal viewer can stream and play it. */
function asFile(id: number, name: string, mime: string, size: number, src: string): DriveFile {
  return { id, folder_id: null, name, size, mime_type: mime, created_at: new Date().toISOString(), encrypted: false, src: { stream: src, download: src, thumb: null, info: null } };
}
const hostOf = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url.slice(0, 40); } };

export function LinksPage() {
  return (
    <div className="page links-page">
      <DirectLinks />
      <StreamtapePanel />
    </div>
  );
}

// ─── Paste a direct link ──────────────────────────────────────────────
function DirectLinks() {
  const { data, error, loading, refresh } = usePoll(() => api<{ links: Link[] }>('/api/links'), 20000);
  const [url, setUrl] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<unknown>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [removing, setRemoving] = useState<Link | null>(null);

  const links = data?.links ?? [];
  const files = useMemo(() => links.map(l => asFile(l.id, l.title, l.mime, l.size, l.src)), [links]);

  async function add(e: FormEvent) {
    e.preventDefault();
    setAddError(null);
    setBusy(true);
    try {
      await api('/api/links', { method: 'POST', body: { url: url.trim(), ...(title.trim() ? { title: title.trim() } : {}) } });
      setUrl(''); setTitle(''); void refresh();
    } catch (err) { setAddError(err); } finally { setBusy(false); }
  }

  return (
    <>
      <section className="panel links-add">
        <header className="panel-head"><h2>Play a link</h2><span className="panel-meta">a direct audio or video URL</span></header>
        <form className="form links-form" onSubmit={add}>
          <label className="field"><span>Video or audio link</span>
            <input type="url" inputMode="url" placeholder="https://example.com/clip.mp4" value={url} onChange={e => setUrl(e.target.value)} required maxLength={2048} spellCheck={false} autoCapitalize="none" />
          </label>
          <label className="field"><span>Name (optional)</span>
            <input type="text" placeholder="What is it?" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} />
          </label>
          <ErrorNote error={addError} />
          <p className="hint">Paste a link that points straight at the file — it usually ends in .mp4, .webm or .m3u8. Kurovault checks it really is a media file, then plays it here. It can’t open pages that need their own app or sign-in.</p>
          <button className="btn btn-primary" disabled={busy}>{busy ? 'Checking…' : 'Get video'}</button>
        </form>
      </section>

      <section className="panel" aria-label="Saved links">
        <header className="panel-head"><h2>Your links</h2>{data && <span className="panel-meta">{links.length} saved</span>}</header>
        {loading && !data ? <Loading /> : <ErrorNote error={error} />}
        {data && (links.length === 0
          ? <Empty>No links yet. Paste a direct video or audio URL above to play it here.</Empty>
          : <ul className="links-grid">
              {links.map((l, i) => {
                const Icon = KIND_ICON[l.kind] ?? IconFilm;
                return (
                  <li key={l.id} className="link-card">
                    <button type="button" className="link-open" onClick={() => setOpen(i)} aria-label={`Play ${l.title}`}>
                      <span className="link-thumb"><Icon width={22} height={22} /><span className="link-play"><IconPlay width={16} height={16} /></span></span>
                      <span className="link-body">
                        <span className="link-title" title={l.title}>{l.title}</span>
                        <span className="sub mono">{l.kind}{l.size ? ` · ${fmtBytes(l.size)}` : ''} · {fmtTime(l.added_at)}</span>
                        <span className="sub link-host">{hostOf(l.url)}</span>
                      </span>
                    </button>
                    <button type="button" className="icon-btn link-del" onClick={() => setRemoving(l)} aria-label={`Remove ${l.title}`}><IconTrash width={16} height={16} /></button>
                  </li>
                );
              })}
            </ul>)}
      </section>

      {open !== null && files[open] && <Viewer files={files} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
      {removing && <ConfirmDialog title={`Remove ${removing.title}?`} confirmLabel="Remove link" onClose={() => setRemoving(null)}
        message={<>This removes the saved link from Kurovault. The file on its original host is not touched.</>}
        onConfirm={async () => { await api(`/api/links/${removing.id}`, { method: 'DELETE' }); setRemoving(null); void refresh(); }} />}
    </>
  );
}

// ─── Streamtape: your own account ─────────────────────────────────────
type StAccount = { connected: boolean; loginHint?: string; account?: { email: string | null; plan: string | null } | null; warning?: string };

function StreamtapePanel() {
  const { data: acct, error, loading, refresh } = usePoll(() => api<StAccount>('/api/streamtape/account'), 60000);
  if (loading && !acct) return <section className="panel"><header className="panel-head"><h2>Streamtape</h2></header><Loading /></section>;
  if (error) return <section className="panel"><header className="panel-head"><h2>Streamtape</h2></header><ErrorNote error={error} /></section>;
  return acct?.connected ? <StreamtapeLibrary account={acct} onDisconnect={refresh} /> : <StreamtapeConnect onConnected={refresh} />;
}

function StreamtapeConnect({ onConnected }: { onConnected: () => void }) {
  const [login, setLogin] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  async function connect(e: FormEvent) {
    e.preventDefault();
    setErr(null); setBusy(true);
    try { await api('/api/streamtape/connect', { method: 'POST', body: { login: login.trim(), key: key.trim() } }); onConnected(); }
    catch (e2) { setErr(e2); } finally { setBusy(false); }
  }
  return (
    <section className="panel">
      <header className="panel-head"><h2>Streamtape</h2><span className="panel-meta">your own account</span></header>
      <form className="form links-form" onSubmit={connect}>
        <p className="hint">Connect your own Streamtape account to browse and play the files in it. Find your API login and key in Streamtape under <span className="mono">Account → API</span>. They are sealed on the server and never shown again.</p>
        <label className="field"><span>API login</span><input value={login} onChange={e => setLogin(e.target.value)} required maxLength={128} spellCheck={false} autoCapitalize="none" autoComplete="off" /></label>
        <label className="field"><span>API key</span><input type="password" value={key} onChange={e => setKey(e.target.value)} required maxLength={256} spellCheck={false} autoComplete="off" /></label>
        <ErrorNote error={err} />
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Connecting…' : 'Connect Streamtape'}</button>
      </form>
    </section>
  );
}

function StreamtapeLibrary({ account, onDisconnect }: { account: StAccount; onDisconnect: () => void }) {
  const [folder, setFolder] = useState('');
  const [trail, setTrail] = useState<{ id: string; name: string }[]>([]);
  const { data, error, loading } = usePoll(() => api<{ folders: { id: string; name: string }[]; files: StFile[] }>(`/api/streamtape/files${folder ? `?folder=${encodeURIComponent(folder)}` : ''}`), 0, [folder]);
  const [open, setOpen] = useState<number | null>(null);
  const [disc, setDisc] = useState(false);

  const playable = (data?.files ?? []).filter(f => f.converted);
  const files = useMemo(() => playable.map((f, i) => asFile(i, f.name, 'video/mp4', f.size, f.src)), [playable]);
  const openFolder = (id: string, name: string) => { setTrail(t => [...t, { id: folder, name: name }]); setFolder(id); };
  const goTo = (i: number) => { setTrail(t => t.slice(0, i)); setFolder(i === 0 ? '' : trail[i].id); };

  return (
    <section className="panel" aria-label="Streamtape library">
      <header className="panel-head">
        <h2>Streamtape</h2>
        <span className="panel-meta">{account.account?.email ? account.account.email : `connected ${account.loginHint ?? ''}`}</span>
        <button className="btn btn-ghost btn-sm" onClick={() => setDisc(true)}>Disconnect</button>
      </header>
      {account.warning && <div className="hint" style={{ padding: '8px 16px 0' }}>{account.warning}</div>}
      <div className="st-crumbs">
        <button type="button" className="link-plain" onClick={() => goTo(0)}>Home</button>
        {trail.slice(1).map((c, i) => <span key={c.id || i}><span className="crumb-sep">/</span><button type="button" className="link-plain" onClick={() => goTo(i + 1)}>{c.name}</button></span>)}
      </div>
      {loading && !data ? <Loading /> : <ErrorNote error={error} />}
      {data && (
        <>
          {data.folders.length > 0 && <div className="st-folders">
            {data.folders.map(f => <button key={f.id} type="button" className="btn btn-ghost btn-sm st-folder" onClick={() => openFolder(f.id, f.name)}><IconFolder width={15} height={15} /> {f.name}</button>)}
          </div>}
          {data.files.length === 0 && data.folders.length === 0
            ? <Empty>This account has no files here.</Empty>
            : <ul className="links-grid">
                {data.files.map(f => {
                  const idx = playable.findIndex(p => p.linkid === f.linkid);
                  return (
                    <li key={f.linkid} className="link-card">
                      <button type="button" className="link-open" disabled={!f.converted} onClick={() => idx >= 0 && setOpen(idx)} aria-label={`Play ${f.name}`}>
                        <span className="link-thumb"><IconFilm width={22} height={22} />{f.converted && <span className="link-play"><IconPlay width={16} height={16} /></span>}</span>
                        <span className="link-body">
                          <span className="link-title" title={f.name}>{f.name}</span>
                          <span className="sub mono">{f.size ? fmtBytes(f.size) : 'video'}</span>
                          {!f.converted && <span className="sub"><Tag tone="warn">processing</Tag></span>}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>}
        </>
      )}
      {open !== null && files[open] && <Viewer files={files} index={open} onIndex={setOpen} onClose={() => setOpen(null)} />}
      {disc && <ConfirmDialog title="Disconnect Streamtape?" confirmLabel="Disconnect" onClose={() => setDisc(false)}
        message={<>Kurovault will forget your Streamtape API login and key and clear the file list. Your Streamtape account itself is not changed.</>}
        onConfirm={async () => { await api('/api/streamtape/disconnect', { method: 'POST', body: {} }); setDisc(false); onDisconnect(); }} />}
    </section>
  );
}

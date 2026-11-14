import { useEffect, useMemo, useState, type ComponentType } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { fmtBytes } from '../format';
import { IconArchive, IconDownload, IconFile, IconFilm, IconFolder, IconImage, IconLock, IconPdf, IconWave } from '../icons';
import { archiveUrl, downloadUrl, kindOf, KIND_LABEL, type DriveFile, type MediaKind } from '../media';
import { ErrorNote } from '../ui';
import { Viewer } from './Viewer';

type Entry = { index: number; path: string; dir: boolean; size: number; packed: number; encrypted: boolean; supported: boolean; method: string; date: number | null };
type Listing = { kind: 'zip' | 'rar'; name: string; protected: boolean; entries: Entry[] };
type Pending = { pending: true; kind: string; received: number; size: number };

const ICON: Record<MediaKind, ComponentType<{ width?: number; height?: number }>> = {
  video: IconFilm, audio: IconWave, image: IconImage, pdf: IconPdf, archive: IconArchive, encrypted: IconLock, other: IconFile,
};
const PLAYABLE = new Set<MediaKind>(['video', 'audio', 'image', 'pdf']);
const base = (p: string) => p.split('/').pop() ?? p;
const parent = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** Browse a ZIP or RAR and open what is inside with the normal players, without downloading the archive. */
export function ArchiveBrowser({ file }: { file: DriveFile }) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [dir, setDir] = useState('');
  const [filter, setFilter] = useState('');
  const [viewing, setViewing] = useState<{ files: DriveFile[]; index: number } | null>(null);

  useEffect(() => {
    let stop = false;
    let timer = 0;
    setListing(null); setPending(null); setError(null); setDir(''); setFilter('');
    const load = async () => {
      try {
        const r = await api<Listing | Pending>(archiveUrl(file));
        if (stop) return;
        if ('pending' in r) { setPending(r); timer = window.setTimeout(load, 700); return; }
        setPending(null);
        setListing(r);
      } catch (e) { if (!stop) setError(e); }
    };
    void load();
    return () => { stop = true; window.clearTimeout(timer); };
  }, [file]);

  const q = file.folder_id !== null ? `?folder_id=${file.folder_id}` : '';
  const asFile = (e: Entry): DriveFile => ({
    id: e.index, folder_id: null, name: base(e.path), size: e.size, mime_type: '', created_at: new Date(e.date ?? Date.parse(file.created_at)).toISOString(),
    encrypted: e.encrypted, protected: listing?.protected,
    src: {
      stream: `/api/archive/${file.id}/entries/${e.index}/stream${q}`,
      download: listing?.protected ? null : `/api/archive/${file.id}/entries/${e.index}/download${q}`,
      thumb: null, info: null,
    },
  });

  // Folders may be implied by file paths only (many ZIPs have no folder entries).
  const { folders, files } = useMemo(() => {
    const all = listing?.entries ?? [];
    const dirs = new Set<string>();
    for (const e of all) {
      let p = e.dir ? e.path : parent(e.path);
      while (p) { dirs.add(p); p = parent(p); }
    }
    if (filter.trim()) {
      const f = filter.trim().toLowerCase();
      return { folders: [] as string[], files: all.filter(e => !e.dir && e.path.toLowerCase().includes(f)) };
    }
    return {
      folders: [...dirs].filter(d => parent(d) === dir).sort((a, b) => a.localeCompare(b)),
      files: all.filter(e => !e.dir && parent(e.path) === dir).sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true })),
    };
  }, [listing, dir, filter]);

  const playable = files.filter(e => e.supported && PLAYABLE.has(kindOf(asFile(e))));
  const open = (e: Entry) => {
    const list = playable.map(asFile);
    setViewing({ files: list, index: Math.max(0, playable.findIndex(p => p.index === e.index)) });
  };

  if (error) return <div className="viewer-note"><span className="viewer-note-icon"><IconArchive width={26} height={26} /></span><h3>Can’t open this archive</h3><ErrorNote error={error} /></div>;
  if (!listing) {
    const pct = pending && pending.size ? Math.round((pending.received / pending.size) * 100) : null;
    return (
      <div className="viewer-note arch-loading" role="status">
        <span className="viewer-note-icon"><IconArchive width={26} height={26} /></span>
        <h3>{pending ? 'Fetching the RAR archive' : 'Reading archive'}</h3>
        {pending ? <>
          <p>RAR files are fetched once to the server so their contents can be opened. {fmtBytes(pending.received)} of {fmtBytes(pending.size)}</p>
          <div className="up-bar arch-progress" aria-label="Fetch progress" aria-valuenow={pct ?? 0} role="progressbar"><span style={{ width: `${pct ?? 0}%` }} /></div>
        </> : <span className="spinner spinner-lg" aria-hidden="true" />}
      </div>
    );
  }

  const totalFiles = listing.entries.filter(e => !e.dir).length;
  const totalSize = listing.entries.reduce((s, e) => s + e.size, 0);
  const crumbs = dir ? dir.split('/') : [];

  return (
    <div className="arch" data-testid="archive-browser">
      <div className="arch-head">
        <nav className="arch-crumbs" aria-label="Archive path">
          <button className="link-plain" onClick={() => { setDir(''); setFilter(''); }}>{listing.kind.toUpperCase()}</button>
          {crumbs.map((c, i) => (
            <span key={i}><span className="crumb-sep">/</span><button className="link-plain" onClick={() => { setDir(crumbs.slice(0, i + 1).join('/')); setFilter(''); }}>{c}</button></span>
          ))}
        </nav>
        <span className="sub mono">{totalFiles} {totalFiles === 1 ? 'file' : 'files'} · {fmtBytes(totalSize)} unpacked</span>
        <input className="input-sm arch-filter" type="search" placeholder="Find in archive" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Find in archive" />
      </div>
      {listing.protected && <div className="sub arch-note">Protected chat: files open here but cannot be downloaded.</div>}
      <ul className="arch-list" aria-label="Archive contents">
        {dir && !filter && (
          <li><button className="arch-row" onClick={() => setDir(parent(dir))}><span className="kind-dot"><IconFolder width={15} height={15} /></span><span className="clip-text">..</span></button></li>
        )}
        {folders.map(d => (
          <li key={d}>
            <button className="arch-row" onClick={() => setDir(d)} aria-label={`Open folder ${base(d)}`}>
              <span className="kind-dot kind-folder"><IconFolder width={15} height={15} /></span>
              <span className="clip-text">{base(d)}</span>
              <span className="sub mono">{(n => `${n} ${n === 1 ? 'file' : 'files'}`)(listing.entries.filter(e => !e.dir && e.path.startsWith(`${d}/`)).length)}</span>
            </button>
          </li>
        ))}
        {files.map(e => {
          const f = asFile(e);
          const kind = kindOf(f);
          const Icon = ICON[kind];
          const canPlay = e.supported && PLAYABLE.has(kind);
          const dl = e.supported ? downloadUrl(f) : null;
          return (
            <li key={e.index}>
              <div className={`arch-row ${canPlay ? '' : 'is-static'}`}>
                {canPlay
                  ? <button className="arch-open" onClick={() => open(e)} aria-label={`Open ${e.path}`}><span className={`kind-dot kind-${kind}`}><Icon width={15} height={15} /></span><span className="clip-text">{filter ? e.path : base(e.path)}</span></button>
                  : <span className="arch-open"><span className={`kind-dot kind-${kind}`}><Icon width={15} height={15} /></span><span className="clip-text">{filter ? e.path : base(e.path)}</span></span>}
                {e.encrypted ? <span className="tag tag-warn">password</span> : !e.supported ? <span className="tag tag-warn" title={`Compression: ${e.method}`}>unsupported</span> : <span className="sub">{KIND_LABEL[kind]}</span>}
                <span className="sub mono arch-size">{fmtBytes(e.size)}</span>
                {dl ? <a className="icon-btn" href={dl} download aria-label={`Download ${e.path}`}><IconDownload width={15} height={15} /></a> : <span className="arch-dl-gap" />}
              </div>
            </li>
          );
        })}
        {folders.length === 0 && files.length === 0 && <li className="sub arch-empty">{filter ? 'Nothing matches.' : 'This folder is empty.'}</li>}
      </ul>
      {viewing && createPortal(
        <Viewer files={viewing.files} index={viewing.index} onIndex={i => setViewing(v => (v ? { ...v, index: i } : v))} onClose={() => setViewing(null)} />,
        document.body,
      )}
    </div>
  );
}

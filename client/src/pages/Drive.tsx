import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { api } from '../api';
import { fmtBytes, fmtTime } from '../format';
import {
  IconDownload, IconArchive, IconFile, IconFilm, IconGrid, IconImage, IconList, IconLock, IconMenu, IconNext, IconPdf, IconPlay, IconTrash, IconUpload, IconWave,
} from '../icons';
import { downloadUrl, kindOf, KIND_LABEL, thumbUrl, type DriveFile, type MediaKind } from '../media';
import { DataTable, Empty, ErrorNote, Loading, Panel, Tag, usePoll } from '../ui';
import { uploadFile, type UploadItem } from '../vault/uploads';
import { SourcePanel } from '../vault/Telegram';
import { ChatSections, LibraryHome, type Chat } from '../vault/Library';
import { buildTree, ConfirmDialog, DRAG_TYPE, folderPath, FolderPicker, Menu, MenuItem, TextDialog, useDropTarget, type Folder, type TreeNode } from '../vault/parts';
import { Viewer } from '../viewer/Viewer';

type Loc =
  | { kind: 'all' } | { kind: 'saved' } | { kind: 'folder'; id: number }
  | { kind: 'recent' } | { kind: 'favorite' } | { kind: 'pin' }
  | { kind: 'large' } | { kind: 'old' } | { kind: 'duplicates' } | { kind: 'empty' };

const TYPES: { id: string; label: string; mime?: string; kinds?: MediaKind[] }[] = [
  { id: 'all', label: 'All' },
  { id: 'video', label: 'Videos', mime: 'video', kinds: ['video'] },
  { id: 'audio', label: 'Audio', mime: 'audio', kinds: ['audio'] },
  { id: 'image', label: 'Images', mime: 'image', kinds: ['image'] },
  { id: 'pdf', label: 'PDFs', mime: 'application/pdf', kinds: ['pdf'] },
];
const SORTS: Record<string, { label: string; sort: string; order: 'asc' | 'desc' }> = {
  newest: { label: 'Newest first', sort: 'created_at', order: 'desc' },
  oldest: { label: 'Oldest first', sort: 'created_at', order: 'asc' },
  'name-asc': { label: 'Name A–Z', sort: 'name', order: 'asc' },
  'name-desc': { label: 'Name Z–A', sort: 'name', order: 'desc' },
  largest: { label: 'Largest first', sort: 'size', order: 'desc' },
  smallest: { label: 'Smallest first', sort: 'size', order: 'asc' },
};
const KIND_ICON: Record<MediaKind, ComponentType<{ width?: number; height?: number }>> = {
  video: IconFilm, audio: IconWave, image: IconImage, pdf: IconPdf, archive: IconArchive, encrypted: IconLock, other: IconFile,
};
const fkey = (f: { folder_id: number | null }) => (f.folder_id === null ? '' : String(f.folder_id));
const ukey = (f: DriveFile) => `${fkey(f)}:${f.id}`;
const folderParam = (f: { folder_id: number | null }) => (f.folder_id === null ? 'home' : String(f.folder_id));
const LOC_TITLE: Record<string, string> = {
  all: 'All files', saved: 'Saved Messages', recent: 'Recents', favorite: 'Favorites', pin: 'Pinned',
  large: 'Large files', old: 'Old files', duplicates: 'Duplicates', empty: 'Empty folders',
};

function Thumb({ file }: { file: DriveFile }) {
  const kind = kindOf(file);
  const [failed, setFailed] = useState(false);
  const Icon = KIND_ICON[kind];
  const showImg = (kind === 'video' || kind === 'image') && !failed;
  return (
    <div className={`thumb thumb-${kind}`}>
      {showImg ? <img src={thumbUrl(file) ?? undefined} alt="" loading="lazy" onError={() => setFailed(true)} draggable={false} /> : <Icon width={30} height={30} />}
      {kind === 'video' && <span className="thumb-play" aria-hidden="true"><IconPlay width={16} height={16} /></span>}
      {kind === 'encrypted' && <span className="thumb-lock" aria-hidden="true"><IconLock width={14} height={14} /></span>}
    </div>
  );
}

function DriveLink({ onSaved, saved }: { onSaved: (note: string) => void; saved: string }) {
  const status = usePoll(() => api('/api/drive/status'), 15000);
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [error, setError] = useState<unknown>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api('/api/drive/config', { method: 'PUT', body: { ...(url ? { url } : {}), ...(key ? { key } : {}) } });
      setKey('');
      void status.refresh();
      onSaved('Saved. The key is sealed with AES-256-GCM on the server and never sent to browsers.');
    } catch (err) { setError(err); }
  }
  const s = status.data;
  return (
    <Panel title="Vault source" meta="Telegram Drive desktop app" flush>
      <div className="link-status">
        <span className="mono clip-text">{s?.url ?? '…'}</span>
        {!s ? <Tag>checking</Tag> : s.ok ? <Tag tone="ok">reachable · v{s.version ?? '?'} · {s.ms} ms</Tag> : <Tag tone="crit">unreachable</Tag>}
        {s && (!s.keyConfigured ? <Tag tone="warn">key not configured</Tag> : s.authorized ? <Tag tone="ok">key accepted</Tag> : <Tag tone="warn">key not verified</Tag>)}
      </div>
      <form className="form link-form" onSubmit={save}>
        <label className="field"><span>Endpoint URL</span><input value={url} onChange={e => setUrl(e.target.value)} placeholder={s?.url ?? 'http://127.0.0.1:8550/api/v1'} className="mono" /></label>
        <label className="field"><span>API key (Settings → Advanced in the desktop app)</span><input type="password" value={key} onChange={e => setKey(e.target.value)} autoComplete="off" /></label>
        <button className="btn btn-primary" disabled={!url && !key}>Save link</button>
        {saved && <div className="ok-note">{saved}</div>}
        <ErrorNote error={error} />
      </form>
    </Panel>
  );
}

function TreeRow({ node, depth, loc, expanded, toggle, select, onDropFiles, onRename, onDelete, onUnlink }: {
  node: TreeNode; depth: number; loc: Loc; expanded: Set<number>; toggle: (id: number) => void; select: (l: Loc) => void;
  onDropFiles: (target: string, p: { ids: number[]; from: string }) => void; onRename: (f: Folder) => void; onDelete: (f: Folder) => void; onUnlink?: (f: Folder) => void;
}) {
  const tgFolder = node as TreeNode & { can_edit?: boolean; owned?: boolean; kind?: string };
  const canRename = !onUnlink || Boolean(tgFolder.can_edit);
  const canDelete = !onUnlink || (Boolean(tgFolder.owned) && tgFolder.kind === 'channel');
  const open = expanded.has(node.id);
  const active = loc.kind === 'folder' && loc.id === node.id;
  const drop = useDropTarget(p => onDropFiles(String(node.id), p));
  return (
    <li role="none">
      <div className={`tree-row ${active ? 'on' : ''} ${drop.over ? 'drop' : ''}`} style={{ paddingLeft: 4 + depth * 14 }} {...drop.handlers}>
        {node.children.length > 0
          ? <button type="button" className={`tree-twisty ${open ? 'open' : ''}`} onClick={() => toggle(node.id)} aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}><IconNext width={12} height={12} /></button>
          : <span className="tree-twisty" aria-hidden="true" />}
        <button type="button" role="treeitem" aria-selected={active} aria-expanded={node.children.length ? open : undefined} className="tree-label" onClick={() => select({ kind: 'folder', id: node.id })}>{node.name}</button>
        <Menu label={`Folder actions for ${node.name}`} buttonClass="icon-btn tree-more" buttonContent={<span aria-hidden="true">⋯</span>}>
          {close => (
            <>
              {canRename && <MenuItem onSelect={() => { close(); onRename(node); }}>Rename folder</MenuItem>}
              {onUnlink && <MenuItem onSelect={() => { close(); onUnlink(node); }}>Remove from Kurovault</MenuItem>}
              {canDelete && <MenuItem danger onSelect={() => { close(); onDelete(node); }}>{onUnlink ? 'Delete channel' : 'Delete folder'}</MenuItem>}
            </>
          )}
        </Menu>
      </div>
      {open && node.children.length > 0 && (
        <ul role="group">
          {node.children.map(c => <TreeRow key={c.id} node={c} depth={depth + 1} loc={loc} expanded={expanded} toggle={toggle} select={select} onDropFiles={onDropFiles} onRename={onRename} onDelete={onDelete} onUnlink={onUnlink} />)}
        </ul>
      )}
    </li>
  );
}

function NavItem({ label, active, onClick, count, drop }: { label: string; active: boolean; onClick: () => void; count?: number; drop?: ReturnType<typeof useDropTarget> }) {
  return (
    <button type="button" className={`vnav-item ${active ? 'on' : ''} ${drop?.over ? 'drop' : ''}`} onClick={onClick} aria-current={active ? 'page' : undefined} {...(drop?.handlers ?? {})}>
      <span>{label}</span>{count !== undefined && <span className="vnav-count mono">{count}</span>}
    </button>
  );
}

type Dialogs =
  | { kind: 'new-folder' } | { kind: 'rename-folder'; folder: Folder } | { kind: 'delete-folder'; folder: Folder }
  | { kind: 'rename-file'; file: DriveFile } | { kind: 'move'; files: DriveFile[] } | { kind: 'copy'; file: DriveFile }
  | { kind: 'delete-files'; files: DriveFile[] } | null;

export function DrivePage() {
  const [loc, setLoc] = useState<Loc>({ kind: 'all' });
  const [type, setType] = useState('all');
  const [sortKey, setSortKey] = useState('newest');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [view, setView] = useState<'grid' | 'list'>(() => (window.matchMedia('(max-width: 700px)').matches ? 'grid' : 'list'));
  const [selected, setSelected] = useState<Map<string, DriveFile>>(new Map());
  const [selectMode, setSelectMode] = useState(false);
  const [viewing, setViewing] = useState<number | null>(null);
  const [dialog, setDialog] = useState<Dialogs>(null);
  const [notice, setNotice] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [sheet, setSheet] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [sourceNote, setSourceNote] = useState('');
  const [uploads, setUploads] = useState<UploadItem[]>([]);
  const [dropping, setDropping] = useState(false);
  const aborts = useRef(new Map<string, AbortController>());
  const fileInput = useRef<HTMLInputElement>(null);

  const status = usePoll(() => api('/api/drive/status'), 30000);
  const healthy = Boolean(status.data?.ok && status.data?.authorized);
  const tgMode = status.data?.mode === 'telegram';
  const folders = usePoll(async () => (healthy ? api<{ folders: Folder[] }>('/api/drive/folders') : { folders: [] as Folder[] }), 0, [healthy]);
  const marks = usePoll(() => api<{ favorite: string[]; pin: string[] }>('/api/vault/marks/index'), 0);
  const favSet = useMemo(() => new Set(marks.data?.favorite ?? []), [marks.data]);
  const pinSet = useMemo(() => new Set(marks.data?.pin ?? []), [marks.data]);
  const folderList = folders.data?.folders ?? [];
  const tree = useMemo(() => buildTree(folderList), [folderList]);
  const typeDef = TYPES.find(t => t.id === type)!;
  const sort = SORTS[sortKey];

  const isMarkList = loc.kind === 'recent' || loc.kind === 'favorite' || loc.kind === 'pin';
  const files = usePoll(async () => {
    if (!healthy) return null;
    if (isMarkList) return api('/api/vault/marks', { query: { kind: loc.kind } });
    if (tgMode && loc.kind === 'all') return null; // Telegram home shows chats, not one giant list
    if (loc.kind === 'duplicates') return api('/api/drive/insights/duplicates');
    if (loc.kind === 'empty') return api('/api/drive/insights/empty-folders');
    const q: Record<string, string | number | undefined> = { page, limit: 60, search: query || undefined, mime_type: typeDef.mime, sort: sort.sort, order: sort.order };
    if (loc.kind === 'saved') q.folder_id = 'home';
    if (loc.kind === 'folder') q.folder_id = loc.id;
    if (loc.kind === 'large') { q.sort = 'size'; q.order = 'desc'; }
    if (loc.kind === 'old') { q.sort = 'created_at'; q.order = 'asc'; }
    return api('/api/drive/files', { query: q });
  }, 0, [healthy, JSON.stringify(loc), type, sortKey, query, page]);

  const list: DriveFile[] = useMemo(() => {
    const d = files.data;
    if (!d) return [];
    if (isMarkList) {
      let rows: DriveFile[] = d.files ?? [];
      if (typeDef.kinds) rows = rows.filter(f => typeDef.kinds!.includes(kindOf(f)));
      if (query) rows = rows.filter(f => f.name.toLowerCase().includes(query.toLowerCase()));
      if (loc.kind !== 'recent') {
        rows = [...rows].sort((a, b) => {
          const s = sort.sort === 'name' ? a.name.localeCompare(b.name) : sort.sort === 'size' ? a.size - b.size : a.created_at.localeCompare(b.created_at);
          return sort.order === 'asc' ? s : -s;
        });
      }
      return rows;
    }
    if (loc.kind === 'duplicates') return (d.groups ?? []).flatMap((g: { files: DriveFile[] }) => g.files);
    return d.data ?? d.files ?? [];
  }, [files.data, isMarkList, typeDef, query, sort, loc.kind]);
  const pages = files.data?.pagination?.total_pages ?? 1;

  const refresh = useCallback(() => { void files.refresh(); void marks.refresh(); }, [files, marks]);
  const select = (next: Loc) => { setLoc(next); setPage(1); setSelected(new Map()); setSheet(false); };
  const toggleExpand = (id: number) => setExpanded(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  useEffect(() => {
    if (loc.kind !== 'folder') return;
    const path = folderPath(folderList, loc.id);
    setExpanded(prev => { const n = new Set(prev); path.slice(0, -1).forEach(f => n.add(f.id)); return n; });
  }, [loc, folderList]);

  const flash = (text: string) => { setNotice(text); window.setTimeout(() => setNotice(n => (n === text ? '' : n)), 4000); };
  const run = async (fn: () => Promise<unknown>, done?: string) => {
    setActionError(null);
    try { await fn(); if (done) flash(done); refresh(); void folders.refresh(); } catch (e) { setActionError(e); throw e; }
  };

  // ─── File operations ───────────────────────────────────────────────
  const byFolder = (fs: DriveFile[]) => {
    const groups = new Map<string, DriveFile[]>();
    for (const f of fs) groups.set(folderParam(f), [...(groups.get(folderParam(f)) ?? []), f]);
    return groups;
  };
  const moveFiles = async (fs: DriveFile[], target: string) => {
    for (const [from, group] of byFolder(fs)) {
      if (from === target) continue;
      await api('/api/drive/bulk/move', { method: 'POST', body: { file_ids: group.map(f => f.id), folder_id: from, target_folder_id: target } });
    }
  };
  const deleteFiles = async (fs: DriveFile[]) => {
    if (fs.length === 1) {
      const [f] = fs;
      await api(`/api/drive/files/${f.id}`, { method: 'DELETE', query: { folder_id: f.folder_id ?? undefined } });
      return;
    }
    for (const [from, group] of byFolder(fs)) await api('/api/drive/bulk/delete', { method: 'POST', body: { file_ids: group.map(f => f.id), folder_id: from } });
  };
  const toggleMark = (kind: 'favorite' | 'pin', f: DriveFile, on: boolean) =>
    run(() => api('/api/vault/marks', { method: on ? 'DELETE' : 'PUT', body: { kind, id: f.id, folder_id: f.folder_id === null ? undefined : String(f.folder_id) } }), on ? `Removed from ${kind === 'pin' ? 'Pinned' : 'Favorites'}` : `Added to ${kind === 'pin' ? 'Pinned' : 'Favorites'}`);
  async function downloadZip(fs: DriveFile[]) {
    setActionError(null);
    try {
      for (const [from, group] of byFolder(fs)) {
        const { getCsrf } = await import('../api');
        const res = await fetch('/api/drive/bulk/archive', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': getCsrf() }, body: JSON.stringify({ file_ids: group.map(f => f.id), folder_id: from }) });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error?.message ?? `Archive failed (${res.status})`);
        const url = URL.createObjectURL(await res.blob());
        const a = document.createElement('a');
        a.href = url;
        a.download = `kurovault-${from}-${new Date().toISOString().slice(0, 10)}.zip`;
        a.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch (e) { setActionError(e); }
  }

  // ─── Uploads ───────────────────────────────────────────────────────
  const uploadTarget = loc.kind === 'folder' ? String(loc.id) : loc.kind === 'saved' ? 'home' : null;
  const startUploads = (fl: FileList | File[] | null) => {
    if (!fl || !uploadTarget) return;
    const target = uploadTarget === 'home' ? null : uploadTarget;
    for (const file of Array.from(fl)) {
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const controller = new AbortController();
      aborts.current.set(key, controller);
      setUploads(u => [...u, { key, name: file.name, size: file.size, sent: 0, status: 'queued' }]);
      const update = (patch: Partial<UploadItem>) => setUploads(u => u.map(x => (x.key === key ? { ...x, ...patch } : x)));
      void uploadFile(file, target, update, controller.signal)
        .then(() => { refresh(); flash(`Uploaded ${file.name}`); })
        .catch(e => update({ status: controller.signal.aborted ? 'cancelled' : 'error', error: (e as Error).message }))
        .finally(() => aborts.current.delete(key));
    }
    if (fileInput.current) fileInput.current.value = '';
  };

  // ─── Selection & drag ──────────────────────────────────────────────
  const toggleSel = (f: DriveFile) => setSelected(prev => { const n = new Map(prev); if (n.has(ukey(f))) n.delete(ukey(f)); else n.set(ukey(f), f); return n; });
  const selection = [...selected.values()];
  const dragStart = (e: DragEvent, f: DriveFile) => {
    const fs = selected.has(ukey(f)) ? selection : [f];
    const from = folderParam(fs[0]);
    const same = fs.filter(x => folderParam(x) === from);
    e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ ids: same.map(x => x.id), from }));
    e.dataTransfer.effectAllowed = 'move';
    // While a file is being dragged, the shelf follows the screen so a folder is always within reach.
    window.setTimeout(() => document.body.classList.add('dragging-files'), 0);
    const done = () => { document.body.classList.remove('dragging-files'); window.removeEventListener('dragend', done, true); window.removeEventListener('drop', done, true); };
    window.addEventListener('dragend', done, true);
    window.addEventListener('drop', done, true);
  };
  const onDropFiles = (target: string, p: { ids: number[]; from: string }) => {
    if (p.from === target) return;
    void run(() => api('/api/drive/bulk/move', { method: 'POST', body: { file_ids: p.ids, folder_id: p.from, target_folder_id: target } }), `Moved ${p.ids.length} file(s)`).catch(() => undefined);
  };
  const savedDrop = useDropTarget(p => onDropFiles('home', p));

  const open = (f: DriveFile) => setViewing(list.findIndex(x => ukey(x) === ukey(f)));
  const activate = (f: DriveFile) => (selectMode || selected.size > 0 ? toggleSel(f) : open(f));

  const fileMenu = (f: DriveFile) => {
    const fav = favSet.has(ukey(f));
    const pin = pinSet.has(ukey(f));
    return (
      <Menu label={`Actions for ${f.name}`} buttonContent={<span aria-hidden="true">⋯</span>} buttonClass="icon-btn file-more">
        {close => (
          <>
            <MenuItem onSelect={() => { close(); open(f); }}>Open</MenuItem>
            {!f.encrypted && <MenuItem onSelect={() => { close(); setDialog({ kind: 'rename-file', file: f }); }}>Rename</MenuItem>}
            {!f.encrypted && !f.protected && <MenuItem onSelect={() => { close(); setDialog({ kind: 'move', files: [f] }); }}>Move to…</MenuItem>}
            {!f.protected && <MenuItem onSelect={() => { close(); setDialog({ kind: 'copy', file: f }); }}>Copy to…</MenuItem>}
            <MenuItem onSelect={() => { close(); void toggleMark('favorite', f, fav).catch(() => undefined); }}>{fav ? 'Remove from Favorites' : 'Add to Favorites'}</MenuItem>
            <MenuItem onSelect={() => { close(); void toggleMark('pin', f, pin).catch(() => undefined); }}>{pin ? 'Unpin' : 'Pin'}</MenuItem>
            <MenuItem onSelect={() => { close(); toggleSel(f); setSelectMode(true); }}>Select</MenuItem>
            {!f.encrypted && !f.protected && <MenuItem onSelect={() => { close(); const a = document.createElement('a'); a.href = downloadUrl(f) ?? ""; a.download = ''; a.click(); }}>Download</MenuItem>}
            <MenuItem danger onSelect={() => { close(); setDialog({ kind: 'delete-files', files: [f] }); }}>Delete</MenuItem>
          </>
        )}
      </Menu>
    );
  };

  const tgHome = tgMode && loc.kind === 'all';
  // Move/copy targets: in Telegram, only chats where you can post.
  const pickable = tgMode ? (folderList as Chat[]).filter(c => c.can_post) : folderList;
  const title = loc.kind === 'folder' ? (folderList.find(f => f.id === loc.id)?.name ?? 'Folder') : tgHome ? 'Home' : LOC_TITLE[loc.kind];
  const chatMenu = (c: Chat) => (c.can_edit || (c.owned && c.kind === 'channel')) ? (
    <Menu label={`Folder actions for ${c.name}`} buttonClass="icon-btn tree-more" buttonContent={<span aria-hidden="true">⋯</span>}>
      {close => (
        <>
          {c.can_edit && <MenuItem onSelect={() => { close(); setDialog({ kind: 'rename-folder', folder: c }); }}>Rename channel</MenuItem>}
          {c.owned && c.kind === 'channel' && <MenuItem danger onSelect={() => { close(); setDialog({ kind: 'delete-folder', folder: c }); }}>Delete channel</MenuItem>}
        </>
      )}
    </Menu>
  ) : null;
  const crumbs = loc.kind === 'folder' ? folderPath(folderList, loc.id) : [];
  const listingKind = !(loc.kind === 'duplicates' || loc.kind === 'empty' || tgHome);

  const sidebar = tgMode ? (
    <nav className="vnav" aria-label="Vault">
      <div className="vnav-group">
        <span className="vnav-title">Library</span>
        <NavItem label="Home" active={loc.kind === 'all'} onClick={() => select({ kind: 'all' })} />
        <NavItem label="Saved Messages" active={loc.kind === 'saved'} onClick={() => select({ kind: 'saved' })} drop={savedDrop} />
        <NavItem label="Recents" active={loc.kind === 'recent'} onClick={() => select({ kind: 'recent' })} />
        <NavItem label="Favorites" active={loc.kind === 'favorite'} onClick={() => select({ kind: 'favorite' })} count={favSet.size || undefined} />
        <NavItem label="Pinned" active={loc.kind === 'pin'} onClick={() => select({ kind: 'pin' })} count={pinSet.size || undefined} />
      </div>
      <div className="vnav-title-row">
        <span className="vnav-title">Your Telegram</span>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDialog({ kind: 'new-folder' })}>+ New channel</button>
      </div>
      {folders.loading && !folders.data ? <Loading /> : (
        <ChatSections chats={folderList as Chat[]} activeId={loc.kind === 'folder' ? loc.id : null} onOpen={id => select({ kind: 'folder', id })} menu={chatMenu} />
      )}
      <button type="button" className="vnav-source" onClick={() => setShowSource(s => !s)}>
        <span className={`dot dot-${healthy ? 'ok' : 'warn'}`} aria-hidden="true" />
        <span>{healthy ? `Telegram · ${status.data?.account?.username ? `@${status.data.account.username}` : status.data?.account?.name ?? 'connected'}` : 'Telegram offline'}</span>
      </button>
    </nav>
  ) : (
    <nav className="vnav" aria-label="Vault">
      <div className="vnav-group">
        <span className="vnav-title">Library</span>
        <NavItem label="All files" active={loc.kind === 'all'} onClick={() => select({ kind: 'all' })} />
        <NavItem label="Recents" active={loc.kind === 'recent'} onClick={() => select({ kind: 'recent' })} />
        <NavItem label="Favorites" active={loc.kind === 'favorite'} onClick={() => select({ kind: 'favorite' })} count={favSet.size || undefined} />
        <NavItem label="Pinned" active={loc.kind === 'pin'} onClick={() => select({ kind: 'pin' })} count={pinSet.size || undefined} />
        <NavItem label="Saved Messages" active={loc.kind === 'saved'} onClick={() => select({ kind: 'saved' })} drop={savedDrop} />
      </div>
      <div className="vnav-group">
        <div className="vnav-title-row">
          <span className="vnav-title">Folders</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDialog({ kind: 'new-folder' })}>+ New folder</button>
        </div>
        {folders.loading && !folders.data ? <Loading /> : (
          <ul className="tree" role="tree" aria-label="Folders">
            {tree.map(n => <TreeRow key={n.id} node={n} depth={0} loc={loc} expanded={expanded} toggle={toggleExpand} select={select} onDropFiles={onDropFiles} onRename={f => setDialog({ kind: 'rename-folder', folder: f })} onDelete={f => setDialog({ kind: 'delete-folder', folder: f })} />)}
          </ul>
        )}
      </div>
      <div className="vnav-group">
        <span className="vnav-title">Storage insights</span>
        <NavItem label="Large files" active={loc.kind === 'large'} onClick={() => select({ kind: 'large' })} />
        <NavItem label="Old files" active={loc.kind === 'old'} onClick={() => select({ kind: 'old' })} />
        <NavItem label="Duplicates" active={loc.kind === 'duplicates'} onClick={() => select({ kind: 'duplicates' })} />
        <NavItem label="Empty folders" active={loc.kind === 'empty'} onClick={() => select({ kind: 'empty' })} />
      </div>
      <button type="button" className="vnav-source" onClick={() => setShowSource(s => !s)}>
        <span className={`dot dot-${healthy ? 'ok' : 'warn'}`} aria-hidden="true" />
        <span>{healthy ? `Desktop app v${status.data?.version ?? '?'} · ${status.data?.ms} ms` : 'Desktop app not linked'}</span>
      </button>
    </nav>
  );

  const fileList = files.loading && !files.data ? <Loading label="Reading vault" /> : (
    <>
      <ErrorNote error={files.error} />
      {files.data && list.length === 0 && <Empty>{loc.kind === 'favorite' ? 'No favorites yet. Use a file’s ⋯ menu to add one.' : loc.kind === 'pin' ? 'Nothing pinned yet.' : loc.kind === 'recent' ? 'Files you open appear here.' : loc.kind === 'duplicates' ? 'No duplicate files found.' : 'Nothing here yet.'}</Empty>}
      {list.length > 0 && view === 'grid' && (
        <ul className="file-grid" data-testid="file-grid">
          {list.map(f => {
            const kind = kindOf(f);
            const sel = selected.has(ukey(f));
            return (
              <li key={ukey(f)} className={`file-card ${sel ? 'is-selected' : ''}`} draggable onDragStart={e => dragStart(e, f)}>
                <button className="file-card-open" onClick={() => activate(f)} aria-label={`Open ${f.name}`}>
                  <Thumb file={f} />
                  <span className="file-card-name" title={f.name}>{favSet.has(ukey(f)) && <span className="star" aria-label="Favorite">★</span>}{pinSet.has(ukey(f)) && <span className="pin" aria-label="Pinned">●</span>}{f.name}</span>
                  <span className="file-card-meta mono">{KIND_LABEL[kind]} · {fmtBytes(f.size)}</span>
                </button>
                <label className="file-check"><input type="checkbox" checked={sel} onChange={() => toggleSel(f)} aria-label={`Select ${f.name}`} /></label>
                {fileMenu(f)}
              </li>
            );
          })}
        </ul>
      )}
      {list.length > 0 && view === 'list' && (
        <DataTable<DriveFile>
          cards="phone"
          label="Files"
          rows={list}
          rowKey={ukey}
          rowClass={f => (selected.has(ukey(f)) ? 'row-on' : '')}
          columns={[
            { key: 'sel', label: 'Select', className: 'cell-check', render: f => <input type="checkbox" checked={selected.has(ukey(f))} onChange={() => toggleSel(f)} aria-label={`Select ${f.name}`} /> },
            { key: 'name', label: 'Name', primary: true, render: f => (
              <span className="file-row" draggable onDragStart={e => dragStart(e, f)}>
                <button className="file-row-open" onClick={() => activate(f)} aria-label={`Open ${f.name}`}>
                  <span className={`kind-dot kind-${kindOf(f)}`}>{(() => { const I = KIND_ICON[kindOf(f)]; return <I width={15} height={15} />; })()}</span>
                  <span className="clip-text">{f.name}</span>
                </button>
                {favSet.has(ukey(f)) && <span className="star" aria-label="Favorite">★</span>}
                {pinSet.has(ukey(f)) && <Tag tone="info">pinned</Tag>}
                {f.encrypted && <Tag tone="info">encrypted</Tag>}
                {f.protected && <Tag tone="warn" title="Content protection: stream only">protected</Tag>}
                {f.forwarded && <Tag title="Forwarded from a channel">fwd</Tag>}
              </span>
            ) },
            { key: 'where', label: 'Folder', className: 'sub col-xl', render: f => (f.folder_id === null ? 'Saved Messages' : folderList.find(x => x.id === f.folder_id)?.name ?? '—') },
            { key: 'size', label: 'Size', className: 'num', render: f => fmtBytes(f.size) },
            { key: 'date', label: 'Uploaded', className: 'mono nowrap', render: f => fmtTime(Date.parse(f.created_at)) },
            { key: 'actions', label: 'Actions', actions: true, render: f => (
              <div className="row-actions">
                {!f.encrypted && !f.protected && <a className="btn btn-ghost btn-sm" href={downloadUrl(f) ?? undefined} download aria-label={`Download ${f.name}`}><IconDownload width={14} height={14} /></a>}
                {fileMenu(f)}
              </div>
            ) },
          ]}
        />
      )}
      {listingKind && !isMarkList && pages > 1 && (
        <div className="pager">
          <button className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>Previous</button>
          <span className="mono">{page} / {pages}</span>
          <button className="btn btn-ghost btn-sm" disabled={page >= pages} onClick={() => setPage(p => p + 1)}>Next</button>
        </div>
      )}
    </>
  );

  let body: ReactNode = fileList;
  if (tgHome) body = <LibraryHome chats={folderList as Chat[]} loading={folders.loading} onSaved={() => select({ kind: 'saved' })} onOpen={id => select({ kind: 'folder', id })} />;
  if (loc.kind === 'duplicates' && files.data) {
    body = (files.data.groups ?? []).length === 0 ? <Empty>No duplicate files found.</Empty> : (
      <div className="dup-groups">
        {(files.data.groups as { name: string; size: number; files: DriveFile[] }[]).map(g => (
          <section key={`${g.name}-${g.size}`} className="dup-group">
            <header><strong>{g.name}</strong><span className="sub mono">{g.files.length} copies · {fmtBytes(g.size)} each · {fmtBytes(g.size * (g.files.length - 1))} reclaimable</span></header>
            <ul>
              {g.files.map(f => (
                <li key={ukey(f)}>
                  <button className="file-row-open" onClick={() => open(f)} aria-label={`Open ${f.name} in ${f.folder_id === null ? 'Saved Messages' : folderList.find(x => x.id === f.folder_id)?.name}`}>
                    <span className="clip-text">{f.folder_id === null ? 'Saved Messages' : folderList.find(x => x.id === f.folder_id)?.name ?? `Folder ${f.folder_id}`}</span>
                  </button>
                  <span className="sub mono">{fmtTime(Date.parse(f.created_at))}</span>
                  {fileMenu(f)}
                </li>
              ))}
            </ul>
          </section>
        ))}
      </div>
    );
  } else if (loc.kind === 'empty' && files.data) {
    const empties: Folder[] = files.data.folders ?? [];
    body = empties.length === 0 ? <Empty>No empty folders.</Empty> : (
      <DataTable<Folder> label="Empty folders" rows={empties} rowKey={f => f.id} columns={[
        { key: 'name', label: 'Folder', primary: true, render: f => <button className="link" onClick={() => select({ kind: 'folder', id: f.id })}>{f.name}</button> },
        { key: 'act', label: 'Action', actions: true, render: f => <button className="btn btn-danger btn-sm" onClick={() => setDialog({ kind: 'delete-folder', folder: f })}>Delete folder</button> },
      ]} />
    );
  }

  const sourcePanel = (
    <SourcePanel onChanged={() => { void status.refresh(); void folders.refresh(); refresh(); }} desktopOpen={!tgMode && Boolean(status.data?.keyConfigured)}
      desktop={<DriveLink saved={sourceNote} onSaved={note => { setSourceNote(note); setShowSource(true); void status.refresh(); }} />} />
  );
  if (status.data && !healthy) return <div className="page">{sourcePanel}</div>;

  return (
    <div className={`vault ${sheet ? 'sheet-open' : ''}`}>
      <aside className="vault-side" aria-label="Vault navigation">
        <div className="vault-side-head"><strong>Browse</strong><button className="icon-btn" onClick={() => setSheet(false)} aria-label="Close browse panel">✕</button></div>
        {uploadTarget && <button type="button" className="btn btn-primary side-new" onClick={() => { setSheet(false); fileInput.current?.click(); }}><IconUpload width={16} height={16} /> Add files</button>}
        {sidebar}
      </aside>
      <div className="vault-scrim" onClick={() => setSheet(false)} aria-hidden="true" />
      <section className="vault-main"
        onDragOver={e => { if (uploadTarget && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setDropping(true); } }}
        onDragLeave={e => { if (e.currentTarget === e.target) setDropping(false); }}
        onDrop={e => { if (e.dataTransfer.files.length && uploadTarget) { e.preventDefault(); setDropping(false); startUploads(e.dataTransfer.files); } }}>
        {showSource && sourcePanel}
        <div className="vault-head">
          <button type="button" className="btn btn-ghost btn-sm vault-browse" onClick={() => setSheet(true)} aria-label="Browse folders"><IconMenu width={15} height={15} /> Browse</button>
          <div className="crumbs" aria-label="Location">
            {loc.kind === 'folder'
              ? crumbs.map((c, i) => <span key={c.id}>{i > 0 && <span className="crumb-sep">/</span>}<button className="link-plain" onClick={() => select({ kind: 'folder', id: c.id })}>{c.name}</button></span>)
              : <span>{title}</span>}
          </div>
          <h2 className="vault-title">{title}</h2>
        </div>
        {listingKind && (
          <div className="vault-toolbar">
            <div className="seg" role="group" aria-label="File type">
              {TYPES.map(t => <button key={t.id} className={type === t.id ? 'on' : ''} onClick={() => { setType(t.id); setPage(1); }}>{t.label}</button>)}
            </div>
            <form className="drive-search" onSubmit={e => { e.preventDefault(); setQuery(search.trim()); setPage(1); }}>
              <input className="input-sm" type="search" placeholder="Search names" value={search} onChange={e => setSearch(e.target.value)} aria-label="Search files" />
            </form>
            {loc.kind !== 'large' && loc.kind !== 'old' && loc.kind !== 'recent' && (
              <select className="input-sm sort-select" value={sortKey} onChange={e => { setSortKey(e.target.value); setPage(1); }} aria-label="Sort files">
                {Object.entries(SORTS).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
              </select>
            )}
            <div className="seg" role="group" aria-label="Layout">
              <button className={view === 'grid' ? 'on' : ''} onClick={() => setView('grid')} aria-label="Grid view"><IconGrid width={15} height={15} /></button>
              <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')} aria-label="List view"><IconList width={15} height={15} /></button>
            </div>
            <button className={`btn btn-ghost btn-sm ${selectMode ? 'is-on' : ''}`} onClick={() => { setSelectMode(m => !m); if (selectMode) setSelected(new Map()); }} aria-pressed={selectMode}>Select</button>
            <input ref={fileInput} type="file" multiple hidden onChange={e => startUploads(e.target.files)} data-testid="upload-input" />
            <button className="btn btn-primary btn-sm" onClick={() => fileInput.current?.click()} disabled={!uploadTarget} title={uploadTarget ? undefined : 'Open a folder or Saved Messages to upload'}><IconUpload width={15} height={15} /> Upload</button>
          </div>
        )}
        {notice && <div className="ok-note" role="status">{notice}</div>}
        <ErrorNote error={actionError} />
        <div className={`vault-body ${selectMode ? 'select-mode' : ''} ${dropping ? 'is-dropping' : ''}`}>
          {dropping && <div className="drop-hint">Drop to upload to {title}</div>}
          {body}
        </div>
        {selected.size > 0 && (
          <div className="bulk-bar" role="region" aria-label="Selection actions">
            <span><b>{selected.size}</b> selected</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setSelected(new Map(list.map(f => [ukey(f), f])))}>Select all</button>
            <span className="spacer" />
            <button className="btn btn-ghost btn-sm" onClick={() => setDialog({ kind: 'move', files: selection })}>Move</button>
            <button className="btn btn-ghost btn-sm" onClick={() => void downloadZip(selection)}>Download zip</button>
            <button className="btn btn-danger btn-sm" onClick={() => setDialog({ kind: 'delete-files', files: selection })}><IconTrash width={14} height={14} /> Delete</button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setSelected(new Map()); setSelectMode(false); }}>Clear</button>
          </div>
        )}
      </section>

      {uploads.length > 0 && (
        <div className="uploads" role="region" aria-label="Uploads">
          <header><strong>Uploads</strong><button className="link-plain" onClick={() => setUploads(u => u.filter(x => x.status === 'uploading' || x.status === 'queued' || x.status === 'finishing'))}>Clear finished</button></header>
          <ul>
            {uploads.map(u => (
              <li key={u.key} className={`up-${u.status}`}>
                <div className="up-row"><span className="clip-text">{u.name}</span><span className="mono sub">{u.status === 'done' ? 'Done' : u.status === 'error' ? 'Failed' : u.status === 'cancelled' ? 'Cancelled' : u.status === 'finishing' ? 'Sending to Telegram…' : `${Math.round((u.sent / u.size) * 100)}%`}</span>
                  {(u.status === 'uploading' || u.status === 'queued') && <button className="icon-btn" aria-label={`Cancel ${u.name}`} onClick={() => aborts.current.get(u.key)?.abort()}>✕</button>}</div>
                <div className="up-bar"><span style={{ width: `${(u.sent / Math.max(1, u.size)) * 100}%` }} /></div>
                {u.error && <div className="sub up-error">{u.error}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}

      {viewing !== null && viewing >= 0 && list[viewing] && <Viewer files={list} index={viewing} onIndex={setViewing} onClose={() => { setViewing(null); if (loc.kind === 'recent') void files.refresh(); }} />}

      {dialog?.kind === 'new-folder' && <TextDialog title={tgMode ? 'New private channel' : 'New folder'} label={tgMode ? 'Channel name' : 'Folder name'} submitLabel={tgMode ? 'Create channel' : 'Create folder'} onClose={() => setDialog(null)} onSave={name => run(async () => { const f = await api<Folder>('/api/drive/folders', { method: 'POST', body: { name } }); if (f?.id) select({ kind: 'folder', id: f.id }); }, `Created ${name}`)} />}
      {dialog?.kind === 'rename-folder' && <TextDialog title="Rename folder" label="Folder name" initial={dialog.folder.name} submitLabel="Rename" onClose={() => setDialog(null)} onSave={name => run(() => api(`/api/drive/folders/${dialog.folder.id}`, { method: 'PATCH', body: { name } }), 'Folder renamed')} />}
      {dialog?.kind === 'delete-folder' && <ConfirmDialog title={`Delete ${dialog.folder.name}?`} message={tgMode ? 'The channel and every message in it will be deleted from Telegram for everyone. To only hide it here, use “Remove from Kurovault”.' : 'The folder and every file in it will be deleted from Telegram. This cannot be undone.'} confirmLabel={tgMode ? 'Delete channel' : 'Delete folder'} onClose={() => setDialog(null)} onConfirm={() => run(async () => { await api(`/api/drive/folders/${dialog.folder.id}`, { method: 'DELETE' }); if (loc.kind === 'folder' && loc.id === dialog.folder.id) select({ kind: 'all' }); }, 'Folder deleted')} />}
      {dialog?.kind === 'rename-file' && <TextDialog title="Rename file" label="File name" initial={dialog.file.name} submitLabel="Rename" onClose={() => setDialog(null)} onSave={name => run(() => api(`/api/drive/files/${dialog.file.id}`, { method: 'PATCH', body: { name, source_folder_id: folderParam(dialog.file) } }), 'File renamed')} />}
      {dialog?.kind === 'move' && <FolderPicker title={`Move ${dialog.files.length === 1 ? dialog.files[0].name : `${dialog.files.length} files`}`} folders={pickable} exclude={dialog.files.length === 1 ? folderParam(dialog.files[0]) : undefined} confirmLabel="Move here" onClose={() => setDialog(null)} onPick={target => run(async () => { await moveFiles(dialog.files, target); setSelected(new Map()); }, 'Moved')} />}
      {dialog?.kind === 'copy' && <FolderPicker title={`Copy ${dialog.file.name}`} folders={pickable} confirmLabel="Copy here" onClose={() => setDialog(null)} onPick={target => run(() => api(`/api/drive/files/${dialog.file.id}/copy`, { method: 'POST', body: { folder_id: target, source_folder_id: folderParam(dialog.file) } }), 'Copied')} />}
      {dialog?.kind === 'delete-files' && <ConfirmDialog title={dialog.files.length === 1 ? `Delete ${dialog.files[0].name}?` : `Delete ${dialog.files.length} files?`} message="Deleted files are removed from Telegram. This cannot be undone." confirmLabel="Delete" onClose={() => setDialog(null)} onConfirm={() => run(async () => { await deleteFiles(dialog.files); setSelected(new Map()); }, 'Deleted')} />}
    </div>
  );
}

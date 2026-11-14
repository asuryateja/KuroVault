import { useEffect, useLayoutEffect, useMemo, useRef, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { Dialog } from '../ui';

export type Folder = { id: number; name: string; parent_id?: number | null };
export type TreeNode = Folder & { children: TreeNode[] };

export function buildTree(folders: Folder[]): TreeNode[] {
  const byId = new Map<number, TreeNode>(folders.map(f => [f.id, { ...f, children: [] }]));
  const roots: TreeNode[] = [];
  for (const node of byId.values()) {
    const parent = node.parent_id != null ? byId.get(node.parent_id) : undefined;
    if (parent && parent.id !== node.id) parent.children.push(node);
    else roots.push(node);
  }
  const sort = (list: TreeNode[]) => { list.sort((a, b) => a.name.localeCompare(b.name)); list.forEach(n => sort(n.children)); };
  sort(roots);
  return roots;
}

export function folderPath(folders: Folder[], id: number): Folder[] {
  const byId = new Map(folders.map(f => [f.id, f]));
  const path: Folder[] = [];
  let cur = byId.get(id);
  const seen = new Set<number>();
  while (cur && !seen.has(cur.id)) { seen.add(cur.id); path.unshift(cur); cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined; }
  return path;
}

/** Popover menu anchored to a button; becomes a bottom sheet on phones. */
export function Menu({ label, children, buttonClass = 'icon-btn', buttonContent }: { label: string; children: (close: () => void) => ReactNode; buttonClass?: string; buttonContent: ReactNode }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect();
    const w = 220;
    const h = panel.current?.offsetHeight ?? 300;
    const top = r.bottom + 6 + h > window.innerHeight ? Math.max(8, r.top - h - 6) : r.bottom + 6;
    setPos({ top, left: Math.min(window.innerWidth - w - 8, Math.max(8, r.right - w)) });
  }, [open]);
  useEffect(() => {
    if (!open) return undefined;
    const close = (e: Event) => {
      if (e instanceof KeyboardEvent) { if (e.key === 'Escape') { setOpen(false); button.current?.focus(); } return; }
      if (!panel.current?.contains(e.target as Node) && !button.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', close);
    window.addEventListener('resize', () => setOpen(false), { once: true });
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', close); };
  }, [open]);
  return (
    <>
      <button ref={button} type="button" className={buttonClass} aria-label={label} aria-haspopup="menu" aria-expanded={open} onClick={e => { e.stopPropagation(); setOpen(o => !o); }}>{buttonContent}</button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div ref={panel} className="menu" role="menu" aria-label={label} style={pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }} onClick={e => e.stopPropagation()}>
            {children(() => setOpen(false))}
          </div>
        </>
      )}
    </>
  );
}

export function MenuItem({ children, onSelect, danger, icon }: { children: ReactNode; onSelect: () => void; danger?: boolean; icon?: ReactNode }) {
  return <button type="button" role="menuitem" className={`menu-item ${danger ? 'is-danger' : ''}`} onClick={onSelect}>{icon}<span>{children}</span></button>;
}

export function TextDialog({ title, label, initial = '', submitLabel, onSave, onClose }: { title: string; label: string; initial?: string; submitLabel: string; onSave: (value: string) => Promise<void>; onClose: () => void }) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = input.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, [initial]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) return;
    setBusy(true);
    setError('');
    try { await onSave(value.trim()); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }
  return (
    <Dialog title={title} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <label className="field"><span>{label}</span><input ref={input} value={value} onChange={e => setValue(e.target.value)} maxLength={200} required /></label>
        {error && <div className="error-note" role="alert">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={busy || !value.trim()}>{busy ? 'Saving…' : submitLabel}</button>
      </form>
    </Dialog>
  );
}

export function ConfirmDialog({ title, message, confirmLabel, onConfirm, onClose }: { title: string; message: ReactNode; confirmLabel: string; onConfirm: () => Promise<void>; onClose: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="form">
        <p className="gate-sub">{message}</p>
        {error && <div className="error-note" role="alert">{error}</div>}
        <button className="btn btn-danger btn-block" disabled={busy} onClick={async () => {
          setBusy(true);
          setError('');
          try { await onConfirm(); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
        }}>{busy ? 'Working…' : confirmLabel}</button>
        <button className="btn btn-ghost btn-block" onClick={onClose}>Cancel</button>
      </div>
    </Dialog>
  );
}

/** Choose a destination folder (or Saved Messages) from the tree. */
export function FolderPicker({ title, folders, exclude, confirmLabel, onPick, onClose }: { title: string; folders: Folder[]; exclude?: string; confirmLabel: string; onPick: (folderId: string) => Promise<void>; onClose: () => void }) {
  const tree = useMemo(() => buildTree(folders), [folders]);
  const [choice, setChoice] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const render = (nodes: TreeNode[], depth: number): ReactNode => nodes.map(n => (
    <li key={n.id}>
      <button type="button" role="option" aria-selected={choice === String(n.id)} disabled={exclude === String(n.id)} className={choice === String(n.id) ? 'on' : ''} style={{ paddingLeft: 10 + depth * 16 }} onClick={() => setChoice(String(n.id))}>{n.name}</button>
      {n.children.length > 0 && <ul>{render(n.children, depth + 1)}</ul>}
    </li>
  ));
  return (
    <Dialog title={title} onClose={onClose}>
      <div className="form">
        <ul className="picker" role="listbox" aria-label="Destination folder">
          <li><button type="button" role="option" aria-selected={choice === 'home'} disabled={exclude === 'home'} className={choice === 'home' ? 'on' : ''} onClick={() => setChoice('home')}>Saved Messages</button></li>
          {render(tree, 0)}
        </ul>
        {error && <div className="error-note" role="alert">{error}</div>}
        <button className="btn btn-primary btn-block" disabled={!choice || busy} onClick={async () => {
          if (!choice) return;
          setBusy(true);
          setError('');
          try { await onPick(choice); onClose(); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
        }}>{busy ? 'Working…' : confirmLabel}</button>
      </div>
    </Dialog>
  );
}

export const DRAG_TYPE = 'application/x-kurovault-files';

/** Shared drop-target behaviour for tree rows (move dragged files into a folder). */
export function useDropTarget(onDropFiles: (payload: { ids: number[]; from: string }) => void) {
  const [over, setOver] = useState(false);
  return {
    over,
    handlers: {
      onDragOver: (e: DragEvent) => { if (e.dataTransfer.types.includes(DRAG_TYPE)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setOver(true); } },
      onDragLeave: () => setOver(false),
      onDrop: (e: DragEvent) => {
        setOver(false);
        const raw = e.dataTransfer.getData(DRAG_TYPE);
        if (!raw) return;
        e.preventDefault();
        try { onDropFiles(JSON.parse(raw)); } catch { /* ignore foreign drops */ }
      },
    },
  };
}

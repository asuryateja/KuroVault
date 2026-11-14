import { useMemo, useState } from 'react';
import type { Folder } from './parts';

export type Chat = Folder & { kind?: string; bot?: boolean; members?: number | null; protected?: boolean; owned?: boolean; can_post?: boolean; can_edit?: boolean; rank?: number; username?: string | null };

export const SECTIONS: { kind: string; title: string; empty: string }[] = [
  { kind: 'channel', title: 'Channels', empty: 'You have not joined any channels.' },
  { kind: 'group', title: 'Groups', empty: 'You are not in any groups.' },
  { kind: 'chat', title: 'Chats', empty: 'No private chats or bots yet.' },
];

const initial = (name: string) => (name.replace(/^[^\p{L}\p{N}]+/u, '').slice(0, 1) || '#').toUpperCase();
// A stable colour per chat so tiles are easy to tell apart (muted, so the gold accents stay the loudest thing on screen).
const tint = (id: number) => { const h = Math.abs(id * 47) % 360; return `linear-gradient(145deg, hsl(${h} 22% 30%), hsl(${h} 26% 16%))`; };

export function Avatar({ chat, size = 36 }: { chat: { id: number; name: string }; size?: number }) {
  return <span className="chat-avatar" style={{ width: size, height: size, background: tint(chat.id), fontSize: size * 0.42 }} aria-hidden="true">{initial(chat.name)}</span>;
}

function useGrouped(chats: Chat[], filter: string) {
  return useMemo(() => {
    const f = filter.trim().toLowerCase();
    const list = f ? chats.filter(c => c.name.toLowerCase().includes(f) || (c.username ?? '').toLowerCase().includes(f)) : chats;
    const sorted = [...list].sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0));
    return Object.fromEntries(SECTIONS.map(s => [s.kind, sorted.filter(c => (c.kind ?? 'channel') === s.kind)])) as Record<string, Chat[]>;
  }, [chats, filter]);
}

/** Sidebar: chats grouped the way Telegram groups them, most recent first. */
export function ChatSections({ chats, activeId, onOpen, menu }: { chats: Chat[]; activeId: number | null; onOpen: (id: number) => void; menu: (c: Chat) => React.ReactNode }) {
  const [filter, setFilter] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({ channel: true, group: true, chat: true });
  const [more, setMore] = useState<Record<string, boolean>>({});
  const grouped = useGrouped(chats, filter);
  return (
    <div className="chat-sections">
      <input className="input-sm chat-filter" type="search" placeholder="Find a chat" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Find a chat" />
      {SECTIONS.map(s => {
        const list = grouped[s.kind] ?? [];
        const shown = filter || more[s.kind] ? list : list.slice(0, 8);
        return (
          <div key={s.kind} className="vnav-group">
            <button type="button" className="vnav-section" aria-expanded={open[s.kind]} onClick={() => setOpen(o => ({ ...o, [s.kind]: !o[s.kind] }))}>
              <span className={`vnav-caret ${open[s.kind] ? 'open' : ''}`} aria-hidden="true">›</span>{s.title}<span className="vnav-count mono">{list.length}</span>
            </button>
            {open[s.kind] && (
              <ul className="tree" role="tree" aria-label={s.title}>
                {shown.map(c => (
                  <li key={c.id} role="none">
                    <div className={`tree-row chat-row ${activeId === c.id ? 'on' : ''}`}>
                      <Avatar chat={c} size={24} />
                      <button type="button" role="treeitem" aria-selected={activeId === c.id} className="tree-label" onClick={() => onOpen(c.id)}>{c.name}</button>
                      {menu(c)}
                    </div>
                  </li>
                ))}
                {list.length === 0 && <li className="sub chat-empty">{filter ? 'No match.' : s.empty}</li>}
                {!filter && list.length > 8 && (
                  <li><button type="button" className="link-plain chat-more" onClick={() => setMore(m => ({ ...m, [s.kind]: !m[s.kind] }))}>{more[s.kind] ? 'Show fewer' : `Show all ${list.length}`}</button></li>
                )}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Vault home: where your files are, as tiles. */
export function LibraryHome({ chats, onSaved, onOpen, loading }: { chats: Chat[]; onSaved: () => void; onOpen: (id: number) => void; loading: boolean }) {
  const [filter, setFilter] = useState('');
  const grouped = useGrouped(chats, filter);
  return (
    <div className="lib-home" data-testid="library-home">
      <div className="lib-search">
        <input type="search" placeholder="Search your channels, groups and chats" value={filter} onChange={e => setFilter(e.target.value)} aria-label="Search your chats" />
      </div>
      {!filter && (
        <button type="button" className="lib-saved" onClick={onSaved}>
          <span className="lib-saved-icon" aria-hidden="true">★</span>
          <span><strong>Saved Messages</strong><span className="sub">Everything you forwarded or saved for yourself</span></span>
          <span className="lib-go" aria-hidden="true">›</span>
        </button>
      )}
      {loading && chats.length === 0 && <p className="sub">Loading your chats…</p>}
      {SECTIONS.map(s => {
        const list = grouped[s.kind] ?? [];
        if (!list.length && filter) return null;
        return (
          <section key={s.kind} className="lib-section" aria-label={s.title}>
            <header><h3>{s.title}</h3><span className="sub mono">{list.length}</span></header>
            {list.length === 0 ? <p className="sub">{s.empty}</p> : (
              <ul className="lib-grid">
                {list.map(c => (
                  <li key={c.id}>
                    <button type="button" className="lib-tile" onClick={() => onOpen(c.id)} aria-label={`Open ${c.name}`}>
                      <Avatar chat={c} size={42} />
                      <span className="lib-tile-text">
                        <span className="lib-tile-name">{c.name}</span>
                        <span className="sub">{c.kind === 'chat' ? (c.bot ? 'Bot' : 'Private chat') : c.members ? `${c.members.toLocaleString('en')} ${c.kind === 'channel' ? 'subscribers' : 'members'}` : s.title.slice(0, -1)}
                          {c.owned ? ' · yours' : ''}{c.protected ? ' · protected' : ''}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })}
      {filter && SECTIONS.every(s => !(grouped[s.kind] ?? []).length) && <p className="sub">No chat matches “{filter}”.</p>}
    </div>
  );
}

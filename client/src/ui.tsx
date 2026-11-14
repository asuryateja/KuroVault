import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';

export type Column<T> = { key: string; label: string; render: (row: T) => ReactNode; className?: string; primary?: boolean; actions?: boolean };

/** Table on wide screens, stacked cards on phones (each cell shows its column label). */
export function DataTable<T>({ columns, rows, rowKey, rowClass, label, cards = 'tablet' }: { columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string | number; rowClass?: (row: T) => string; label?: string; cards?: 'tablet' | 'phone' }) {
  return (
    <div className="table-scroll" tabIndex={0} role="region" aria-label={label ? `${label} (scrolls sideways)` : undefined}>
    <table className={`table rtable ${cards === 'phone' ? 'cards-phone' : ''}`} aria-label={label}>
      <thead><tr>{columns.map(c => <th key={c.key} className={c.className}>{c.label}</th>)}</tr></thead>
      <tbody>
        {rows.map(row => (
          <tr key={rowKey(row)} className={rowClass?.(row) ?? ''}>
            {columns.map(c => <td key={c.key} data-label={c.label} className={[c.className, c.primary ? 'cell-primary' : '', c.actions ? 'cell-actions' : ''].filter(Boolean).join(' ')}>{c.render(row)}</td>)}
          </tr>
        ))}
      </tbody>
    </table>
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'crit' | 'info' | 'muted';

export function Tag({ tone = 'muted', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`tag tag-${tone}`} title={title}>{children}</span>;
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`dot dot-${tone}`} aria-hidden="true" />;
}

export function Panel({ title, meta, actions, children, className = '', flush = false }: { title: ReactNode; meta?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; flush?: boolean }) {
  return (
    <section className={`panel ${className}`}>
      <header className="panel-head">
        <h2>{title}</h2>
        {meta && <span className="panel-meta">{meta}</span>}
        {actions && <div className="panel-actions">{actions}</div>}
      </header>
      <div className={flush ? 'panel-body flush' : 'panel-body'}>{children}</div>
    </section>
  );
}

export function Kpi({ label, value, tone, sub }: { label: string; value: ReactNode; tone?: Tone; sub?: ReactNode }) {
  return (
    <div className={`kpi ${tone ? `kpi-${tone}` : ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {sub && <span className="kpi-sub">{sub}</span>}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="loading-bar" aria-hidden="true"><span /></span>
      {label}
    </div>
  );
}

export function ErrorNote({ error }: { error: unknown }) {
  if (!error) return null;
  const message = error instanceof Error ? error.message : String(error);
  return <div className="error-note" role="alert">{message}</div>;
}

/** Polls `load` every `ms` while mounted (pauses when the tab is hidden). */
export function usePoll<T>(load: () => Promise<T>, ms: number, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const refresh = useCallback(async () => {
    try {
      const value = await loadRef.current();
      setData(value);
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    setLoading(true);
    void refresh();
    if (!ms) return undefined;
    const id = window.setInterval(() => { if (!document.hidden) void refresh(); }, ms);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return { data, error, loading, refresh };
}

export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** 24-hour activity chart: request bars with failed sign-ins as a red overlay. */
export function ActivityChart({ series }: { series: { t: number; requests: number; failures: number; logins: number }[] }) {
  const w = 720;
  const h = 150;
  const pad = 22;
  const max = Math.max(4, ...series.map(s => s.requests));
  const maxF = Math.max(2, ...series.map(s => s.failures));
  const bw = (w - pad) / series.length;
  const line = series.map((s, i) => `${i === 0 ? 'M' : 'L'}${pad + i * bw + bw / 2},${h - 18 - (s.failures / maxF) * (h - 34)}`).join(' ');
  return (
    <svg className="chart" viewBox={`0 0 ${w} ${h}`} role="img" aria-label="Requests and failed sign-ins over the last 24 hours">
      {[0.25, 0.5, 0.75, 1].map(f => (
        <line key={f} x1={pad} x2={w} y1={h - 18 - f * (h - 34)} y2={h - 18 - f * (h - 34)} className="chart-grid" />
      ))}
      <text x={0} y={14} className="chart-axis">{max}</text>
      {series.map((s, i) => {
        const bh = (s.requests / max) * (h - 34);
        return (
          <g key={s.t}>
            <rect x={pad + i * bw + 2} y={h - 18 - bh} width={bw - 4} height={Math.max(bh, s.requests ? 1 : 0)} className="chart-bar">
              <title>{`${new Date(s.t).getHours().toString().padStart(2, '0')}:00 — ${s.requests} requests, ${s.logins} sign-ins, ${s.failures} failed`}</title>
            </rect>
            {i % 3 === 0 && <text x={pad + i * bw + bw / 2} y={h - 4} className="chart-axis" textAnchor="middle">{new Date(s.t).getHours().toString().padStart(2, '0')}</text>}
          </g>
        );
      })}
      <path d={line} className="chart-line" />
      {series.map((s, i) => s.failures > 0 && (
        <circle key={`f${s.t}`} cx={pad + i * bw + bw / 2} cy={h - 18 - (s.failures / maxF) * (h - 34)} r={2.6} className="chart-point" />
      ))}
    </svg>
  );
}

export function Dialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const el = ref.current;
    el?.showModal();
    return () => el?.close();
  }, []);
  return (
    <dialog ref={ref} className="dialog" onCancel={e => { e.preventDefault(); onClose(); }} aria-label={title}>
      <header className="dialog-head">
        <h2>{title}</h2>
        <button type="button" className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">✕</button>
      </header>
      {children}
    </dialog>
  );
}

